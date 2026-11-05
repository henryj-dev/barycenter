/**
 * IdP 권한 위임 (A안) — 역할 + entitlement grant/deny, 공급자 기본 IdP 정본, JIT 역할. 실제 HTTP 서버 + 실물 계정 PG + 가짜 IdP.
 *
 * 재는 것:
 *   · 공급자 기본 정본을 켜면 그 공급자와 이어진 사람은 모두 IdP 정본이다(손으로 역할 못 바꿈). 매핑 없이는 못 켠다
 *   · JIT 로 처음 오는 사람도 매핑 결과 역할로 만든다. 매핑이 거절하면 계정을 만들지 않는다
 *   · **실효 범위로 쓰기가 막힌다**(deny) · grant 가 범위를 연다 · deny 가 이긴다 · 개인 토큰도 주인의 deny 를 넘지 못한다
 *   · 마지막 관리자의 admin 범위는 deny 로도 안 빠진다 · admin grant 는 둘째 인증이 있어야 한다
 */
import { createHmac, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
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

const PG = pgFor('accounts-idp-delegation');
const ISS = 'https://idp.test';
/** 가짜 IdP 의 HS256 서명값 — 실행 중에 만든다(저장소에 비밀 모양을 두지 않는다). */
const SECRET = randomBytes(24).toString('hex');
let db: Db;
let accounts: AccountService;
const servers: Server[] = [];
const sealer = new Sealer(randomBytes(32).toString('base64'));
let who: Record<string, unknown> = {};
let lastNonce = '';

/** Role Change SET 서명 — IdP 의 JWKS 키 하나(RS256). 실행 중에 만든다. */
const setKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const forger = generateKeyPairSync('rsa', { modulusLength: 2048 });
const EVENT = 'https://idp.test/events/role-change';
let jtiSeq = 0;
let txnSeq = 1_800_000_000_000n;
function set(sub: string, roles: string[], entitlements: string[], o: { jti?: string; txn?: bigint; key?: typeof setKeys.privateKey } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'secevent+jwt', kid: 'k1' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({
    iss: ISS, aud: 'bary', iat: now, exp: now + 300, jti: o.jti ?? `j-${++jtiSeq}`, sub,
    txn: String(o.txn ?? (txnSeq += 1n)), events: { [EVENT]: { roles, entitlements } },
  })).toString('base64url');
  return `${h}.${p}.${createSign('RSA-SHA256').update(`${h}.${p}`).sign(o.key ?? setKeys.privateKey).toString('base64url')}`;
}
const push = (base: string, token: string): Promise<Response> => fetch(`${base}/api/v1/oidc/role-change`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ role_change_token: token }).toString(),
});

const LODESTAR_MAP = { 'barycenter-admins': 'admin', 'barycenter-operators': 'operator', 'barycenter-auditors': 'auditor' };

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
    election: { state: { isLeader: true } } as unknown as LeaderElection,
    accounts,
    oidcRp: {
      issuer: ISS, audience: 'bary', key: SECRET,
      authorizationEndpoint: `${ISS}/authorize`, tokenEndpoint: `${ISS}/token`, clientId: 'bary', redirectUri: 'https://bary.test/login',
    },
    oidcFetch: async () => new Response(JSON.stringify({ id_token: idToken(who) }), { status: 200 }),
    oidcRoleChange: { eventKey: EVENT, keyFor: (kid: string | undefined) => (kid === 'k1' ? setKeys.publicKey : undefined) },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const cookie = (r: Response, name: string): string =>
  (r.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? '').split(';', 1)[0]!;

async function sso(base: string): Promise<Response> {
  const s = await fetch(`${base}/api/v1/oidc/authorization-request`);
  const body = await s.json() as { url: string; state: string };
  lastNonce = new URL(body.url).searchParams.get('nonce')!;
  return fetch(`${base}/api/v1/oidc/token`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base, cookie: cookie(s, 'bary_sso') },
    body: JSON.stringify({ code: 'c', state: body.state }),
  });
}

async function me(base: string, sid: string): Promise<{ id: string; role: string; scopes: string[]; idpAuthority: boolean; roleAuthorityByProvider: boolean }> {
  return await (await fetch(`${base}/api/v1/me`, { headers: { cookie: sid } })).json() as never;
}

