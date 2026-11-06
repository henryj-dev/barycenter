/**
 * 개인 API 토큰 (2026-11-04 사용자 승인 설계) — 실물 계정 PG + 실제 HTTP 서버.
 *
 * 재는 것 (서비스): 발급·검증, 만료(기본 90일 · 1–365일), 폐기, 주인 정지·삭제, **역할은 주인을 넘지 못한다**
 * (발급 때도 · 발급 뒤 주인 강등도), 마지막 사용은 1분에 한 번만 적힌다, 감사에는 값·해시가 없다.
 * 재는 것 (HTTP): 401 · 403 갈래, 발급·폐기의 step-up, 관리자 폐기, operator 는 admin 토큰을 못 만든다,
 * 만료 일수 경계(0 · 366 거절), 토큰으로 토큰을 못 만든다, 민감 작업은 토큰으로 못 한다, 파일 토큰이 먼저다,
 * 틀린 토큰은 지금처럼 실패로 센다, 계정 PG 를 못 물으면 503.
 *
 * **토큰 값은 코드에 적지 않는다** — 전부 실행 중에 발급받는다. 파일 토큰의 평문도 실행 중에 만든다.
 */
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hashToken, PERSONAL_TOKEN, TokenAuth } from '../../src/api/auth.js';
import { createApi } from '../../src/api/server.js';
import { ACCOUNT_MIGRATIONS } from '../../src/accounts/migrations.js';
import { Sealer } from '../../src/accounts/seal.js';
import { AccountService } from '../../src/accounts/service.js';
import { base32Encode, hotp, stepOf } from '../../src/accounts/totp.js';
import type { ConfigStore } from '../../src/store/config-store.js';
import type { ControlPlane } from '../../src/control/plane.js';
import type { LeaderElection } from '../../src/control/leader.js';
import { byDialect } from '../../src/store/db.js';
import { Db, dockerAvailable, pgFor, startPg, stopPg, freshSchema } from './pg-fixture.js';

const PG = pgFor('accounts-tokens');
let db: Db;
let clock = Date.now();
const sealer = new Sealer(randomBytes(32).toString('base64'));
const svc = (): AccountService => new AccountService({ db, sealer, now: () => clock });
const DAY = 24 * 60 * 60 * 1000;

function codeFor(b32: string, at = clock): string {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0; let v = 0; const out: number[] = [];
  for (const ch of b32) { v = (v << 5) | A.indexOf(ch); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } }
  return hotp(Buffer.from(out), stepOf(at));
}

/** 인증 앱까지 등록한 사람. admin 은 bootstrap, 나머지는 초대. */
async function person(s: AccountService, role: 'auditor' | 'operator' | 'admin', username: string, at = clock): Promise<{ id: string; secret: string; password: string }> {
  const password = `${role}-Pass-1x`;
  const secret = base32Encode(randomBytes(20));
  const token = role === 'admin' && (await db.query(`SELECT 1 FROM users WHERE role='admin'`)).rows.length === 0
    ? await s.bootstrap('test')
    : (await s.invite({ role }, 'test')).token;
  const { userId } = await s.acceptLink({ token, username, password, totp: { secret, code: codeFor(secret, at) } });
  return { id: userId, secret, password };
}

const auditRows = async (): Promise<{ action: string; actor: string; subject_user: string | null; detail: unknown }[]> =>
  (await db.query(`SELECT action, actor, subject_user, detail FROM account_audit WHERE action LIKE 'account.token_%' ORDER BY id`)).rows as never;

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 이 스위트는 실물 PG 를 쓴다');
  startPg(PG);
  db = new Db(PG.dsn);
}, 180_000);

afterAll(async () => { await db?.close(); stopPg(PG); });

beforeEach(async () => {
  await freshSchema(db);
  await db.migrate(ACCOUNT_MIGRATIONS);
  clock = Date.now();
});

