/**
 * 둘째 인증 어댑터 — IdP(lodestar) OTP. 실제 HTTP 서버 + 실물 계정 PG + 가짜 IdP(OIDC 와 `/api/totp/verify`).
 *
 * 재는 것:
 *   · SSO 연결 + IdP OTP 켬 → 관리자 로그인이 **IdP 코드로** 끝난다(로컬 TOTP 코드는 받지 않는다)
 *   · 로컬 TOTP 가 없는 관리자도 IdP OTP 로 들어온다(승격도 IdP OTP 연결을 MFA 로 인정)
 *   · IdP 에 못 물으면 **막힌다** — 로컬 TOTP 로 새지 않는다, 잠금 계수에 세지 않는다
 *   · 연결이 없는 사람은 로컬 그대로(IdP 에 묻지 않는다)
 *   · step-up 도 같은 문이다 · 복구 코드는 언제나 로컬 · 감사에 수단이 남는다
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { TokenAuth } from '../../src/api/auth.js';
import { createApi } from '../../src/api/server.js';
import { lodestarOtp } from '../../src/accounts/mfa/lodestar.js';
import { ACCOUNT_MIGRATIONS } from '../../src/accounts/migrations.js';
import { Sealer } from '../../src/accounts/seal.js';
import { AccountService } from '../../src/accounts/service.js';
import { hotp, stepOf } from '../../src/accounts/totp.js';
import type { ConfigStore } from '../../src/store/config-store.js';
import type { ControlPlane } from '../../src/control/plane.js';
import type { LeaderElection } from '../../src/control/leader.js';
import { Db, dockerAvailable, pgFor, startPg, stopPg, freshSchema } from './pg-fixture.js';

const PG = pgFor('accounts-mfa-idp');
const ISS = 'https://idp.test';
const SECRET = 'idp-hs256-secret';
/** 가짜 서비스 토큰 — 실물 값이 아니다. */
const SERVICE_TOKEN = 'fake-service-token';
/** 가짜 IdP 가 맞다고 하는 코드. */
const IDP_CODE = '424242';
let db: Db;
let accounts: AccountService;
let base = '';
const servers: Server[] = [];
const sealer = new Sealer(randomBytes(32).toString('base64'));
let who: Record<string, unknown> = {};
let lastNonce = '';

/** 가짜 IdP 의 `/api/totp/verify`. 기본은 정상 — `IDP_CODE` 만 맞다. */
type IdpMode = 'ok' | 'down' | 'bad-token' | 'inactive' | 'not-enrolled' | 'rate-limited';
let idpMode: IdpMode = 'ok';
let idpCalls: { userId: string; code: string; auth: string }[] = [];
const idpFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body)) as { userId: string; code: string };
  idpCalls.push({ ...body, auth: (init?.headers as Record<string, string>)['authorization'] ?? '' });
  switch (idpMode) {
    case 'down': throw new TypeError('fetch failed');
    case 'bad-token': return new Response(null, { status: 401 });
    case 'inactive': return new Response('{"ok":false}', { status: 403 });
    case 'not-enrolled': return new Response('{"ok":false}', { status: 404 });
    case 'rate-limited': return new Response('{"ok":false}', { status: 429 });
    case 'ok': return body.code === IDP_CODE ? new Response('{"ok":true}', { status: 200 }) : new Response('{"ok":false}', { status: 401 });
  }
}) as typeof fetch;