/** SSO 로 이어진 로컬 정본 operator(비밀번호 있음). */
async function linkedOperator(sub: string): Promise<string> {
  const { token } = await accounts.invite({ role: 'operator' }, 't');
  const { userId } = await accounts.acceptLink({ token, username: `u-${sub}`, password: 'operator-pass-1' });
  await db.query(`INSERT INTO user_identities (issuer, subject, user_id, linked_by) VALUES ($1,$2,$3,'test')`, [ISS, sub, userId]);
  return userId;
}

/** 인증 앱이 있는 첫 관리자. */
async function bootstrapAdmin(sub?: string): Promise<{ userId: string; key: Buffer }> {
  const t = await accounts.bootstrap('cli');
  const p = await accounts.previewLink(t);
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0; let v = 0; const key: number[] = [];
  for (const ch of p.totp!.secret) { v = (v << 5) | A.indexOf(ch); bits += 5; if (bits >= 8) { key.push((v >>> (bits - 8)) & 255); bits -= 8; } }
  const { userId } = await accounts.acceptLink({ token: t, username: 'root', password: 'admin-password-1', totp: { secret: p.totp!.secret, code: hotp(Buffer.from(key), stepOf(Date.now())) } });
  if (sub !== undefined) await db.query(`INSERT INTO user_identities (issuer, subject, user_id, linked_by) VALUES ($1,$2,$3,'test')`, [ISS, sub, userId]);
  return { userId, key: Buffer.from(key) };
}

const row = async (id: string): Promise<{ role: string; idp_grant: string[]; idp_deny: string[] }> =>
  (await db.query('SELECT role, idp_grant, idp_deny FROM users WHERE id=$1', [id])).rows[0] as never;

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

describe('공급자 기본 IdP 정본', () => {
  it('**켜면 그 공급자와 이어진 사람은 모두 IdP 정본** — 로그인이 역할을 맞추고, 손으로는 못 바꾼다', async () => {
    const base = await serve();
    const id = await linkedOperator('p-1');
    await accounts.setProviderMapping(ISS, { profile: 'lodestar', roleMap: LODESTAR_MAP }, 'test');
    await accounts.setProviderAuthority(ISS, true, 'test');
    who = { sub: 'p-1', roles: ['barycenter-auditors', 'heliopause-operators'] };
    const r = await sso(base);
    expect(r.status).toBe(200);
    expect(await me(base, cookie(r, 'bary_sid'))).toMatchObject({ role: 'auditor', idpAuthority: true, roleAuthorityByProvider: true });
    await expect(accounts.updateUser(id, { role: 'operator' }, 't')).rejects.toMatchObject({ code: 'role_from_idp' });
    // 끄면 그 사람의 정본(로컬)으로 돌아가고, 손으로 바꿀 수 있다
    await accounts.setProviderAuthority(ISS, false, 'test');
    await accounts.updateUser(id, { role: 'operator' }, 't');
    expect((await row(id)).role).toBe('operator');
  });

  it('역할 클레임 · 매핑 없이는 켜지 않는다(409) — 켜면 그 공급자로 오는 사람이 모두 거부된다', async () => {
    await expect(accounts.setProviderAuthority(ISS, true, 'test')).rejects.toMatchObject({ code: 'roles_not_configured' });
  });

  it('**JIT 로 처음 오는 사람도 매핑 결과 역할** — 매핑이 거절하면 계정을 만들지 않는다', async () => {
    const base = await serve();
    await accounts.setProviderMapping(ISS, { profile: 'lodestar', roleMap: LODESTAR_MAP }, 'test');
    await accounts.setProviderAuthority(ISS, true, 'test');
    await accounts.setProviderJit(ISS, true, 'test');
    who = { sub: 'new-1', preferred_username: 'newbie', roles: ['barycenter-operators'], entitlements: ['barycenter.apply'] };
    const r = await sso(base);
    expect(r.status).toBe(200);
    expect(await me(base, cookie(r, 'bary_sid'))).toMatchObject({ role: 'operator', scopes: ['read', 'write', 'apply'] });
    const before = Number((await db.query('SELECT count(*) AS n FROM users')).rows[0]!['n']);
    who = { sub: 'new-2', preferred_username: 'stranger', roles: ['heliopause-operators'] };
    expect((await sso(base)).status).toBe(401);
    expect(Number((await db.query('SELECT count(*) AS n FROM users')).rows[0]!['n'])).toBe(before);
  });

  it('JIT 는 기본 정본이 꺼져 있으면 여전히 auditor 다(지금 동작)', async () => {
    const base = await serve();
    await accounts.setProviderMapping(ISS, { profile: 'lodestar', roleMap: LODESTAR_MAP }, 'test');
    await accounts.setProviderJit(ISS, true, 'test');
    who = { sub: 'new-3', preferred_username: 'plain', roles: ['barycenter-operators'] };
    const r = await sso(base);
    expect(await me(base, cookie(r, 'bary_sid'))).toMatchObject({ role: 'auditor', idpAuthority: false });
  });
});

