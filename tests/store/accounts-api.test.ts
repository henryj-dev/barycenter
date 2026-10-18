/**
 * 사람 계정 — 실제 HTTP 서버 + 실물 계정 PG (공통 회원정책 1차 · 계획 A 단계).
 *
 * 서비스 단위 흐름은 `accounts-service.test.ts` 가 잰다. 여기서는 **문**을 잰다: 쿠키·출처 검사·
 * 열거 방지 응답·다음 요청 반영·계정 PG 장애 → 503·리더가 아니어도 계정 쓰기·사람 ≠ 토큰.
 */
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hashToken, TokenAuth } from '../../src/api/auth.js';
import { createApi } from '../../src/api/server.js';
import { ACCOUNT_MIGRATIONS } from '../../src/accounts/migrations.js';
import { Sealer } from '../../src/accounts/seal.js';
import { AccountService } from '../../src/accounts/service.js';
import { hotp, stepOf } from '../../src/accounts/totp.js';
import type { ConfigStore } from '../../src/store/config-store.js';
import type { ControlPlane } from '../../src/control/plane.js';
import type { LeaderElection } from '../../src/control/leader.js';
import { Db, dockerAvailable, pgFor, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('accounts-api');
const TOKEN = 'machine-token-plain';
let db: Db;
let server: Server | undefined;
let base = '';
let accounts: AccountService;
const sealer = new Sealer(randomBytes(32).toString('base64'));

function codeFor(b32: string, at = Date.now()): string {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0; let v = 0; const out: number[] = [];
  for (const ch of b32) { v = (v << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } }
  return hotp(Buffer.from(out), stepOf(at));
}

async function serve(svc: AccountService, leader = false): Promise<void> {
  server = createApi({
    db: {} as Db,
    store: { head: async () => ({ revision: '1', etag: 'e1' }) } as unknown as ConfigStore,
    control: {} as ControlPlane,
    auth: new TokenAuth([{ name: 'ci', role: 'admin', hash: hashToken(TOKEN) }]),
    // **리더가 아니다** — 계정 쓰기는 지역 리더십과 무관해야 한다.
    election: { state: { isLeader: leader, reason: '스탠바이' } } as unknown as LeaderElection,
    accounts: svc,
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers }, body: JSON.stringify(body) });
const cookieOf = (r: Response, name: string): string =>
  (r.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? '').split(';', 1)[0]!;

async function operator(username = 'op'): Promise<{ cookie: string; userId: string }> {
  const { token } = await accounts.invite({ role: 'operator' }, 'test');
  const { userId } = await accounts.acceptLink({ token, username, password: 'operator-pass-1' });
  const r = await post('/api/v1/session/login', { username, password: 'operator-pass-1' });
  expect(r.status).toBe(200);
  return { cookie: cookieOf(r, 'bary_sid'), userId };
}

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 이 스위트는 실물 PG 를 쓴다');
  startPg(PG);
  db = new Db(PG.dsn);
}, 180_000);

afterAll(async () => { await db?.close(); stopPg(PG); });

beforeEach(async () => {
  // 테이블을 나열하지 않는다 — 마이그레이션이 늘 때마다 빠진 이름이 다음 스위트를 깨뜨린다.
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await db.migrate(ACCOUNT_MIGRATIONS);
  accounts = new AccountService({ db, sealer });
  await serve(accounts);
});