const b64 = (b: Buffer): string => b.toString('base64url');
function idToken(claims: Record<string, unknown>): string {
  const h = b64(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const p = b64(Buffer.from(JSON.stringify({ iss: ISS, aud: 'bary', exp: 2_000_000_000, nonce: lastNonce, ...claims })));
  return `${h}.${p}.${b64(createHmac('sha256', SECRET).update(`${h}.${p}`).digest())}`;
}

async function serve(svc: AccountService): Promise<void> {
  const server = createApi({
    db: {} as Db, store: { head: async () => ({ revision: '1', etag: 'e1' }) } as unknown as ConfigStore, control: {} as ControlPlane,
    auth: new TokenAuth([], { issuer: ISS, audience: 'bary', key: SECRET }),
    election: { state: { isLeader: false } } as unknown as LeaderElection,
    accounts: svc,
    oidcRp: {
      issuer: ISS, audience: 'bary', key: SECRET,
      authorizationEndpoint: `${ISS}/authorize`, tokenEndpoint: `${ISS}/token`, clientId: 'bary', redirectUri: 'https://bary.test/login',
    },
    oidcFetch: async () => new Response(JSON.stringify({ id_token: idToken(who) }), { status: 200 }),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const post = (path: string, body: unknown, cookie = ''): Promise<Response> =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, cookie }, body: JSON.stringify(body) });
const cookieOf = (r: Response, name: string): string =>
  (r.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? '').split(';', 1)[0]!;

function codeFor(b32: string, at = Date.now()): string {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0; let v = 0; const out: number[] = [];
  for (const ch of b32) { v = (v << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } }
  return hotp(Buffer.from(out), stepOf(at));
}

/** 로컬 TOTP 가 있는 첫 관리자. */
async function rootAdmin(): Promise<{ userId: string; secret: string; recoveryCodes: string[] }> {
  const t = await accounts.bootstrap('cli');
  const p = await accounts.previewLink(t);
  const r = await accounts.acceptLink({ token: t, username: 'root', password: 'admin-password-1', totp: { secret: p.totp!.secret, code: codeFor(p.totp!.secret) } });
  return { userId: r.userId, secret: p.totp!.secret, recoveryCodes: r.recoveryCodes! };
}
const link = (userId: string, sub: string): Promise<unknown> =>
  db.query(`INSERT INTO user_identities (issuer, subject, user_id, linked_by) VALUES ($1,$2,$3,'test')`, [ISS, sub, userId]);

/** 비밀번호 단계 → MFA 단계. 둘째 응답을 돌려준다. */
async function loginWith(username: string, password: string, code: string): Promise<{ first: unknown; second: Response }> {
  const a = await post('/api/v1/session/login', { username, password });
  expect(a.status).toBe(200);
  const first = await a.json();
  return { first, second: await post('/api/v1/session/mfa', { code }, cookieOf(a, 'bary_mfa')) };
}
const lastAuditDetail = async (action: string): Promise<unknown> =>
  (await db.query(`SELECT detail FROM account_audit WHERE action=$1 ORDER BY at DESC, id DESC LIMIT 1`, [action])).rows[0]?.['detail'];

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 이 스위트는 실물 PG 를 쓴다');
  startPg(PG);
  db = new Db(PG.dsn);
}, 180_000);
afterAll(async () => { await db?.close(); stopPg(PG); });
beforeEach(async () => {
  await freshSchema(db);
  await db.migrate(ACCOUNT_MIGRATIONS);
  idpMode = 'ok';
  idpCalls = [];
  accounts = new AccountService({
    db, sealer,
    idpMfa: { issuer: ISS, provider: lodestarOtp({ baseUrl: ISS, serviceToken: SERVICE_TOKEN, fetch: idpFetch }) },
  });
  await serve(accounts);
});
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