describe('개인 토큰 — 서비스', () => {
  it('**발급한 값으로 인증되고, 서버에는 값이 남지 않는다**', async () => {
    const s = svc();
    const op = await person(s, 'operator', 'op');
    const out = await s.issueToken(op.id, { name: 'ci-bot', role: 'operator' }, 'user:op');
    expect(out.token).toMatch(PERSONAL_TOKEN);
    expect(out.prefix).toBe(out.token.slice(0, 'bary_'.length + 16));
    // 기본 만료 90일
    expect(new Date(out.expiresAt).getTime() - new Date(out.createdAt).getTime()).toBe(90 * DAY);
    const p = await s.authenticateToken(out.token);
    expect(p).toMatchObject({ name: 'user:op/token:ci-bot', role: 'operator', token: { id: out.id, userId: op.id } });
    expect([...p!.scopes].sort()).toEqual(['read', 'write']);
    expect(p!.account).toBeUndefined();
    // 행 어디에도 평문이 없다
    const row = JSON.stringify((await db.query('SELECT * FROM api_tokens')).rows);
    expect(row).not.toContain(out.token);
    expect(row).not.toContain(out.token.slice(-43));
    // 목록에도 비밀이 없다
    const list = await s.listTokens(op.id);
    expect(list).toEqual([{ id: out.id, name: 'ci-bot', role: 'operator', prefix: out.prefix, createdAt: out.createdAt, expiresAt: out.expiresAt, lastUsedAt: expect.any(String) }]);
    expect(JSON.stringify(list)).not.toContain(out.token.slice(-43));
    // 비밀 한 글자만 달라도, 모양이 틀려도 없다
    const last = out.token.at(-1) === 'A' ? 'B' : 'A';
    expect(await s.authenticateToken(out.token.slice(0, -1) + last)).toBeUndefined();
    expect(await s.authenticateToken('bary_nope')).toBeUndefined();
  });

  it('**만료** — 기한이 지나면 401, 일수는 1–365 정수만', async () => {
    const s = svc();
    const op = await person(s, 'operator', 'op');
    for (const bad of [0, 366, -1, 1.5, '30', null]) {
      await expect(s.issueToken(op.id, { name: 'x', role: 'auditor', expiresInDays: bad }, 'user:op'))
        .rejects.toMatchObject({ status: 400, code: 'bad_expiry' });
    }
    const max = await s.issueToken(op.id, { name: 'max', role: 'auditor', expiresInDays: 365 }, 'user:op');
    expect(new Date(max.expiresAt).getTime() - clock).toBe(365 * DAY);
    const short = await s.issueToken(op.id, { name: 'short', role: 'auditor', expiresInDays: 1 }, 'user:op');
    clock += DAY - 1000;
    expect(await s.authenticateToken(short.token)).toBeDefined();
    clock += 2000;
    expect(await s.authenticateToken(short.token)).toBeUndefined();
    expect(await s.tokenAlive(short.id)).toBe(false);
    expect(await s.authenticateToken(max.token)).toBeDefined();
  });

  it('이름은 시안의 규칙이다', async () => {
    const s = svc();
    const op = await person(s, 'operator', 'op');
    for (const bad of ['', '-x', '.x', 'a b', 'ㄱ', 'x'.repeat(64), 7]) {
      await expect(s.issueToken(op.id, { name: bad, role: 'auditor' }, 'user:op')).rejects.toMatchObject({ code: 'bad_token_name' });
    }
    await expect(s.issueToken(op.id, { name: 'A1._-z', role: 'auditor' }, 'user:op')).resolves.toBeDefined();
    await expect(s.issueToken(op.id, { name: 'x'.repeat(63), role: 'auditor' }, 'user:op')).resolves.toBeDefined();
  });

  it('**폐기하면 바로 401** — 남의 토큰 id 로는 못 거둔다', async () => {
    const s = svc();
    const op = await person(s, 'operator', 'op');
    const other = await person(s, 'auditor', 'other');
    const t = await s.issueToken(op.id, { name: 'ci', role: 'operator' }, 'user:op');
    await expect(s.revokeToken(other.id, t.id, 'user:other')).rejects.toMatchObject({ status: 404, code: 'no_token' });
    expect(await s.authenticateToken(t.token)).toBeDefined();
    await s.revokeToken(op.id, t.id, 'user:op');
    expect(await s.authenticateToken(t.token)).toBeUndefined();
    expect(await s.tokenAlive(t.id)).toBe(false);
    expect(await s.listTokens(op.id)).toEqual([]);
    await expect(s.revokeToken(op.id, t.id, 'user:op')).rejects.toMatchObject({ code: 'no_token' });
    await expect(s.revokeToken(op.id, 'not-a-uuid', 'user:op')).rejects.toMatchObject({ code: 'no_token' });
  });

  it('**정지하면 토큰을 거두고, 다시 활성해도 돌아오지 않는다** — 감사에는 id · 개수만', async () => {
    const s = svc();
    await person(s, 'admin', 'root');
    const op = await person(s, 'operator', 'op');
    const a = await s.issueToken(op.id, { name: 'ci', role: 'operator' }, 'user:op');
    const b = await s.issueToken(op.id, { name: 'ro', role: 'auditor' }, 'user:op');
    await s.updateUser(op.id, { status: 'suspended' }, 'user:root');
    expect(await s.authenticateToken(a.token)).toBeUndefined();
    expect(await s.tokenAlive(a.id)).toBe(false);
    // 정지된 사람은 새로 발급하지 못한다
    await expect(s.issueToken(op.id, { name: 'ci2', role: 'auditor' }, 'user:op')).rejects.toMatchObject({ code: 'no_user' });
    await s.updateUser(op.id, { status: 'active' }, 'user:root');
    expect(await s.authenticateToken(a.token)).toBeUndefined();
    expect(await s.authenticateToken(b.token)).toBeUndefined();
    expect(await s.listTokens(op.id)).toEqual([]);
    const all = (await auditRows()).filter((r) => r.action === 'account.token_revoke_all');
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ actor: 'user:root', subject_user: op.id });
    const d = all[0]!.detail as { reason: string; count: number; tokenIds: string[] };
    expect(d.reason).toBe('suspend');
    expect(d.count).toBe(2);
    expect([...d.tokenIds].sort()).toEqual([a.id, b.id].sort());
    expect(JSON.stringify(all)).not.toContain(a.token.slice(-43));
    // 거둘 것이 없으면 감사를 늘리지 않는다
    await s.updateUser(op.id, { status: 'suspended' }, 'user:root');
    expect((await auditRows()).filter((r) => r.action === 'account.token_revoke_all')).toHaveLength(1);
  });

  it('**삭제되면 토큰도 거둔다**', async () => {
    const s = svc();
    await person(s, 'admin', 'root');
    const op = await person(s, 'operator', 'op');
    const t = await s.issueToken(op.id, { name: 'ci', role: 'operator' }, 'user:op');
    await s.deleteUser(op.id, 'user:root');
    expect(await s.authenticateToken(t.token)).toBeUndefined();
    expect((await db.query('SELECT revoked_at FROM api_tokens WHERE id=$1', [t.id])).rows[0]!['revoked_at']).not.toBeNull();
  });

  it('**복구 링크를 쓰면 토큰을 거두고, 비밀번호만 바꾸면 그대로다**', async () => {
    const s = svc();
    await person(s, 'admin', 'root');
    const op = await person(s, 'operator', 'op');
    const t = await s.issueToken(op.id, { name: 'ci', role: 'operator' }, 'user:op');
    // 비밀번호 변경 — 토큰은 산다
    await s.changePassword(op.id, op.password, 'operator-Pass-2y', 'keep-none');
    expect((await s.authenticateToken(t.token))?.role).toBe('operator');
    // 복구 링크는 만들기만 해서는 거두지 않는다 — 쓸 때 거둔다
    const link = await s.recoveryLink(op.id, 'user:root');
    expect(await s.authenticateToken(t.token)).toBeDefined();
    await s.acceptLink({ token: link, password: 'operator-Pass-3z' });
    expect(await s.authenticateToken(t.token)).toBeUndefined();
    expect(await s.listTokens(op.id)).toEqual([]);
    const all = (await auditRows()).filter((r) => r.action === 'account.token_revoke_all');
    expect(all.map((r) => (r.detail as { reason: string; tokenIds: string[] }))).toEqual([{ reason: 'recovery', count: 1, tokenIds: [t.id] }]);
    // 복구 뒤 새로 만든 토큰은 쓴다
    const n = await s.issueToken(op.id, { name: 'ci', role: 'operator' }, 'user:op');
    expect(await s.authenticateToken(n.token)).toBeDefined();
  });

  it('**발급 역할은 주인의 역할 이하다** — operator 는 admin 토큰을 못 만든다', async () => {
    const s = svc();
    const op = await person(s, 'operator', 'op');
    const au = await person(s, 'auditor', 'au');
    await expect(s.issueToken(op.id, { name: 'x', role: 'admin' }, 'user:op')).rejects.toMatchObject({ status: 403, code: 'role_exceeds_owner' });
    await expect(s.issueToken(au.id, { name: 'x', role: 'operator' }, 'user:au')).rejects.toMatchObject({ status: 403, code: 'role_exceeds_owner' });
    await expect(s.issueToken(op.id, { name: 'x', role: 'root' }, 'user:op')).rejects.toMatchObject({ status: 400 });
    expect((await s.issueToken(op.id, { name: 'ok', role: 'auditor' }, 'user:op')).role).toBe('auditor');
  });

  it('**발급 뒤 주인이 강등되면 토큰도 다음 요청부터 그 역할로 깎인다** — 다시 올라도 토큰 역할을 넘지 않는다', async () => {
    const s = svc();
    await person(s, 'admin', 'root');
    const op = await person(s, 'operator', 'op');
    const t = await s.issueToken(op.id, { name: 'ci', role: 'operator' }, 'user:op');
    const ro = await s.issueToken(op.id, { name: 'ro', role: 'auditor' }, 'user:op');
    await s.updateUser(op.id, { role: 'auditor' }, 'user:root');
    const p = await s.authenticateToken(t.token);
    expect(p?.role).toBe('auditor');
    expect([...p!.scopes]).toEqual(['read']);
    await s.updateUser(op.id, { role: 'admin' }, 'user:root');
    expect((await s.authenticateToken(t.token))?.role).toBe('operator');
    expect((await s.authenticateToken(ro.token))?.role).toBe('auditor');
  });

  it('**마지막 사용은 1분에 한 번만 적는다**', async () => {
    const s = svc();
    const op = await person(s, 'operator', 'op');
    const t = await s.issueToken(op.id, { name: 'ci', role: 'operator' }, 'user:op');
    const lastUsed = async (): Promise<number | null> => {
      const v = (await db.query('SELECT last_used_at FROM api_tokens WHERE id=$1', [t.id])).rows[0]!['last_used_at'];
      return v === null ? null : (v as Date).getTime();
    };
    expect(await lastUsed()).toBeNull();
    const t0 = clock;
    await s.authenticateToken(t.token);
    expect(await lastUsed()).toBe(t0);
    clock += 30_000;
    await s.authenticateToken(t.token);
    await s.authenticateToken(t.token);
    expect(await lastUsed()).toBe(t0);
    clock += 31_000;
    await s.authenticateToken(t.token);
    expect(await lastUsed()).toBe(clock);
    // 실패한 시도는 적지 않는다
    await s.revokeToken(op.id, t.id, 'user:op');
    clock += 120_000;
    await s.authenticateToken(t.token);
    expect(await lastUsed()).toBe(clock - 120_000);
  });

  it('**감사에는 누가 · 누구의 · 어느 토큰 · 이름 · 역할 · 만료만 — 값도 해시도 없다**', async () => {
    const s = svc();
    await person(s, 'admin', 'root');
    const op = await person(s, 'operator', 'op');
    const t = await s.issueToken(op.id, { name: 'ci', role: 'operator', expiresInDays: 30 }, 'user:op');
    await s.revokeToken(op.id, t.id, 'user:root');
    const rows = await auditRows();
    expect(rows.map((r) => [r.action, r.actor, r.subject_user])).toEqual([
      ['account.token_issue', 'user:op', op.id],
      ['account.token_revoke', 'user:root', op.id],
    ]);
    expect(rows[0]!.detail).toEqual({ tokenId: t.id, name: 'ci', role: 'operator', expiresAt: t.expiresAt });
    expect(rows[1]!.detail).toEqual({ tokenId: t.id, name: 'ci', role: 'operator', expiresAt: t.expiresAt });
    const hash = (await db.query('SELECT token_hash FROM api_tokens WHERE id=$1', [t.id])).rows[0]!['token_hash'] as string;
    const all = JSON.stringify((await db.query('SELECT * FROM account_audit')).rows);
    expect(all).not.toContain(t.token.slice(-43));
    expect(all).not.toContain(hash);
  });

  it('사용자 목록은 살아 있는 토큰 수를 보인다', async () => {
    const s = svc();
    await person(s, 'admin', 'root');
    const op = await person(s, 'operator', 'op');
    await s.issueToken(op.id, { name: 'a', role: 'operator' }, 'user:op');
    const b = await s.issueToken(op.id, { name: 'b', role: 'operator' }, 'user:op');
    await s.issueToken(op.id, { name: 'c', role: 'operator', expiresInDays: 1 }, 'user:op');
    await s.revokeToken(op.id, b.id, 'user:op');
    clock += 2 * DAY;
    const users = await s.listUsers() as { username: string; tokens: number }[];
    expect(users.find((u) => u.username === 'op')?.tokens).toBe(1);
  });
});

