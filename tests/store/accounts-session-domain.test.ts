/**
 * **전역과 지역이 한 로그인 세션을 함께 쓴다** (`BARY_SESSION_DOMAIN`, 2026-11-01 사용자 결정).
 *
 * 전역(`barycenter.tinyuniver.se`)에서 로그인하고 지역(`util-icn-vtr.barycenter.tinyuniver.se`)으로 가면, 전에는
 * `__Host-` 쿠키가 호스트에 묶여 다시 로그인해야 했다. 이제 그 도메인 아래로 들어온 로그인은 `Domain=` 이 붙은
 * `__Secure-bary_sid` 를 받고, 같은 계정 PG 를 보는 다른 인스턴스가 그 세션을 같은 사람으로 본다.
 *
 * 도메인 밖(IP)으로 들어오면 브라우저가 Domain 쿠키를 버리므로 지금처럼 `__Host-` 다.
 */
import { randomBytes } from 'node:crypto';
import { request, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hashToken, TokenAuth } from '../../src/api/auth.js';
import { createApi, sessionCookieFor } from '../../src/api/server.js';
import { sessionDomainFromEnv } from '../../src/bin/barycenterd.js';
import { ACCOUNT_MIGRATIONS } from '../../src/accounts/migrations.js';
import { Sealer } from '../../src/accounts/seal.js';
import { AccountService } from '../../src/accounts/service.js';
import type { ConfigStore } from '../../src/store/config-store.js';
import type { ControlPlane } from '../../src/control/plane.js';
import type { LeaderElection } from '../../src/control/leader.js';
import { Db, dockerAvailable, pgFor, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('accounts-session-domain');
const DOMAIN = 'barycenter.tinyuniver.se';
const GLOBAL = 'barycenter.tinyuniver.se';
const REGION = 'util-icn-vtr.barycenter.tinyuniver.se';
const sealer = new Sealer(randomBytes(32).toString('base64'));
const servers: Server[] = [];
const dbs: Db[] = [];
let portA = 0;
let portB = 0;

function accountsOwnConnection(): AccountService {
  const db = new Db(PG.dsn);
  dbs.push(db);
  return new AccountService({ db, sealer });
}

/** 두 인스턴스 모두 HTTPS 인 척(`sessionSecure`) 한다 — 쿠키 모양만 잰다. 각자 자기 연결로 같은 계정 PG 를 본다. */
async function instance(): Promise<number> {
  const server = createApi({
    db: {} as Db, store: {} as ConfigStore, control: {} as ControlPlane,
    auth: new TokenAuth([{ name: 'ops', role: 'admin', hash: hashToken('machine-admin-token') }]),
    election: { state: { isLeader: false } } as unknown as LeaderElection,
    accounts: accountsOwnConnection(),
    sessionSecure: true,
    sessionDomain: DOMAIN,
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

/** fetch 는 Host 를 못 바꾼다 — http.request 로 보낸다. */
function call(port: number, host: string, method: string, path: string, headers: Record<string, string> = {}, body?: string):
  Promise<{ status: number; cookies: string[] }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { host, ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, cookies: res.headers['set-cookie'] ?? [] }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function login(port: number, host: string, username: string): Promise<string[]> {
  const r = await call(port, host, 'POST', '/api/v1/session/login',
    { 'content-type': 'application/json', origin: `https://${host}` },
    JSON.stringify({ username, password: 'operator-pass-1' }));
  expect(r.status).toBe(200);
  return r.cookies;
}

const pair = (setCookie: string): string => setCookie.split(';', 1)[0]!;

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 이 스위트는 실물 PG 를 쓴다');
  startPg(PG);
  const boot = new Db(PG.dsn);
  await boot.migrate(ACCOUNT_MIGRATIONS);
  await boot.close();
  portA = await instance();
  portB = await instance();
  const svc = accountsOwnConnection();
  for (const username of ['shared-one', 'by-ip']) {
    const { token } = await svc.invite({ role: 'operator' }, 'test');
    await svc.acceptLink({ token, username, password: 'operator-pass-1' });
  }
}, 180_000);

afterAll(async () => {
  for (const s of servers) { s.closeAllConnections?.(); s.close(); }
  for (const d of dbs) await d.close().catch(() => undefined);
  stopPg(PG);
});

describe('BARY_SESSION_DOMAIN', () => {
  it('**전역에서 로그인한 세션으로 지역에 그대로 들어간다** — 도메인 쿠키다', async () => {
    const cookies = await login(portA, GLOBAL, 'shared-one');
    const shared = cookies.find((c) => c.startsWith('__Secure-bary_sid='));
    expect(shared).toBeDefined();
    expect(shared).toMatch(/; Domain=barycenter\.tinyuniver\.se;/);
    expect(shared).toMatch(/; Secure/);
    // 옛 호스트 쿠키는 지운다 — 둘이 다른 세션을 가리키지 않게.
    expect(cookies.some((c) => c.startsWith('__Host-bary_sid=;') && c.includes('Max-Age=0'))).toBe(true);

    const me = await call(portB, REGION, 'GET', '/api/v1/me', { cookie: pair(shared!) });
    expect(me.status).toBe(200);
  });

  it('지역에서 로그아웃하면 그 세션은 전역에서도 끝났다', async () => {
    const shared = pair((await login(portA, GLOBAL, 'shared-one')).find((c) => c.startsWith('__Secure-bary_sid='))!);
    const out = await call(portB, REGION, 'POST', '/api/v1/session/logout', { cookie: shared, origin: `https://${REGION}` });
    expect(out.status).toBe(204);
    expect(out.cookies.some((c) => c.startsWith('__Secure-bary_sid=;') && c.includes('Domain=barycenter.tinyuniver.se'))).toBe(true);
    expect((await call(portA, GLOBAL, 'GET', '/api/v1/me', { cookie: shared })).status).toBe(401);
  });

  it('도메인 밖(IP)으로 들어오면 지금처럼 그 호스트만 쓰는 쿠키다', async () => {
    const cookies = await login(portA, '10.253.65.250:8443', 'by-ip');
    expect(cookies.some((c) => c.startsWith('__Host-bary_sid=') && !c.includes('Domain='))).toBe(true);
    expect(cookies.some((c) => c.startsWith('__Secure-bary_sid='))).toBe(false);
  });

  it('켜기 전의 호스트 쿠키도 계속 읽는다 — 켜는 순간 로그인이 끊기지 않는다', async () => {
    const host = pair((await login(portA, '10.253.65.250:8443', 'by-ip')).find((c) => c.startsWith('__Host-bary_sid='))!);
    expect((await call(portB, REGION, 'GET', '/api/v1/me', { cookie: host })).status).toBe(200);
  });
});

describe('sessionCookieFor · sessionDomainFromEnv', () => {
  const req = (host: string): IncomingMessage => ({ headers: { host } }) as unknown as IncomingMessage;

  it('도메인 자신과 그 아래만 도메인 쿠키다 — 비슷한 이름은 아니다', () => {
    const api = { sessionSecure: true, sessionDomain: DOMAIN };
    expect(sessionCookieFor(api, req('barycenter.tinyuniver.se'))).toEqual({ name: '__Secure-bary_sid', domain: DOMAIN });
    expect(sessionCookieFor(api, req('UTIL-ICN-VTR.barycenter.tinyuniver.se:8443'))).toEqual({ name: '__Secure-bary_sid', domain: DOMAIN });
    expect(sessionCookieFor(api, req('evilbarycenter.tinyuniver.se'))).toEqual({ name: '__Host-bary_sid' });
    expect(sessionCookieFor({ sessionSecure: false, sessionDomain: DOMAIN }, req(GLOBAL))).toEqual({ name: 'bary_sid' });
  });

  it('env 를 읽는다 — 앞 점은 떼고, 너무 넓은 도메인은 거부한다', () => {
    expect(sessionDomainFromEnv({})).toEqual({});
    expect(sessionDomainFromEnv({ BARY_SESSION_DOMAIN: '.Barycenter.TinyUniver.se' })).toEqual({ sessionDomain: DOMAIN });
    expect(() => sessionDomainFromEnv({ BARY_SESSION_DOMAIN: 'tinyuniver.se' })).toThrow(/너무 넓다/);
    expect(() => sessionDomainFromEnv({ BARY_SESSION_DOMAIN: 'barycenter.tinyuniver.se:443' })).toThrow(/도메인 이름만/);
  });
});