afterEach(async () => {
  server?.closeAllConnections?.();
  if (server !== undefined) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

describe('로그인 문', () => {
  it('**없는 계정과 틀린 비밀번호가 같은 401·같은 본문이다**', async () => {
    await operator();
    const a = await post('/api/v1/session/login', { username: 'ghost', password: 'whatever-pass1' });
    const b = await post('/api/v1/session/login', { username: 'op', password: 'wrong-password1' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(await a.text()).toBe(await b.text());
  });

  it('다른 출처에서 온 로그인은 403 (로그인 CSRF)', async () => {
    const r = await post('/api/v1/session/login', { username: 'op', password: 'x' }, { origin: 'https://evil.example.com' });
    expect(r.status).toBe(403);
  });

  it('세션 쿠키는 HttpOnly·SameSite=Lax 이고 `/me` 가 그 사람을 말한다', async () => {
    const { token } = await accounts.invite({ role: 'operator' }, 'test');
    await accounts.acceptLink({ token, username: 'op', password: 'operator-pass-1' });
    const r = await post('/api/v1/session/login', { username: 'op', password: 'operator-pass-1' });
    const raw = r.headers.getSetCookie().find((c) => c.startsWith('bary_sid='))!;
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('SameSite=Lax');
    const me = await fetch(`${base}/api/v1/me`, { headers: { cookie: cookieOf(r, 'bary_sid') } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ username: 'op', role: 'operator', mfa: { totp: false } });
  });

  it('**관리자는 MFA 쿠키를 지나야 세션 쿠키를 받는다**', async () => {
    const t = await accounts.bootstrap('cli');
    const p = await accounts.previewLink(t);
    await accounts.acceptLink({ token: t, username: 'root', password: 'admin-password-1', totp: { secret: p.totp!.secret, code: codeFor(p.totp!.secret) } });
    const a = await post('/api/v1/session/login', { username: 'root', password: 'admin-password-1' });
    expect(await a.json()).toEqual({ status: 'mfa_required' });
    expect(cookieOf(a, 'bary_sid')).toBe('');
    const mfa = a.headers.getSetCookie().find((c) => c.startsWith('bary_mfa='))!;
    expect(mfa).toContain('Path=/api/v1/session/mfa');
    const b = await post('/api/v1/session/mfa', { code: codeFor(p.totp!.secret, Date.now() + 30_000) }, { cookie: cookieOf(a, 'bary_mfa') });
    expect(b.status).toBe(200);
    const users = await fetch(`${base}/api/v1/users`, { headers: { cookie: cookieOf(b, 'bary_sid') } });
    expect(users.status).toBe(200);
  });
});

describe('철회는 다음 보호된 요청부터', () => {
  it('**로그아웃 뒤 같은 쿠키는 401** — 쿠키를 지운 것만이 아니다', async () => {
    const { cookie } = await operator();
    expect((await fetch(`${base}/api/v1/me`, { headers: { cookie } })).status).toBe(200);
    expect((await post('/api/v1/session/logout', {}, { cookie })).status).toBe(204);
    expect((await fetch(`${base}/api/v1/me`, { headers: { cookie } })).status).toBe(401);
  });

  it('**정지는 바로 다음 요청을 막는다**', async () => {
    const { cookie, userId } = await operator();
    const patch = await fetch(`${base}/api/v1/users/${userId}`, {
      method: 'PATCH', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'suspended' }),
    });
    expect(patch.status).toBe(200);
    expect((await fetch(`${base}/api/v1/me`, { headers: { cookie } })).status).toBe(401);
  });

  it('**계정 PG 를 못 물으면 503 으로 거부한다** — 「없다」(401)가 아니다', async () => {
    const { cookie } = await operator();
    server?.closeAllConnections?.();
    await new Promise<void>((r) => server!.close(() => r()));
    await serve(new AccountService({ db: new Db('postgres://postgres:bary@127.0.0.1:1/none'), sealer }));
    const r = await fetch(`${base}/api/v1/me`, { headers: { cookie } });
    expect(r.status).toBe(503);
    expect((await r.json() as { code: string }).code).toBe('account_store_unavailable');
  });
});

describe('경계', () => {
  it('**리더가 아니어도 계정 쓰기는 된다** (비밀번호 변경)', async () => {
    const { cookie } = await operator();
    const r = await post('/api/v1/me/password', { current: 'operator-pass-1', next: 'operator-pass-2' }, { cookie });
    expect(r.status).toBe(200);
  });

  it('쿠키로 온 관리 쓰기도 다른 출처면 403', async () => {
    const { cookie, userId } = await operator();
    const r = await fetch(`${base}/api/v1/users/${userId}`, {
      method: 'PATCH', headers: { cookie, origin: 'https://evil.example.com', 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'admin' }),
    });
    expect(r.status).toBe(403);
  });

  it('**토큰은 사람이 아니다** — `/me` 는 404 not_a_person', async () => {
    const r = await fetch(`${base}/api/v1/me`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(r.status).toBe(404);
    expect((await r.json() as { code: string }).code).toBe('not_a_person');
  });

  it('operator 사람은 관리 경로에 403', async () => {
    const { cookie } = await operator();
    expect((await fetch(`${base}/api/v1/users`, { headers: { cookie } })).status).toBe(403);
  });

  it('공개 가입은 없다 — 초대는 admin 만 만든다', async () => {
    const { cookie } = await operator();
    expect((await post('/api/v1/invitations', { role: 'auditor' }, { cookie })).status).toBe(403);
    expect((await post('/api/v1/invitations/accept', { token: 'guess', username: 'x', password: 'whatever-pass1' })).status).toBe(404);
  });
});