describe('실효 범위 — 역할 범위 ∪ grant − deny', () => {
  async function idpOperatorSession(base: string, entitlements: string[]): Promise<{ id: string; sid: string }> {
    const id = await linkedOperator('e-1');
    await accounts.setProviderMapping(ISS, { profile: 'lodestar', roleMap: LODESTAR_MAP }, 'test');
    await accounts.updateUser(id, { roleAuthority: 'idp' }, 'test');
    who = { sub: 'e-1', roles: ['barycenter-operators'], entitlements };
    const r = await sso(base);
    expect(r.status).toBe(200);
    return { id, sid: cookie(r, 'bary_sid') };
  }

  it('**deny 로 쓰기가 막힌다** — 운영자인데 `barycenter.no_write` 면 write 경로가 403', async () => {
    const base = await serve();
    const { id, sid } = await idpOperatorSession(base, ['barycenter.no_write']);
    expect((await row(id)).idp_deny).toEqual(['write']);
    expect((await me(base, sid)).scopes).toEqual(['read']);
    const w = await fetch(`${base}/api/v1/changesets`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, cookie: sid }, body: '{}' });
    expect(w.status).toBe(403);
    expect((await w.json() as { code: string }).code).toBe('forbidden');
  });

  it('grant 가 범위를 연다 · **deny 가 이긴다**', async () => {
    const base = await serve();
    const { sid } = await idpOperatorSession(base, ['barycenter.apply']);
    expect((await me(base, sid)).scopes).toEqual(['read', 'write', 'apply']);
    who = { sub: 'e-1', roles: ['barycenter-operators'], entitlements: ['barycenter.apply', 'barycenter.no_apply'] };
    await sso(base);
    // 먼저 열린 세션도 다음 요청부터 새 범위다
    expect((await me(base, sid)).scopes).toEqual(['read', 'write']);
  });

  it('개인 토큰은 주인의 deny 를 넘지 못한다', async () => {
    const base = await serve();
    const { id } = await idpOperatorSession(base, []);
    const t = await accounts.issueToken(id, { name: 'ci', role: 'operator' }, 'test');
    expect([...(await accounts.authenticateToken(t.token))!.scopes]).toEqual(['read', 'write']);
    who = { sub: 'e-1', roles: ['barycenter-operators'], entitlements: ['barycenter.no_write'] };
    await sso(base);
    expect([...(await accounts.authenticateToken(t.token))!.scopes]).toEqual(['read']);
  });

  it('정본을 로컬로 돌리면 IdP 가 준 grant/deny 는 지운다', async () => {
    const base = await serve();
    const { id } = await idpOperatorSession(base, ['barycenter.no_write']);
    await accounts.updateUser(id, { roleAuthority: 'local' }, 'test');
    expect(await row(id)).toMatchObject({ idp_grant: [], idp_deny: [] });
  });

  it('모르는 접두 entitlement 는 로그인 거부(감사) — 범위를 추측하지 않는다', async () => {
    const base = await serve();
    const id = await linkedOperator('e-2');
    await accounts.setProviderMapping(ISS, { profile: 'lodestar', roleMap: LODESTAR_MAP }, 'test');
    await accounts.updateUser(id, { roleAuthority: 'idp' }, 'test');
    who = { sub: 'e-2', roles: ['barycenter-operators'], entitlements: ['barycenter.no_everything'] };
    expect((await sso(base)).status).toBe(401);
    const a = (await db.query(`SELECT detail FROM account_audit WHERE action='account.idp_role_refused'`)).rows;
    expect(JSON.stringify(a)).toContain('unknown-entitlement');
  });
});