describe('IdP OTP — 로그인', () => {
  it('**SSO 연결 + IdP OTP 켬 → 관리자 로그인이 IdP 코드로 끝난다** (로컬 TOTP 코드는 받지 않는다)', async () => {
    const root = await rootAdmin();
    await link(root.userId, 'kst-root');
    who = { sub: 'kst-root' };
    const s = await fetch(`${base}/api/v1/oidc/authorization-request`);
    const sb = await s.json() as { url: string; state: string };
    lastNonce = new URL(sb.url).searchParams.get('nonce')!;
    const r = await post('/api/v1/oidc/token', { code: 'c', state: sb.state }, cookieOf(s, 'bary_sso'));
    expect(await r.json()).toEqual({ status: 'mfa_required', method: 'idp', idp: 'idp.test' });
    // 로컬 인증 앱 코드 → IdP 에 그대로 물었고 IdP 가 틀렸다고 했다 → 거절
    const local = await post('/api/v1/session/mfa', { code: codeFor(root.secret, Date.now() + 30_000) }, cookieOf(r, 'bary_mfa'));
    expect(local.status).toBe(401);
    const ok = await post('/api/v1/session/mfa', { code: IDP_CODE }, cookieOf(r, 'bary_mfa'));
    expect(ok.status).toBe(200);
    expect(idpCalls.map((c) => c.userId)).toEqual(['kst-root', 'kst-root']);
    expect(idpCalls[1]).toMatchObject({ code: IDP_CODE, auth: `Bearer ${SERVICE_TOKEN}` });
    const users = await fetch(`${base}/api/v1/users`, { headers: { cookie: cookieOf(ok, 'bary_sid') } });
    expect(users.status).toBe(200);
    expect(await lastAuditDetail('session.login')).toEqual({ mfa: 'idp_otp' });
    // 감사 · 로그에 서비스 토큰이 남지 않는다
    const audit = JSON.stringify((await db.query(`SELECT detail FROM account_audit`)).rows);
    expect(audit).not.toContain(SERVICE_TOKEN);
  });

  it('**로컬 TOTP 가 없는 관리자도 들어온다** — 승격이 IdP OTP 연결을 MFA 로 인정한다', async () => {
    await rootAdmin();
    const { token } = await accounts.invite({ role: 'operator' }, 'test');
    const { userId } = await accounts.acceptLink({ token, username: 'kim', password: 'operator-pass-1' });
    // 연결 전에는 승격이 막힌다(지금과 같다)
    await expect(accounts.updateUser(userId, { role: 'admin' }, 'test')).rejects.toMatchObject({ code: 'admin_needs_mfa' });
    await link(userId, 'kst-kim');
    await accounts.updateUser(userId, { role: 'admin' }, 'test');
    const { first, second } = await loginWith('kim', 'operator-pass-1', IDP_CODE);
    expect(first).toEqual({ status: 'mfa_required', method: 'idp', idp: 'idp.test' });
    expect(second.status).toBe(200);
    const me = await (await fetch(`${base}/api/v1/me`, { headers: { cookie: cookieOf(second, 'bary_sid') } })).json() as { role: string; mfa: unknown };
    expect(me.role).toBe('admin');
    expect(me.mfa).toEqual({ totp: false, recoveryCodesLeft: 0, method: 'idp', idp: 'idp.test' });
    // 관리자의 유일한 둘째 인증이면 연결을 끊을 수 없다
    await expect(accounts.unlinkIdentity(userId, ISS, 'kst-kim', 'operator-pass-1')).rejects.toMatchObject({ code: 'admin_needs_mfa' });
  });

  it('**IdP 에 못 물으면 막힌다** — 503, 로컬 TOTP 로 새지 않고, 잠금 계수에 세지 않는다', async () => {
    const root = await rootAdmin();
    await link(root.userId, 'kst-root');
    idpMode = 'down';
    const a = await post('/api/v1/session/login', { username: 'root', password: 'admin-password-1' });
    const mfa = cookieOf(a, 'bary_mfa');
    for (const code of [IDP_CODE, codeFor(root.secret, Date.now() + 30_000)]) {
      const r = await post('/api/v1/session/mfa', { code }, mfa);
      expect(r.status).toBe(503);
      expect(await r.json()).toMatchObject({ code: 'mfa_idp_unavailable', message: expect.stringContaining('IdP 에 물을 수 없어요') });
      expect(cookieOf(r, 'bary_sid')).toBe('');
    }
    expect(Number((await db.query(`SELECT failed_logins FROM users WHERE id=$1`, [root.userId])).rows[0]!['failed_logins'])).toBe(0);
    // 서비스 토큰 거절도 같은 닫힘이다
    idpMode = 'bad-token';
    expect((await post('/api/v1/session/mfa', { code: IDP_CODE }, mfa)).status).toBe(503);
    // 다른 실패는 사람 말로
    for (const [mode, status, code] of [['rate-limited', 429, 'mfa_idp_rate_limited'], ['inactive', 403, 'mfa_idp_inactive'], ['not-enrolled', 404, 'mfa_idp_not_enrolled']] as const) {
      idpMode = mode;
      const r = await post('/api/v1/session/mfa', { code: IDP_CODE }, mfa);
      expect(r.status).toBe(status);
      expect(await r.json()).toMatchObject({ code });
    }
    // IdP 가 돌아오면 같은 MFA 단계로 끝난다
    idpMode = 'ok';
    expect((await post('/api/v1/session/mfa', { code: IDP_CODE }, mfa)).status).toBe(200);
  });

  it('**틀린 IdP 코드는 지금처럼 401 이고 계정 잠금에 센다**', async () => {
    const root = await rootAdmin();
    await link(root.userId, 'kst-root');
    const { second } = await loginWith('root', 'admin-password-1', '000000');
    expect(second.status).toBe(401);
    expect(Number((await db.query(`SELECT failed_logins FROM users WHERE id=$1`, [root.userId])).rows[0]!['failed_logins'])).toBe(1);
  });

  it('**복구 코드는 언제나 로컬** — IdP 가 죽어도 쓰고, IdP 에 보내지 않는다', async () => {
    const root = await rootAdmin();
    await link(root.userId, 'kst-root');
    idpMode = 'down';
    const { second } = await loginWith('root', 'admin-password-1', root.recoveryCodes[0]!);
    expect(second.status).toBe(200);
    expect(idpCalls).toHaveLength(0);
    expect(await lastAuditDetail('session.login')).toEqual({ mfa: 'recovery' });
  });

  it('**연결이 없는 사람은 로컬 그대로** — IdP 에 묻지 않는다', async () => {
    const root = await rootAdmin();
    // 다른 issuer 와의 연결은 IdP OTP 대상이 아니다
    await db.query(`INSERT INTO user_identities (issuer, subject, user_id, linked_by) VALUES ('https://other.test','x',$1,'test')`, [root.userId]);
    idpMode = 'down';
    const { first, second } = await loginWith('root', 'admin-password-1', codeFor(root.secret, Date.now() + 30_000));
    expect(first).toEqual({ status: 'mfa_required' });
    expect(second.status).toBe(200);
    expect(idpCalls).toHaveLength(0);
    expect(await lastAuditDetail('session.login')).toEqual({ mfa: 'totp' });
    // 인증 앱도 연결도 없는 operator 는 지금처럼 MFA 단계 없이 들어온다
    const { token } = await accounts.invite({ role: 'operator' }, 'test');
    await accounts.acceptLink({ token, username: 'op', password: 'operator-pass-1' });
    const op = await post('/api/v1/session/login', { username: 'op', password: 'operator-pass-1' });
    expect(await op.json()).toEqual({ status: 'ok' });
  });
});

