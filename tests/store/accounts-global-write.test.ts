/**
 * **전역에서 고친 것은 보는 사람의 세션 그대로 지역으로 간다** (2026-11-01 사용자 결정, docs/design-global-mode.md §1.1).
 *
 * 전역과 지역은 계정 PG 를 함께 쓴다. 그래서 전역에 로그인한 세션 id 가 지역에서도 같은 사람이다. 전역은 그 id 를
 * `Authorization: Session <id>` 로 넘긴다 — 브라우저가 저절로 싣는 자격이 아니므로 지역은 출처(CSRF) 검사를 걸지 않는다.
 * 쿠키로 온 쓰기에는 지금처럼 건다.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { createServer as createHttps, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hashToken, TokenAuth } from '../../src/api/auth.js';
import { createApi } from '../../src/api/server.js';
import { ACCOUNT_MIGRATIONS } from '../../src/accounts/migrations.js';
import { Sealer } from '../../src/accounts/seal.js';
import { AccountService } from '../../src/accounts/service.js';
import { RegionRelay } from '../../src/global/relay.js';
import type { ConfigStore } from '../../src/store/config-store.js';
import type { ControlPlane } from '../../src/control/plane.js';
import type { LeaderElection } from '../../src/control/leader.js';
import { Db, dockerAvailable, pgFor, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('accounts-global-write');
const sealer = new Sealer(randomBytes(32).toString('base64'));
const servers: Server[] = [];
const dbs: Db[] = [];
let dir = '';
let fake: HttpsServer;
const seen: { method: string; url: string; auth: string }[] = [];
let G = '';
let R = '';

function accountsOwnConnection(): AccountService {
  const db = new Db(PG.dsn);
  dbs.push(db);
  return new AccountService({ db, sealer });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const machine = (): TokenAuth => new TokenAuth([{ name: 'ops', role: 'admin', hash: hashToken('machine-admin-token') }]);

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 이 스위트는 실물 PG 를 쓴다');
  startPg(PG);
  const boot = new Db(PG.dsn);
  await boot.migrate(ACCOUNT_MIGRATIONS);
  await boot.close();

  dir = mkdtempSync(join(tmpdir(), 'bary-global-write-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], { stdio: 'ignore' });
  const pem = { cert: readFileSync(join(dir, 'c.pem'), 'utf8'), key: readFileSync(join(dir, 'k.pem'), 'utf8') };
  // 지역 쪽은 무엇을 받았는지만 적는 가짜다 — 지역이 Session 헤더를 받는 것은 아래 R 이 잰다.
  fake = createHttps({ cert: pem.cert, key: pem.key }, (req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization ?? '' });
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const fakeUrl = `https://127.0.0.1:${(fake.address() as AddressInfo).port}`;

  G = await listen(createApi({
    global: new RegionRelay([{ name: 'alpha', api: fakeUrl, gui: 'https://alpha.example', ca: pem.cert, token: 'region-token' }]),
    auth: machine(),
    accounts: accountsOwnConnection(),
  }));
  R = await listen(createApi({
    db: {} as Db, store: {} as ConfigStore, control: {} as ControlPlane,
    auth: machine(),
    election: { state: { isLeader: false } } as unknown as LeaderElection,
    accounts: accountsOwnConnection(),
  }));
}, 180_000);

afterAll(async () => {
  for (const s of servers) { s.closeAllConnections?.(); s.close(); }
  fake?.closeAllConnections?.();
  fake?.close();
  for (const d of dbs) await d.close().catch(() => undefined);
  stopPg(PG);
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

async function operatorAt(base: string, username: string): Promise<string> {
  const svc = accountsOwnConnection();
  const { token } = await svc.invite({ role: 'operator' }, 'test');
  await svc.acceptLink({ token, username, password: 'operator-pass-1' });
  const r = await fetch(`${base}/api/v1/session/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ username, password: 'operator-pass-1' }),
  });
  expect(r.status).toBe(200);
  return r.headers.getSetCookie().find((c) => c.startsWith('bary_sid='))!.split(';', 1)[0]!;
}

describe('전역 쓰기 중계', () => {
  it('**전역에서 쓴 것은 그 사람의 세션 그대로 지역에 간다**', async () => {
    const cookie = await operatorAt(G, 'global-writer');
    const sid = cookie.slice('bary_sid='.length);
    seen.length = 0;
    const r = await fetch(`${G}/api/v1/regions/alpha/changesets`, {
      method: 'POST', headers: { cookie, origin: G, 'content-type': 'application/json' },
      body: JSON.stringify({ base_revision: '7' }),
    });
    expect(r.status).toBe(201);
    expect(seen).toEqual([{ method: 'POST', url: '/api/v1/changesets', auth: `Session ${sid}` }]);
  });

  it('전역에서도 쿠키로 온 쓰기는 출처를 본다 — 남의 사이트가 전역을 거쳐 지역을 고치지 못한다', async () => {
    const cookie = await operatorAt(G, 'global-csrf');
    seen.length = 0;
    const r = await fetch(`${G}/api/v1/regions/alpha/changesets`, {
      method: 'POST', headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}',
    });
    expect(r.status).toBe(403);
    expect(seen).toEqual([]);
  });

  it('**지역은 헤더로 온 세션을 같은 사람으로 본다** — 쿠키가 아니므로 출처 검사를 걸지 않는다', async () => {
    const cookie = await operatorAt(R, 'region-header');
    const sid = cookie.slice('bary_sid='.length);
    const me = await fetch(`${R}/api/v1/me`, { headers: { authorization: `Session ${sid}` } });
    expect(me.status).toBe(200);
    expect((await me.json() as { username: string }).username).toBe('region-header');

    // 같은 POST 를 쿠키로, Origin 없이 보내면 출처 검사에 걸린다. 헤더로 보내면 지난다.
    const byCookie = await fetch(`${R}/api/v1/session/logout-all`, { method: 'POST', headers: { cookie } });
    expect(byCookie.status).toBe(403);
    const byHeader = await fetch(`${R}/api/v1/session/logout-all`, { method: 'POST', headers: { authorization: `Session ${sid}` } });
    expect(byHeader.status).toBe(200);
    // 그 세션은 이제 어디서도 안 통한다.
    expect((await fetch(`${R}/api/v1/me`, { headers: { authorization: `Session ${sid}` } })).status).toBe(401);
  });

  it('모르는 세션 id 는 401 이다', async () => {
    expect((await fetch(`${R}/api/v1/me`, { headers: { authorization: 'Session nope' } })).status).toBe(401);
  });
});