describe('관리자 안전장치', () => {
  it('**마지막 관리자의 admin 범위는 deny 로도 안 빠진다** — 그 로그인만 거부', async () => {
    const base = await serve();
    await accounts.setProviderMapping(ISS, { profile: 'lodestar', roleMap: LODESTAR_MAP }, 'test');
    const { userId } = await bootstrapAdmin('root-sub');
    await accounts.updateUser(userId, { roleAuthority: 'idp' }, 'test');
    who = { sub: 'root-sub', roles: ['barycenter-admins'], entitlements: ['barycenter.no_admin'] };
    expect((await sso(base)).status).toBe(401);
    expect(await row(userId)).toMatchObject({ role: 'admin', idp_deny: [] });
  });

  it('admin 범위 grant 는 둘째 인증이 있어야 한다', async () => {
    const base = await serve();
    await bootstrapAdmin();
    const id = await linkedOperator('g-1');
    await accounts.setProviderMapping(ISS, { profile: 'lodestar', roleMap: LODESTAR_MAP }, 'test');
    await accounts.updateUser(id, { roleAuthority: 'idp' }, 'test');
    who = { sub: 'g-1', roles: ['barycenter-operators'], entitlements: ['barycenter.admin'] };
    expect((await sso(base)).status).toBe(401);
    expect((await row(id)).idp_grant).toEqual([]);
  });

  it('admin grant 를 받은 사람은 마지막 관리자 판정에 들어간다 — 역할 admin 을 내려도 관리자가 남는다', async () => {
    const { userId: root } = await bootstrapAdmin();
    const id = await linkedOperator('g-2');
    // 인증 앱을 붙인다(관리자 범위의 조건)
    await db.query(`INSERT INTO mfa_totp (user_id, secret_sealed, last_step, confirmed_at) VALUES ($1,'x',0,now())`, [id]);
    await accounts.setProviderMapping(ISS, { profile: 'lodestar', roleMap: LODESTAR_MAP }, 'test');
    await accounts.updateUser(id, { roleAuthority: 'idp' }, 'test');
    const base = await serve();
    who = { sub: 'g-2', roles: ['barycenter-operators'], entitlements: ['barycenter.admin'] };
    expect((await sso(base)).status).toBe(200); // MFA 단계로 간다
    expect((await row(id)).idp_grant).toEqual(['admin']);
    await accounts.updateUser(root, { role: 'operator' }, 'test');
    expect((await row(root)).role).toBe('operator');
  });
});

