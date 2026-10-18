/**
 * 계정 B2 — SSO 연결 (로컬 권한 정본). 실제 HTTP 서버 + 실물 계정 PG + 가짜 IdP.
 *
 * 재는 것(공통 회원정책 1차):
 *   · 연결이 없으면 **거절**(JIT 기본 꺼짐). 공급자에 JIT 를 켜야 auditor 로만 새로 만든다
 *   · **이름·이메일이 같아도 기존 계정에 붙이지 않는다**
 *   · 연결은 비밀번호 재확인 뒤, 다른 사람에게 묶인 identity 는 거절
 *   · IdP 의 역할·MFA 는 안 믿는다 — 관리자는 SSO 로 와도 로컬 TOTP 단계
 *   · 흐름 상태가 계정 PG 에 있어 **A 에서 시작해 B 로 콜백**해도 된다
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { TokenAuth } from '../../src/api/auth.js';
import { createApi } from '../../src/api/server.js';
import { ACCOUNT_MIGRATIONS } from '../../src/accounts/migrations.js';
import { Sealer } from '../../src/accounts/seal.js';
import { AccountService } from '../../src/accounts/service.js';
import { hotp, stepOf } from '../../src/accounts/totp.js';
import type { ConfigStore } from '../../src/store/config-store.js';
import type { ControlPlane } from '../../src/control/plane.js';
import type { LeaderElection } from '../../src/control/leader.js';
import { Db, dockerAvailable, pgFor, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('accounts-sso');
const ISS = 'https://idp.test';
const SECRET = 'idp-hs256-secret';
let db: Db;
let accounts: AccountService;
const servers: Server[] = [];
const sealer = new Sealer(randomBytes(32).toString('base64'));
/** 가짜 IdP 가 다음에 서명할 사람. */
let who: Record<string, unknown> = {};
let lastNonce = '';

