/**
 * **여러 인스턴스가 공용 계정 PG 하나를 볼 때** (계획 C — e2e).
 *
 * 지역 인스턴스 둘(A·B)과 전역 하나(G)를 띄운다. 각자 **자기 연결**로 같은 계정 PG 를 본다 — 실제 배포의 모양이다.
 * 재는 것(공통 회원정책 1차):
 *   · A 에서 로그인한 세션이 B·G 에서도 같은 사람이다(DNS 가 어느 인스턴스로 보내도)
 *   · B 에서 정지하면 **A·G 의 다음 요청**이 막힌다 — 철회가 인스턴스를 넘는다
 *   · 계정 PG 가 죽으면 세 인스턴스 모두 **503 으로 거부**한다(확인 불가 → 거부)
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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

const PG = pgFor('accounts-multi');
const ADMIN_TOKEN = 'machine-admin-token';
const sealer = new Sealer(randomBytes(32).toString('base64'));
const servers: Server[] = [];
const dbs: Db[] = [];
let A = '';
let B = '';
let G = '';

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

const regional = (): Promise<string> => listen(createApi({
  db: {} as Db, store: {} as ConfigStore, control: {} as ControlPlane,
  auth: new TokenAuth([{ name: 'ops', role: 'admin', hash: hashToken(ADMIN_TOKEN) }]),
  election: { state: { isLeader: false } } as unknown as LeaderElection,
  accounts: accountsOwnConnection(),
}));

const me = (base: string, cookie: string): Promise<Response> => fetch(`${base}/api/v1/me`, { headers: { cookie } });

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 이 스위트는 실물 PG 를 쓴다');
  startPg(PG);
  const boot = new Db(PG.dsn);
  await boot.migrate(ACCOUNT_MIGRATIONS);
  await boot.close();
  A = await regional();
  B = await regional();
  G = await listen(createApi({
    global: new RegionRelay([]),
    auth: new TokenAuth([{ name: 'ops', role: 'admin', hash: hashToken(ADMIN_TOKEN) }]),
    accounts: accountsOwnConnection(),
  }));
}, 180_000);

afterAll(async () => {
  for (const s of servers) { s.closeAllConnections?.(); s.close(); }
  for (const d of dbs) await d.close().catch(() => undefined);
  stopPg(PG);
});

async function operator(username: string): Promise<{ cookie: string; userId: string }> {
  const svc = accountsOwnConnection();
  const { token } = await svc.invite({ role: 'operator' }, 'test');
  const { userId } = await svc.acceptLink({ token, username, password: 'operator-pass-1' });
  const r = await fetch(`${A}/api/v1/session/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: A },
    body: JSON.stringify({ username, password: 'operator-pass-1' }),
  });
  expect(r.status).toBe(200);
  const cookie = r.headers.getSetCookie().find((c) => c.startsWith('bary_sid='))!.split(';', 1)[0]!;
  return { cookie, userId };
}

describe('공용 계정 PG — 인스턴스를 넘는 세션·철회', () => {
  it('**A 에서 로그인한 세션이 B·G(전역)에서도 같은 사람이다**', async () => {
    const { cookie } = await operator('roamer');
    for (const base of [A, B, G]) {
      const r = await me(base, cookie);
      expect(r.status, base).toBe(200);
      expect((await r.json() as { username: string }).username).toBe('roamer');
    }
  });

  it('**B 에서 정지하면 A·G 의 다음 요청이 막힌다**', async () => {
    const { cookie, userId } = await operator('suspended-one');
    expect((await me(A, cookie)).status).toBe(200);
    const patch = await fetch(`${B}/api/v1/users/${userId}`, {
      method: 'PATCH', headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'suspended' }),
    });
    expect(patch.status).toBe(200);
    expect((await me(A, cookie)).status).toBe(401);
    expect((await me(G, cookie)).status).toBe(401);
  });

  it('**G 에서 로그아웃하면 A·B 에서도 그 세션은 끝났다**', async () => {
    const { cookie } = await operator('leaver');
    const out = await fetch(`${G}/api/v1/session/logout`, { method: 'POST', headers: { cookie, origin: G } });
    expect(out.status).toBe(204);
    expect((await me(A, cookie)).status).toBe(401);
    expect((await me(B, cookie)).status).toBe(401);
  });

  it('**계정 PG 가 죽으면 세 인스턴스 모두 503 으로 거부한다** — 토큰은 그대로 통한다', async () => {
    const { cookie } = await operator('outage');
    execFileSync('docker', ['stop', '-t', '1', PG.name], { stdio: 'ignore' });
    for (const base of [A, B, G]) {
      const r = await me(base, cookie);
      expect(r.status, base).toBe(503);
      expect((await r.json() as { code: string }).code).toBe('account_store_unavailable');
    }
    // 로그아웃은 쿠키를 지우되 「끝났다」고 말하지 않는다(철회를 확인 못 했다)
    const out = await fetch(`${A}/api/v1/session/logout`, { method: 'POST', headers: { cookie, origin: A } });
    expect(out.status).toBe(503);
    expect(out.headers.getSetCookie().some((c) => c.startsWith('bary_sid=;') || c.startsWith('bary_sid= ;') || /^bary_sid=;?/.test(c))).toBe(true);
    // 기계 토큰은 계정 PG 와 무관하다 — 비상 경로가 산다
    const tok = await fetch(`${G}/api/v1/regions`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
    expect(tok.status).toBe(200);
  });
});