describe('IdP OTP — step-up', () => {
  async function stepUpSession(): Promise<{ userId: string; cookie: string }> {
    await rootAdmin();
    const { token } = await accounts.invite({ role: 'operator' }, 'test');
    const { userId } = await accounts.acceptLink({ token, username: 'kim', password: 'operator-pass-1' });
    await link(userId, 'kst-kim');
    const { second } = await loginWith('kim', 'operator-pass-1', IDP_CODE);
    expect(second.status).toBe(200);
    return { userId, cookie: cookieOf(second, 'bary_sid') };
  }

  it('**step-up 도 같은 문** — 로컬 인증 앱이 없어도 IdP 코드로 지난다, 감사에 수단이 남는다', async () => {
    const { userId, cookie } = await stepUpSession();
    expect((await post('/api/v1/session/step-up', { code: '111111' }, cookie)).status).toBe(403);
    const r = await post('/api/v1/session/step-up', { code: IDP_CODE }, cookie);
    expect(r.status).toBe(200);
    expect(await lastAuditDetail('session.step_up')).toEqual({ method: 'idp_otp' });
    const methods = (await db.query(`SELECT auth_methods FROM sessions WHERE user_id=$1 AND revoked_at IS NULL AND NOT mfa_pending`, [userId])).rows[0]!['auth_methods'];
    expect(methods).toEqual(['pwd', 'idp_otp', 'step-up:idp_otp']);
  });

  it('**IdP 에 못 물으면 step-up 도 막힌다** (503 · 잠금에 세지 않음)', async () => {
    const { userId, cookie } = await stepUpSession();
    idpMode = 'down';
    const r = await post('/api/v1/session/step-up', { code: IDP_CODE }, cookie);
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ code: 'mfa_idp_unavailable' });
    expect(Number((await db.query(`SELECT failed_logins FROM users WHERE id=$1`, [userId])).rows[0]!['failed_logins'])).toBe(0);
  });

  it('연결도 인증 앱도 없으면 지금처럼 409 no_totp · 연결 없는 관리자는 로컬 TOTP 로', async () => {
    const root = await rootAdmin();
    const { token } = await accounts.invite({ role: 'operator' }, 'test');
    const { userId } = await accounts.acceptLink({ token, username: 'op', password: 'operator-pass-1' });
    await expect(accounts.stepUp('x', userId, IDP_CODE)).rejects.toMatchObject({ code: 'no_totp' });
    const { second } = await loginWith('root', 'admin-password-1', root.recoveryCodes[0]!);
    expect(second.status).toBe(200);
    const r = await post('/api/v1/session/step-up', { code: codeFor(root.secret, Date.now() + 30_000) }, cookieOf(second, 'bary_sid'));
    expect(r.status).toBe(200);
    expect(await lastAuditDetail('session.step_up')).toEqual({ method: 'totp' });
    expect(idpCalls).toHaveLength(0);
  });
});