const b64 = (b: Buffer): string => b.toString('base64url');
function idToken(claims: Record<string, unknown>): string {
  const h = b64(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const p = b64(Buffer.from(JSON.stringify({ iss: ISS, aud: 'bary', exp: 2_000_000_000, nonce: lastNonce, ...claims })));
  return `${h}.${p}.${b64(createHmac('sha256', SECRET).update(`${h}.${p}`).digest())}`;
}

async function serve(): Promise<string> {
  const server = createApi({
    db: {} as Db, store: {} as ConfigStore, control: {} as ControlPlane,
    auth: new TokenAuth([], { issuer: ISS, audience: 'bary', key: SECRET }),
    election: { state: { isLeader: false } } as unknown as LeaderElection,
    accounts,
    oidcRp: {
      issuer: ISS, audience: 'bary', key: SECRET,
      authorizationEndpoint: `${ISS}/authorize`, tokenEndpoint: `${ISS}/token`, clientId: 'bary', redirectUri: 'https://bary.test/login',
    },
    oidcFetch: async () => new Response(JSON.stringify({ id_token: idToken(who) }), { status: 200 }),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const cookie = (r: Response, name: string): string =>
  (r.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? '').split(';', 1)[0]!;

/** IdP 왕복 한 번: 시작(start 서버) → 콜백(finish 서버). 시작 응답의 nonce 를 IdP 가 그대로 돌려준다. */
async function sso(start: string, finish = start, startWith?: { path: string; body: unknown; cookie: string }): Promise<Response> {
  const s = startWith === undefined
    ? await fetch(`${start}/api/v1/oidc/authorization-request`)
    : await fetch(`${start}${startWith.path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: start, cookie: startWith.cookie }, body: JSON.stringify(startWith.body),
    });
  const body = await s.json() as { url: string; state: string };
  lastNonce = new URL(body.url).searchParams.get('nonce')!;
  return fetch(`${finish}/api/v1/oidc/token`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: finish, cookie: cookie(s, 'bary_sso') },
    body: JSON.stringify({ code: 'c', state: body.state }),
  });
}

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 이 스위트는 실물 PG 를 쓴다');
  startPg(PG);
  db = new Db(PG.dsn);
}, 180_000);
afterAll(async () => { await db?.close(); stopPg(PG); });
beforeEach(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await db.migrate(ACCOUNT_MIGRATIONS);
  accounts = new AccountService({ db, sealer });
});
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

describe('SSO 로그인 (로컬 권한 정본)', () => {
  it('**연결이 없으면 403 sso_not_linked**, 계정을 만들지 않는다 (JIT 기본 꺼짐)', async () => {
    const base = await serve();
    who = { sub: 'u-1', preferred_username: 'alice', role: 'admin' };
    const r = await sso(base);
    expect(r.status).toBe(403);
    expect((await r.json() as { code: string }).code).toBe('sso_not_linked');
    expect((await db.query('SELECT count(*) AS n FROM users')).rows[0]!['n']).toBe('0');
  });

  it('**JIT 를 켜면 auditor 로만** 만들고, IdP 의 역할 클레임은 무시한다', async () => {
    const base = await serve();
    await accounts.setProviderJit(ISS, true, 'test');
    who = { sub: 'u-2', preferred_username: 'Bob', role: 'admin' };
    const r = await sso(base);
    expect(r.status).toBe(200);
    const me = await (await fetch(`${base}/api/v1/me`, { headers: { cookie: cookie(r, 'bary_sid') } })).json() as { username: string; role: string };
    expect(me).toMatchObject({ username: 'bob', role: 'auditor' });
    // 같은 identity 로 다시 오면 같은 사람이다
    const again = await sso(base);
    const me2 = await (await fetch(`${base}/api/v1/me`, { headers: { cookie: cookie(again, 'bary_sid') } })).json() as { id: string };
    expect(me2.id).toBe((me as unknown as { id: string }).id);
  });

  it('**이름이 같은 기존 계정에 붙이지 않는다** — 새 계정을 다른 이름으로 만든다', async () => {
    const base = await serve();
    const { token } = await accounts.invite({ role: 'operator' }, 't');
    const { userId } = await accounts.acceptLink({ token, username: 'carol', password: 'operator-pass-1' });
    await accounts.setProviderJit(ISS, true, 'test');
    who = { sub: 'u-3', preferred_username: 'carol' };
    const r = await sso(base);
    const me = await (await fetch(`${base}/api/v1/me`, { headers: { cookie: cookie(r, 'bary_sid') } })).json() as { id: string; username: string };
    expect(me.id).not.toBe(userId);
    expect(me.username).toMatch(/^carol-[0-9a-f]{4}$/);
  });

  it('**흐름 상태가 계정 PG 에 있다** — A 에서 시작해 B 로 콜백해도 로그인된다', async () => {
    const a = await serve();
    const b = await serve();
    await accounts.setProviderJit(ISS, true, 'test');
    who = { sub: 'u-4', preferred_username: 'dave' };
    expect((await sso(a, b)).status).toBe(200);
  });
});

describe('연결 · 해제', () => {
  async function operator(base: string): Promise<{ userId: string; sid: string }> {
    const { token } = await accounts.invite({ role: 'operator' }, 't');
    const { userId } = await accounts.acceptLink({ token, username: 'erin', password: 'operator-pass-1' });
    const r = await fetch(`${base}/api/v1/session/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ username: 'erin', password: 'operator-pass-1' }),
    });
    return { userId, sid: cookie(r, 'bary_sid') };
  }

  it('**비밀번호를 다시 넣어야** 연결이 열리고, 연결 뒤에는 SSO 로 그 사람이 된다', async () => {
    const base = await serve();
    const { sid } = await operator(base);
    const bad = await fetch(`${base}/api/v1/me/identities/link`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base, cookie: sid }, body: JSON.stringify({ password: 'wrong-password-1' }),
    });
    expect(bad.status).toBe(403);
    who = { sub: 'u-5' };
    const linked = await sso(base, base, { path: '/api/v1/me/identities/link', body: { password: 'operator-pass-1' }, cookie: sid });
    expect(await linked.json()).toEqual({ status: 'linked' });
    const viaSso = await sso(base);
    const me = await (await fetch(`${base}/api/v1/me`, { headers: { cookie: cookie(viaSso, 'bary_sid') } })).json() as { username: string; identities: unknown[] };
    expect(me.username).toBe('erin');
    expect(me.identities).toHaveLength(1);
  });

  it('다른 사람에게 묶인 identity 는 409', async () => {
    const base = await serve();
    await accounts.setProviderJit(ISS, true, 'test');
    who = { sub: 'shared' };
    await sso(base); // JIT 계정이 먼저 가져갔다
    const { sid } = await operator(base);
    const r = await sso(base, base, { path: '/api/v1/me/identities/link', body: { password: 'operator-pass-1' }, cookie: sid });
    expect(r.status).toBe(409);
  });

  it('해제는 비밀번호를 다시 묻고, 삭제된 계정의 연결은 사라진다', async () => {
    const base = await serve();
    const { userId, sid } = await operator(base);
    who = { sub: 'u-6' };
    await sso(base, base, { path: '/api/v1/me/identities/link', body: { password: 'operator-pass-1' }, cookie: sid });
    await expect(accounts.unlinkIdentity(userId, ISS, 'u-6', 'wrong-password-1')).rejects.toMatchObject({ code: 'reauth_failed' });
    const t = await accounts.bootstrap('cli');
    const p = await accounts.previewLink(t);
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0; let v = 0; const key: number[] = [];
    for (const ch of p.totp!.secret) { v = (v << 5) | A.indexOf(ch); bits += 5; if (bits >= 8) { key.push((v >>> (bits - 8)) & 255); bits -= 8; } }
    await accounts.acceptLink({ token: t, username: 'root', password: 'admin-password-1', totp: { secret: p.totp!.secret, code: hotp(Buffer.from(key), stepOf(Date.now())) } });
    await accounts.deleteUser(userId, 'user:root');
    expect((await sso(base)).status).toBe(403);
  });
});

describe('관리자는 SSO 로 와도 로컬 TOTP', () => {
  it('**IdP 가 MFA 를 했다고 해도 mfa_required** — IdP MFA 는 인정하지 않는다', async () => {
    const base = await serve();
    const t = await accounts.bootstrap('cli');
    const p = await accounts.previewLink(t);
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0; let v = 0; const key: number[] = [];
    for (const ch of p.totp!.secret) { v = (v << 5) | A.indexOf(ch); bits += 5; if (bits >= 8) { key.push((v >>> (bits - 8)) & 255); bits -= 8; } }
    const { userId } = await accounts.acceptLink({ token: t, username: 'root', password: 'admin-password-1', totp: { secret: p.totp!.secret, code: hotp(Buffer.from(key), stepOf(Date.now())) } });
    await db.query(`INSERT INTO user_identities (issuer, subject, user_id, linked_by) VALUES ($1,'adm',$2,'test')`, [ISS, userId]);
    who = { sub: 'adm', amr: ['pwd', 'otp'], acr: 'MFA' };
    const r = await sso(base);
    expect(await r.json()).toEqual({ status: 'mfa_required' });
    expect(cookie(r, 'bary_sid')).toBe('');
  });
});