describe('Role Change 즉시 반영 (서명된 SET push)', () => {
  /** IdP 정본 operator 하나와 그 사람의 열린 세션. */
  async function idpSession(base: string, sub = 'rc-1'): Promise<{ id: string; sid: string }> {
    const id = await linkedOperator(sub);
    await accounts.setProviderMapping(ISS, { profile: 'lodestar', roleMap: LODESTAR_MAP }, 'test');
    await accounts.updateUser(id, { roleAuthority: 'idp' }, 'test');
    who = { sub, roles: ['barycenter-operators'] };
    const r = await sso(base);
    expect(r.status).toBe(200);
    return { id, sid: cookie(r, 'bary_sid') };
  }

  it('**열린 세션의 범위가 바로 바뀐다** — 다음 로그인을 기다리지 않는다', async () => {
    const base = await serve();
    const { id, sid } = await idpSession(base);
    expect((await me(base, sid)).scopes).toEqual(['read', 'write']);
    const r = await push(base, set('rc-1', ['barycenter-operators'], ['barycenter.no_write']));
    expect(r.status).toBe(204);
    expect((await me(base, sid)).scopes).toEqual(['read']);
    expect(await row(id)).toMatchObject({ role: 'operator', idp_deny: ['write'] });
    const w = await fetch(`${base}/api/v1/changesets`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, cookie: sid }, body: '{}' });
    expect(w.status).toBe(403);
    // 역할도 바꾼다
    expect((await push(base, set('rc-1', ['barycenter-auditors'], []))).status).toBe(204);
    expect(await me(base, sid)).toMatchObject({ role: 'auditor', scopes: ['read'] });
  });

  it('**위조 SET 은 거절**(401) — 아무것도 바뀌지 않는다', async () => {
    const base = await serve();
    const { id } = await idpSession(base);
    const r = await push(base, set('rc-1', ['barycenter-admins'], [], { key: forger.privateKey }));
    expect(r.status).toBe(401);
    expect((await row(id)).role).toBe('operator');
    // ID Token(typ JWT · nonce)도 역할 변경이 아니다
    expect((await push(base, idToken({ sub: 'rc-1', roles: ['barycenter-auditors'] }))).status).toBe(401);
    expect((await push(base, '')).status).toBe(400);
  });

  it('**jti 재사용은 거절**(409) · 늦게 온 옛 스냅숏(txn)도 거절 — 철회가 되돌아가지 않는다', async () => {
    const base = await serve();
    const { id } = await idpSession(base);
    const grant = set('rc-1', ['barycenter-operators'], ['barycenter.apply'], { txn: 1_900_000_000_001n });
    const revoke = set('rc-1', ['barycenter-operators'], [], { txn: 1_900_000_000_002n });
    expect((await push(base, revoke)).status).toBe(204);
    expect((await push(base, revoke)).status).toBe(409);
    const late = await push(base, grant);
    expect(late.status).toBe(409);
    expect((await late.json() as { code: string }).code).toBe('role_change_stale');
    expect((await row(id)).idp_grant).toEqual([]);
    // jti 는 여러 인스턴스가 같이 본다 — 다른 서버로 다시 보내도 409
    const other = await serve();
    expect((await push(other, revoke)).status).toBe(409);
  });

  it('IdP 정본이 아닌 사람은 **무시**(204 · 감사만)', async () => {
    const base = await serve();
    const id = await linkedOperator('local-1');
    await accounts.setProviderMapping(ISS, { profile: 'lodestar', roleMap: LODESTAR_MAP }, 'test');
    expect((await push(base, set('local-1', ['barycenter-auditors'], []))).status).toBe(204);
    expect((await row(id)).role).toBe('operator');
    const a = (await db.query(`SELECT detail FROM account_audit WHERE action='account.idp_role_change_ignored' AND subject_user=$1`, [id])).rows;
    expect(a).toHaveLength(1);
    // 연결 없는 sub 도 무시한다
    expect((await push(base, set('nobody', ['barycenter-admins'], []))).status).toBe(204);
  });

  it('**역할을 잃으면 로컬 역할로 떨어지지 않는다** — 모든 범위를 빼고 세션을 끊는다', async () => {
    const base = await serve();
    const { id, sid } = await idpSession(base);
    const t = await accounts.issueToken(id, { name: 'ci', role: 'operator' }, 'test');
    expect((await push(base, set('rc-1', ['heliopause-operators'], []))).status).toBe(204);
    expect((await row(id)).idp_deny).toEqual(['read', 'write', 'apply', 'admin']);
    expect((await fetch(`${base}/api/v1/me`, { headers: { cookie: sid } })).status).toBe(401);
    expect([...(await accounts.authenticateToken(t.token))!.scopes]).toEqual([]);
    // IdP 가 다시 주면 돌아온다
    expect((await push(base, set('rc-1', ['barycenter-operators'], []))).status).toBe(204);
    expect([...(await accounts.authenticateToken(t.token))!.scopes]).toEqual(['read', 'write']);
  });

  it('**마지막 관리자 보호** — Role Change 로도 마지막 관리자의 admin 범위를 빼지 않는다(409)', async () => {
    const base = await serve();
    await accounts.setProviderMapping(ISS, { profile: 'lodestar', roleMap: LODESTAR_MAP }, 'test');
    const { userId } = await bootstrapAdmin('root-sub');
    await accounts.updateUser(userId, { roleAuthority: 'idp' }, 'test');
    for (const [roles, ents] of [[['barycenter-operators'], []], [['barycenter-admins'], ['barycenter.no_admin']], [[], []]] as const) {
      const r = await push(base, set('root-sub', [...roles], [...ents]));
      expect(r.status).toBe(409);
      expect((await r.json() as { code: string }).code).toBe('role_change_guarded');
    }
    expect(await row(userId)).toMatchObject({ role: 'admin', idp_grant: [], idp_deny: [] });
  });

  it('로컬 정지가 우선 — 정지된 사람의 SET 은 무시', async () => {
    const base = await serve();
    const { id } = await idpSession(base);
    await accounts.updateUser(id, { status: 'suspended' }, 'test');
    expect((await push(base, set('rc-1', ['barycenter-admins'], []))).status).toBe(204);
    expect((await row(id)).role).toBe('operator');
  });
});
