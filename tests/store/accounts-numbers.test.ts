/**
 * 회원 공통 수치 1차 (2026-10-18 사용자 결정, orc 경유) — 실물 계정 PG.
 *
 * 비밀번호 규칙·해시 매개변수는 `tests/unit/accounts-crypto.test.ts` 가 잰다. 여기서는 **저장소와 문**에 걸린
 * 수치를 잰다: 세션 유휴 30분·절대 12시간, step-up 10분, TOTP 등록 24시간, 시도 제한(계정·IP, 인스턴스 공유,
 * 검증 전 차단), 감사 1년 보존, 옛 해시 재저장, 요청 본문 64 KiB.
 */
import { randomBytes, scrypt } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hashToken, TokenAuth } from '../../src/api/auth.js';
import { createApi } from '../../src/api/server.js';
import { ACCOUNT_MIGRATIONS } from '../../src/accounts/migrations.js';
import { Sealer } from '../../src/accounts/seal.js';
import { AccountService, SESSION_MAX_MS, STEP_UP_MAX_AGE_MS } from '../../src/accounts/service.js';
import { hotp, stepOf } from '../../src/accounts/totp.js';
import type { ConfigStore } from '../../src/store/config-store.js';
import type { ControlPlane } from '../../src/control/plane.js';
import type { LeaderElection } from '../../src/control/leader.js';
import { Db, dockerAvailable, pgFor, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('accounts-numbers');
const PASS = 'operator-pass-1';
let db: Db;
let accounts: AccountService;
const servers: Server[] = [];
const sealer = new Sealer(randomBytes(32).toString('base64'));

function codeFor(b32: string, at = Date.now()): string {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0; let v = 0; const out: number[] = [];
  for (const ch of b32) { v = (v << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } }
  return hotp(Buffer.from(out), stepOf(at));
}

/** 같은 계정 PG 를 쓰는 인스턴스 하나. 여러 번 부르면 DNS 다중 A 뒤의 여러 인스턴스가 된다. */
async function serve(): Promise<string> {
  const s = createApi({
    db: {} as Db,
    store: { head: async () => ({ revision: '1', etag: 'e1' }) } as unknown as ConfigStore,
    control: {} as ControlPlane,
    auth: new TokenAuth([{ name: 'ci', role: 'admin', hash: hashToken('machine-token-plain') }]),
    election: { state: { isLeader: true, reason: '' } } as unknown as LeaderElection,
    accounts: new AccountService({ db, sealer }),
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const cookieOf = (r: Response, name: string): string =>
  (r.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? '').split(';', 1)[0]!;

async function operator(username = 'op'): Promise<string> {
  const { token } = await accounts.invite({ role: 'operator' }, 'test');
  const { userId } = await accounts.acceptLink({ token, username, password: PASS });
  return userId;
}

/** 인증 앱을 등록한 operator. 비밀(base32)을 돌려준다. */
async function withTotp(username = 'mfa'): Promise<{ userId: string; secret: string }> {
  const userId = await operator(username);
  const { secret } = await accounts.beginTotp(userId, username);
  await accounts.confirmTotp(userId, codeFor(secret, Date.now() - 30_000));
  return { userId, secret };
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
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

describe('세션 — 유휴 30분 · 절대 12시간', () => {
  it('**30분 동안 요청이 없으면 끝난다** — 29분이면 산다', async () => {
    const A = await serve();
    await operator();
    const r = await post(A, '/api/v1/session/login', { username: 'op', password: PASS });
    expect(r.status).toBe(200);
    // 절대 상한은 쿠키에도 실린다
    expect(r.headers.getSetCookie().find((c) => c.startsWith('bary_sid='))).toMatch(/Max-Age=43200/i);
    expect(SESSION_MAX_MS).toBe(12 * 3600_000);
    const cookie = cookieOf(r, 'bary_sid');
    await db.query(`UPDATE sessions SET last_seen_at = now() - interval '29 minutes'`);
    expect((await fetch(`${A}/api/v1/me`, { headers: { cookie } })).status).toBe(200);
    await db.query(`UPDATE sessions SET last_seen_at = now() - interval '31 minutes'`);
    expect((await fetch(`${A}/api/v1/me`, { headers: { cookie } })).status).toBe(401);
  });
});

describe('MFA 최근성 10분 · TOTP 등록 24시간', () => {
  it('step-up 최근성은 10분이다', () => {
    expect(STEP_UP_MAX_AGE_MS).toBe(10 * 60_000);
  });

  it('**미확인 등록은 24시간 뒤 확인할 수 없다**', async () => {
    const userId = await operator();
    const { secret } = await accounts.beginTotp(userId, 'op');
    await db.query(`UPDATE mfa_totp SET created_at = now() - interval '25 hours'`);
    await expect(accounts.confirmTotp(userId, codeFor(secret))).rejects.toMatchObject({ code: 'totp_setup_expired' });
    // 다시 시작하면 된다
    const again = await accounts.beginTotp(userId, 'op');
    await expect(accounts.confirmTotp(userId, codeFor(again.secret))).resolves.toHaveLength(10);
  });
});

describe('시도 제한 — 계정·IP, 공용 저장소, 영구 잠금 없음', () => {
  it('**IP 제한은 인스턴스를 가리지 않고, 막힌 동안은 맞는 비밀번호도 보지 않는다**', async () => {
    const A = await serve();
    const B = await serve();
    await operator();
    // 없는 계정 다섯 번(계정 잠금과 무관하게 IP 만 센다) — 인스턴스 A
    for (let i = 0; i < 4; i++) expect((await post(A, '/api/v1/session/login', { username: `nobody${i}`, password: 'x' })).status).toBe(401);
    const fifth = await post(A, '/api/v1/session/login', { username: 'nobody4', password: 'x' });
    expect(fifth.status).toBe(429);
    expect(Number(fifth.headers.get('retry-after'))).toBe(1); // 시작 1초
    // 첫 지연은 1초라 느린 CI 에서 풀릴 수 있다 — 막힘을 늘려 「검증 전 차단」만 잰다
    await db.query(`UPDATE auth_throttle SET blocked_until = now() + interval '1 minute'`);
    // 인스턴스 B 에서 **맞는** 비밀번호 — 그래도 429 (프로세스마다 따로 세지 않는다, 검증 전에 막는다)
    const ok = await post(B, '/api/v1/session/login', { username: 'op', password: PASS });
    expect(ok.status).toBe(429);
    // 막힘이 풀리면 된다 — 영구 잠금이 아니다
    await db.query(`UPDATE auth_throttle SET blocked_until = now() - interval '1 second'`);
    expect((await post(B, '/api/v1/session/login', { username: 'op', password: PASS })).status).toBe(200);
  });

  it('**인증 코드 실패도 계정 잠금에 걸린다** — 5번째부터 맞는 코드도 거절, 풀리면 된다', async () => {
    const { secret } = await withTotp();
    const wrong = async (): Promise<string> => {
      const r = await accounts.login('mfa', PASS);
      expect(r.kind).toBe('mfa');
      return (r as { sessionId: string }).sessionId;
    };
    for (let i = 0; i < 5; i++) {
      expect((await accounts.completeMfa(await wrong(), '000000')).kind).toBe('denied');
    }
    const locked = (await db.query(`SELECT failed_logins, locked_until FROM users WHERE username='mfa'`)).rows[0]!;
    expect(Number(locked['failed_logins'])).toBe(5);
    expect(locked['locked_until']).not.toBeNull();
    await db.query(`UPDATE users SET locked_until = now() + interval '1 minute'`);
    // 잠긴 동안은 비밀번호 단계부터 거절
    expect((await accounts.login('mfa', PASS)).kind).toBe('denied');
    await db.query(`UPDATE users SET locked_until = now() - interval '1 second'`);
    const pending = await wrong();
    expect((await accounts.completeMfa(pending, codeFor(secret, Date.now() + 30_000))).kind).toBe('session');
    expect(Number((await db.query(`SELECT failed_logins FROM users WHERE username='mfa'`)).rows[0]!['failed_logins'])).toBe(0);
  });

  it('지연은 지수로 는다 — 1초, 2초, 4초 … 최대 15분, 마지막 실패 뒤 15분이면 처음부터', async () => {
    const at = async (): Promise<number> => {
      const r = (await db.query(`SELECT extract(epoch from blocked_until - last_failure_at)::int AS s FROM auth_throttle WHERE key='t'`)).rows[0]!;
      return Number(r['s']);
    };
    for (let i = 0; i < 4; i++) expect(await accounts.throttleFail('t')).toBeUndefined();
    expect(await accounts.throttleFail('t')).toBe(1);
    expect(await at()).toBe(1);
    expect(await accounts.throttleFail('t')).toBe(2);
    expect(await accounts.throttleFail('t')).toBe(4);
    for (let i = 0; i < 10; i++) await accounts.throttleFail('t');
    expect(await accounts.throttleFail('t')).toBe(900);
    // 마지막 실패 뒤 15분이 지나면 처음부터
    await db.query(`UPDATE auth_throttle SET last_failure_at = now() - interval '16 minutes'`);
    expect(await accounts.throttleFail('t')).toBeUndefined();
  });

  it('계정 계수도 마지막 실패 뒤 15분이 지나면 처음부터 센다', async () => {
    await operator();
    for (let i = 0; i < 4; i++) expect((await accounts.login('op', 'wrong-Pass-1')).kind).toBe('denied');
    await db.query(`UPDATE users SET last_failed_at = now() - interval '16 minutes'`);
    expect((await accounts.login('op', 'wrong-Pass-1')).kind).toBe('denied');
    const u = (await db.query(`SELECT failed_logins, locked_until FROM users WHERE username='op'`)).rows[0]!;
    expect(Number(u['failed_logins'])).toBe(1);
    expect(u['locked_until']).toBeNull();
  });
});

describe('보존 · 재해시 · 본문 상한', () => {
  it('**감사 기록은 1년 보존** — 그보다 오래된 것만 지운다', async () => {
    await db.query(`INSERT INTO account_audit (at, actor, action) VALUES (now() - interval '366 days', 'x', 'old'), (now() - interval '364 days', 'x', 'young')`);
    expect(await accounts.purgeExpired()).toEqual({ audit: 1 });
    const left = (await db.query(`SELECT action FROM account_audit WHERE actor='x'`)).rows.map((r) => r['action']);
    expect(left).toEqual(['young']);
  });

  it('**옛 매개변수 해시는 로그인 성공 때 새 값(N=2^16·r=8·p=2)으로 다시 저장된다**', async () => {
    await operator();
    const salt = Buffer.alloc(16, 3);
    const key = await new Promise<Buffer>((res, rej) => scrypt(PASS, salt, 64, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 << 20 }, (e, k) => (e ? rej(e) : res(k))));
    await db.query(`UPDATE users SET password_hash=$1 WHERE username='op'`, [`scrypt$15$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`]);
    expect((await accounts.login('op', PASS)).kind).toBe('session');
    const h = String((await db.query(`SELECT password_hash FROM users WHERE username='op'`)).rows[0]!['password_hash']);
    expect(h).toMatch(/^scrypt\$16\$8\$2\$/);
  });

  it('**로그인·재설정 본문은 64 KiB 까지** — 비밀번호 최대 길이 대신', async () => {
    const A = await serve();
    await operator();
    const big = JSON.stringify({ username: 'op', password: 'Aa1'.repeat(23_000) });
    expect(big.length).toBeGreaterThan(64 * 1024);
    expect((await post(A, '/api/v1/session/login', big)).status).toBe(413);
    expect((await post(A, '/api/v1/account/password-reset/confirm', JSON.stringify({ token: 'x', password: 'Aa1'.repeat(23_000) }))).status).toBe(413);
    // 64 KiB 안의 긴 비밀번호는 규칙상 받아 준다(최대 길이 없음)
    const long = `Aa1${'x'.repeat(10_000)}`;
    const { token } = await accounts.invite({ role: 'auditor' }, 'test');
    await expect(accounts.acceptLink({ token, username: 'longpw', password: long })).resolves.toMatchObject({ userId: expect.any(String) });
  });
});