describe('개인 토큰 — HTTP', () => {
  let server: Server | undefined;
  let base = '';
  let accounts: AccountService;
  const FILE_TOKEN = randomBytes(24).toString('hex');

  async function serve(a: AccountService): Promise<void> {
    server = createApi({
      db: {} as Db,
      store: { head: async () => ({ revision: '1', etag: 'e1' }) } as unknown as ConfigStore,
      control: {} as ControlPlane,
      auth: new TokenAuth([{ name: 'ci', role: 'admin', hash: hashToken(FILE_TOKEN) }]),
      election: { state: { isLeader: false, reason: '스탠바이' } } as unknown as LeaderElection,
      accounts: a,
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const close = async (): Promise<void> => {
    server?.closeAllConnections?.();
    if (server !== undefined) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  };

  beforeEach(async () => {
    // HTTP 쪽은 실제 시계다 — step-up 판정이 `Date.now()` 와 세션의 MFA 시각을 견준다.
    accounts = new AccountService({ db, sealer });
    await serve(accounts);
  });
  afterEach(close);

  const req = (method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method,
      headers: { origin: base, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const cookieOf = (r: Response, name: string): string =>
    (r.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? '').split(';', 1)[0]!;
  const bearer = (t: string): Record<string, string> => ({ authorization: `Bearer ${t}` });

  /** 로그인해 MFA 까지 지난 세션 쿠키. */
  async function login(role: 'auditor' | 'operator' | 'admin', username: string): Promise<{ cookie: string; id: string; secret: string }> {
    const p = await person(accounts, role, username, Date.now());
    const a = await req('POST', '/api/v1/session/login', {}, { username, password: p.password });
    expect(await a.clone().json()).toEqual({ status: 'mfa_required' });
    const b = await req('POST', '/api/v1/session/mfa', { cookie: cookieOf(a, 'bary_mfa') }, { code: codeFor(p.secret, Date.now() + 30_000) });
    expect(b.status).toBe(200);
    return { cookie: cookieOf(b, 'bary_sid'), id: p.id, secret: p.secret };
  }
  const issue = (cookie: string, body: unknown): Promise<Response> => req('POST', '/api/v1/account/tokens', { cookie }, body);

  it('**개인 토큰 발급 → 그 값으로 읽기 → 폐기 → 401**', async () => {
    const op = await login('operator', 'op');
    const r = await issue(op.cookie, { name: 'ci-bot', role: 'operator', expiresInDays: 30 });
    expect(r.status, await r.clone().text()).toBe(201);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const out = await r.json() as { id: string; token: string; role: string; expiresAt: string };
    expect(out.token).toMatch(PERSONAL_TOKEN);
    // 그 토큰으로 읽는다
    expect((await req('GET', '/api/v1/config/head', bearer(out.token))).status).toBe(200);
    // 목록에는 값이 없다
    const list = await req('GET', '/api/v1/account/tokens', { cookie: op.cookie });
    expect(list.status).toBe(200);
    const text = await list.text();
    expect(text).toContain(out.id);
    expect(text).not.toContain(out.token.slice(-43));
    // 폐기 — 다음 요청부터 401
    const del = await req('DELETE', `/api/v1/account/tokens/${out.id}`, { cookie: op.cookie });
    expect(del.status).toBe(200);
    expect((await req('GET', '/api/v1/config/head', bearer(out.token))).status).toBe(401);
  });

  it('401 · 403 갈래 — 세션 없음, 토큰은 사람이 아니다, 역할 밖 경로', async () => {
    expect((await req('GET', '/api/v1/account/tokens', {})).status).toBe(401);
    // 파일 토큰은 사람이 아니다 — 내 토큰이 없다
    const f = await req('GET', '/api/v1/account/tokens', bearer(FILE_TOKEN));
    expect(f.status).toBe(404);
    expect((await f.json() as { code: string }).code).toBe('not_a_person');
    const op = await login('operator', 'op');
    const t = (await (await issue(op.cookie, { name: 'ci', role: 'operator' })).json() as { token: string }).token;
    // 개인 토큰도 사람 세션이 아니다 — `/me`·내 토큰 목록은 404
    expect((await req('GET', '/api/v1/me', bearer(t))).status).toBe(404);
    expect((await req('GET', '/api/v1/account/tokens', bearer(t))).status).toBe(404);
    // operator 토큰은 관리 경로에 403
    expect((await req('GET', '/api/v1/users', bearer(t))).status).toBe(403);
    // 모르는 bary_ 값은 401
    const fake = `bary_${randomBytes(8).toString('hex')}_${randomBytes(32).toString('base64url')}`;
    expect((await req('GET', '/api/v1/config/head', bearer(fake))).status).toBe(401);
  });

  it('**토큰으로 토큰을 못 만들고, 민감 작업은 토큰으로 못 한다**', async () => {
    const root = await login('admin', 'root');
    const t = (await (await issue(root.cookie, { name: 'adm', role: 'admin' })).json() as { token: string }).token;
    // 관리 읽기는 된다
    expect((await req('GET', '/api/v1/users', bearer(t))).status).toBe(200);
    // 발급은 사람 세션만 — 토큰으로는 403 token_not_allowed (민감 작업 게이트가 먼저)
    const again = await req('POST', '/api/v1/account/tokens', bearer(t), { name: 'x', role: 'auditor' });
    expect(again.status).toBe(403);
    expect((await again.json() as { code: string }).code).toBe('token_not_allowed');
    // 다른 민감 작업도 — 사람 admin 은 인증 앱을 다시 확인해야 하는 일이다
    const inv = await req('POST', '/api/v1/invitations', bearer(t), { role: 'auditor' });
    expect(inv.status).toBe(403);
    expect((await inv.json() as { code: string }).code).toBe('token_not_allowed');
    // 파일 토큰(비상 출입구)은 그대로 된다
    expect((await req('POST', '/api/v1/invitations', bearer(FILE_TOKEN), { role: 'auditor' })).status).toBe(200);
  });

  it('**발급 · 폐기는 step-up 이 필요하다**', async () => {
    const op = await login('operator', 'op');
    const t = (await (await issue(op.cookie, { name: 'ci', role: 'operator' })).json() as { id: string }).id;
    await db.query(byDialect(db, {
      postgres: `UPDATE sessions SET mfa_at = now() - interval '20 minutes'`,
      sqlite: `UPDATE sessions SET mfa_at = strftime('%Y-%m-%dT%H:%M:%fZ', now(), '-20 minutes')`,
    }));
    const a = await issue(op.cookie, { name: 'ci2', role: 'operator' });
    expect(a.status).toBe(403);
    expect((await a.json() as { code: string }).code).toBe('mfa_step_up_required');
    const d = await req('DELETE', `/api/v1/account/tokens/${t}`, { cookie: op.cookie });
    expect(d.status).toBe(403);
    expect((await d.json() as { code: string }).code).toBe('mfa_step_up_required');
    // 목록 보기는 민감 작업이 아니다
    expect((await req('GET', '/api/v1/account/tokens', { cookie: op.cookie })).status).toBe(200);
    // 인증 앱이 없는 사람은 발급하지 못한다(step-up 을 할 수 없다)
    const { token } = await accounts.invite({ role: 'operator' }, 'test');
    await accounts.acceptLink({ token, username: 'nomfa', password: 'operator-Pass-1x' });
    const l = await req('POST', '/api/v1/session/login', {}, { username: 'nomfa', password: 'operator-Pass-1x' });
    expect((await issue(cookieOf(l, 'bary_sid'), { name: 'x', role: 'auditor' })).status).toBe(403);
  });

  it('**operator 는 admin 토큰을 못 만들고, 만료 일수 0 · 366 은 거절**', async () => {
    const op = await login('operator', 'op');
    const adm = await issue(op.cookie, { name: 'x', role: 'admin' });
    expect(adm.status).toBe(403);
    expect((await adm.json() as { code: string }).code).toBe('role_exceeds_owner');
    for (const d of [0, 366]) {
      const r = await issue(op.cookie, { name: 'x', role: 'operator', expiresInDays: d });
      expect(r.status).toBe(400);
      expect((await r.json() as { code: string }).code).toBe('bad_expiry');
    }
    expect((await issue(op.cookie, { name: 'x', role: 'operator', expiresInDays: 365 })).status).toBe(201);
    expect((await issue(op.cookie, { name: 'bad name', role: 'operator' })).status).toBe(400);
  });

  it('**관리자는 남의 토큰을 보고 폐기한다** — 남의 토큰을 만들지는 못한다, operator 는 못 본다', async () => {
    const root = await login('admin', 'root');
    const op = await login('operator', 'op');
    const out = await (await issue(op.cookie, { name: 'ci', role: 'operator' })).json() as { id: string; token: string };
    expect((await req('GET', `/api/v1/users/${root.id}/tokens`, { cookie: op.cookie })).status).toBe(403);
    expect((await req('DELETE', `/api/v1/users/${op.id}/tokens/${out.id}`, { cookie: op.cookie })).status).toBe(403);
    const list = await req('GET', `/api/v1/users/${op.id}/tokens`, { cookie: root.cookie });
    expect(list.status).toBe(200);
    const rows = await list.json() as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual([out.id]);
    expect(JSON.stringify(rows)).not.toContain(out.token.slice(-43));
    // 주인이 아닌 id 로는 404
    expect((await req('DELETE', `/api/v1/users/${root.id}/tokens/${out.id}`, { cookie: root.cookie })).status).toBe(404);
    // 남을 위한 발급 경로는 없다
    expect([404, 405]).toContain((await req('POST', `/api/v1/users/${op.id}/tokens`, { cookie: root.cookie }, { name: 'x', role: 'auditor' })).status);
    const del = await req('DELETE', `/api/v1/users/${op.id}/tokens/${out.id}`, { cookie: root.cookie });
    expect(del.status).toBe(200);
    expect((await req('GET', '/api/v1/config/head', bearer(out.token))).status).toBe(401);
    const audit = await auditRows();
    expect(audit.at(-1)).toMatchObject({ action: 'account.token_revoke', actor: 'user:root', subject_user: op.id });
  });

  it('**파일 토큰이 먼저고, 틀린 개인 토큰은 지금처럼 실패로 센다 (429)**', async () => {
    expect((await req('GET', '/api/v1/config/head', bearer(FILE_TOKEN))).status).toBe(200);
    const fake = (): string => `bary_${randomBytes(8).toString('hex')}_${randomBytes(32).toString('base64url')}`;
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await req('GET', '/api/v1/config/head', bearer(fake()))).status);
    expect(codes.slice(0, 4)).toEqual([401, 401, 401, 401]);
    expect(codes.at(-1)).toBe(429);
  });

  it('**계정 PG 를 못 물으면 개인 토큰은 503 — 파일 토큰은 그대로 들어온다**', async () => {
    const op = await login('operator', 'op');
    const t = (await (await issue(op.cookie, { name: 'ci', role: 'operator' })).json() as { token: string }).token;
    await close();
    await serve(new AccountService({ db: new Db('postgres://postgres:bary@127.0.0.1:1/none'), sealer }));
    const r = await req('GET', '/api/v1/config/head', bearer(t));
    expect(r.status).toBe(503);
    expect((await r.json() as { code: string }).code).toBe('account_store_unavailable');
    expect((await req('GET', '/api/v1/config/head', bearer(FILE_TOKEN))).status).toBe(200);
  });
});
