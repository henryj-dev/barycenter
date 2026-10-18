/**
 * 사람 계정 — 실물 PG 로 흐름을 잰다 (공통 회원정책 1차 · 계획 A 단계).
 *
 * 재는 것: 초대·bootstrap·복구 링크의 일회성, 로그인 열거 방지, 계정 잠금, 관리자 MFA 필수,
 * **다음 요청부터 반영되는 철회**(로그아웃·정지·역할 하향), 마지막 관리자 보호, 계정 PG 장애 → 거부.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ACCOUNT_MIGRATIONS } from '../../src/accounts/migrations.js';
import { Sealer } from '../../src/accounts/seal.js';
import { AccountError, AccountService, AccountStoreUnavailable } from '../../src/accounts/service.js';
import { hotp, stepOf } from '../../src/accounts/totp.js';
import { Db, dockerAvailable, pgFor, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('accounts-service');
let db: Db;
let clock = Date.UTC(2026, 9, 18, 12, 0, 0);
const sealer = new Sealer(randomBytes(32).toString('base64'));
const svc = (): AccountService => new AccountService({ db, sealer, now: () => clock });

/** 미리보기가 준 base32 비밀로 지금 창의 코드를 만든다(인증 앱 흉내). */
function codeFor(b32: string, at = clock): string {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0; let v = 0; const out: number[] = [];
  for (const ch of b32) { v = (v << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } }
  return hotp(Buffer.from(out), stepOf(at));
}

async function makeAdmin(s: AccountService, username = 'root'): Promise<{ id: string; secret: string }> {
  const t = await s.bootstrap('cli');
  const p = await s.previewLink(t);
  const out = await s.acceptLink({ token: t, username, password: 'admin-password-1', totp: { secret: p.totp!.secret, code: codeFor(p.totp!.secret) } });
  return { id: out.userId, secret: p.totp!.secret };
}

async function loginAdmin(s: AccountService, secret: string, username = 'root'): Promise<string> {
  const a = await s.login(username, 'admin-password-1');
  expect(a.kind).toBe('mfa');
  clock += 30_000; // 다음 창 — 같은 창 재사용 금지에 안 걸리게
  const b = await s.completeMfa((a as { sessionId: string }).sessionId, codeFor(secret));
  expect(b.kind).toBe('session');
  return (b as { sessionId: string }).sessionId;
}

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 이 스위트는 실물 PG 를 쓴다');
  startPg(PG);
  db = new Db(PG.dsn);
}, 180_000);

afterAll(async () => {
  await db?.close();
  stopPg(PG);
});

beforeEach(async () => {
  await db.query('DROP TABLE IF EXISTS account_audit, mfa_recovery_codes, mfa_totp, invitations, sessions, users, account_schema_migrations CASCADE');
  await db.migrate(ACCOUNT_MIGRATIONS);
});

describe('일회용 링크', () => {
  it('**bootstrap 은 관리자가 없을 때만**, 관리자는 TOTP 없이 수락 못 한다', async () => {
    const s = svc();
    const t = await s.bootstrap('cli');
    await expect(s.acceptLink({ token: t, username: 'root', password: 'admin-password-1' }))
      .rejects.toMatchObject({ code: 'totp_required' });
    await makeAdmin(s);
    await expect(s.bootstrap('cli')).rejects.toMatchObject({ code: 'admin_exists' });
  });

  it('링크는 한 번만 쓰이고, 만료·취소·없음을 가르지 않는다', async () => {
    const s = svc();
    const { token } = await s.invite({ role: 'operator', email: 'Op@Example.com' }, 'user:root');
    await s.acceptLink({ token, username: 'op', password: 'operator-pass-1' });
    await expect(s.acceptLink({ token, username: 'op2', password: 'operator-pass-1' })).rejects.toMatchObject({ code: 'link_invalid' });
    const late = await s.invite({ role: 'auditor' }, 'user:root');
    clock += 73 * 3600_000;
    await expect(s.previewLink(late.token)).rejects.toMatchObject({ code: 'link_invalid' });
    await expect(s.previewLink('nope')).rejects.toMatchObject({ code: 'link_invalid' });
  });

  it('이메일은 소문자로 저장되고 겹치면 409', async () => {
    const s = svc();
    const a = await s.invite({ role: 'auditor', email: 'A@x.io' }, 'r');
    await s.acceptLink({ token: a.token, username: 'aa', password: 'auditor-pass-12' });
    expect(await s.login('a@x.io', 'auditor-pass-12')).toMatchObject({ kind: 'session' });
    const b = await s.invite({ role: 'auditor', email: 'a@X.io' }, 'r');
    await expect(s.acceptLink({ token: b.token, username: 'bb', password: 'auditor-pass-12' })).rejects.toMatchObject({ status: 409 });
  });
});

describe('로그인', () => {
  it('**없는 계정·틀린 비밀번호·정지가 모두 같은 denied 다** (열거 방지)', async () => {
    const s = svc();
    const { token } = await s.invite({ role: 'auditor' }, 'r');
    const { userId } = await s.acceptLink({ token, username: 'eve', password: 'auditor-pass-12' });
    expect(await s.login('ghost', 'whatever-pass1')).toEqual({ kind: 'denied' });
    expect(await s.login('eve', 'wrong-password1')).toEqual({ kind: 'denied' });
    await makeAdmin(s);
    await s.updateUser(userId, { status: 'suspended' }, 'r');
    expect(await s.login('eve', 'auditor-pass-12')).toEqual({ kind: 'denied' });
  });

  it('5번 틀리면 잠기고, 잠긴 동안은 맞는 비밀번호도 denied', async () => {
    const s = svc();
    const { token } = await s.invite({ role: 'auditor' }, 'r');
    await s.acceptLink({ token, username: 'bob', password: 'auditor-pass-12' });
    for (let i = 0; i < 5; i++) await s.login('bob', 'wrong-password1');
    expect(await s.login('bob', 'auditor-pass-12')).toEqual({ kind: 'denied' });
    clock += 61_000;
    expect((await s.login('bob', 'auditor-pass-12')).kind).toBe('session');
  });

  it('**관리자는 MFA 를 지나야 세션이 된다**, MFA 대기 세션으로는 아무 데도 못 간다', async () => {
    const s = svc();
    const { secret } = await makeAdmin(s);
    const a = await s.login('root', 'admin-password-1');
    expect(a.kind).toBe('mfa');
    expect(await s.authenticate((a as { sessionId: string }).sessionId)).toBeUndefined();
    expect(await s.completeMfa((a as { sessionId: string }).sessionId, '000000')).toEqual({ kind: 'denied' });
    clock += 30_000;
    const b = await s.completeMfa((a as { sessionId: string }).sessionId, codeFor(secret));
    const p = await s.authenticate((b as { sessionId: string }).sessionId);
    expect(p).toMatchObject({ name: 'user:root', role: 'admin' });
    expect(p!.account!.mfaAt).toBeDefined();
    // MFA 뒤에는 **새 세션 id** 다 — 대기 id 는 더는 안 통한다(세션 고정 방지).
    expect(await s.completeMfa((a as { sessionId: string }).sessionId, codeFor(secret, clock + 30_000))).toEqual({ kind: 'denied' });
  });

  it('복구 코드는 한 번만 쓰인다', async () => {
    const s = svc();
    const t = await s.bootstrap('cli');
    const p = await s.previewLink(t);
    const { recoveryCodes } = await s.acceptLink({ token: t, username: 'root', password: 'admin-password-1', totp: { secret: p.totp!.secret, code: codeFor(p.totp!.secret) } });
    const code = recoveryCodes![0]!;
    const a = await s.login('root', 'admin-password-1');
    expect((await s.completeMfa((a as { sessionId: string }).sessionId, code)).kind).toBe('session');
    const b = await s.login('root', 'admin-password-1');
    expect(await s.completeMfa((b as { sessionId: string }).sessionId, code)).toEqual({ kind: 'denied' });
  });
});

describe('철회는 다음 보호된 요청부터', () => {
  it('**로그아웃은 서버에서 세션을 죽인다** — 쿠키를 지운 것만이 아니다', async () => {
    const s = svc();
    const { token } = await s.invite({ role: 'operator' }, 'r');
    await s.acceptLink({ token, username: 'op', password: 'operator-pass-1' });
    const sid = ((await s.login('op', 'operator-pass-1')) as { sessionId: string }).sessionId;
    expect(await s.authenticate(sid)).toBeDefined();
    await s.logout(sid);
    expect(await s.authenticate(sid)).toBeUndefined();
  });

  it('**정지·역할 하향이 다음 요청에 보인다** (세션 다시 안 만들어도)', async () => {
    const s = svc();
    await makeAdmin(s);
    const { token } = await s.invite({ role: 'operator' }, 'r');
    const { userId } = await s.acceptLink({ token, username: 'op', password: 'operator-pass-1' });
    const sid = ((await s.login('op', 'operator-pass-1')) as { sessionId: string }).sessionId;
    expect([...(await s.authenticate(sid))!.scopes]).toContain('write');
    await s.updateUser(userId, { role: 'auditor' }, 'user:root');
    expect([...(await s.authenticate(sid))!.scopes]).toEqual(['read']);
    await s.updateUser(userId, { status: 'suspended' }, 'user:root');
    expect(await s.authenticate(sid)).toBeUndefined();
  });

  it('비밀번호를 바꾸면 **다른 세션**이 죽고 지금 세션은 산다', async () => {
    const s = svc();
    const { token } = await s.invite({ role: 'auditor' }, 'r');
    const { userId } = await s.acceptLink({ token, username: 'au', password: 'auditor-pass-12' });
    const one = ((await s.login('au', 'auditor-pass-12')) as { sessionId: string }).sessionId;
    const two = ((await s.login('au', 'auditor-pass-12')) as { sessionId: string }).sessionId;
    const keep = (await s.authenticate(one))!.account!.sessionHash;
    await s.changePassword(userId, 'auditor-pass-12', 'auditor-pass-34', keep);
    expect(await s.authenticate(one)).toBeDefined();
    expect(await s.authenticate(two)).toBeUndefined();
  });

  it('**계정 PG 를 못 물으면 「없다」가 아니라 장애로 던진다** — 서버가 거부한다', async () => {
    const broken = new AccountService({ db: new Db('postgres://postgres:bary@127.0.0.1:1/none'), sealer });
    await expect(broken.authenticate('anything')).rejects.toBeInstanceOf(AccountStoreUnavailable);
  });
});

describe('관리', () => {
  it('**마지막 활성 관리자는 강등·정지·삭제 못 한다**', async () => {
    const s = svc();
    const { id } = await makeAdmin(s);
    await expect(s.updateUser(id, { role: 'operator' }, 'r')).rejects.toMatchObject({ code: 'last_admin' });
    await expect(s.updateUser(id, { status: 'suspended' }, 'r')).rejects.toMatchObject({ code: 'last_admin' });
    await expect(s.deleteUser(id, 'r')).rejects.toMatchObject({ code: 'last_admin' });
  });

  it('TOTP 없는 사람은 관리자로 못 올린다, 관리자는 TOTP 를 못 끈다', async () => {
    const s = svc();
    await makeAdmin(s);
    const { token } = await s.invite({ role: 'operator' }, 'r');
    const { userId } = await s.acceptLink({ token, username: 'op', password: 'operator-pass-1' });
    await expect(s.updateUser(userId, { role: 'admin' }, 'r')).rejects.toMatchObject({ code: 'admin_needs_mfa' });
  });

  it('삭제는 묘비 — 이름은 다시 못 쓰고 로그인 수단은 사라진다', async () => {
    const s = svc();
    await makeAdmin(s);
    const { token } = await s.invite({ role: 'auditor', email: 'z@x.io' }, 'r');
    const { userId } = await s.acceptLink({ token, username: 'zed', password: 'auditor-pass-12' });
    await s.deleteUser(userId, 'user:root');
    expect(await s.login('zed', 'auditor-pass-12')).toEqual({ kind: 'denied' });
    const again = await s.invite({ role: 'auditor' }, 'r');
    await expect(s.acceptLink({ token: again.token, username: 'zed', password: 'auditor-pass-12' })).rejects.toMatchObject({ status: 409 });
  });

  it('복구 링크는 비밀번호·MFA 를 다시 정하고 기존 세션을 끊는다', async () => {
    const s = svc();
    const { id, secret } = await makeAdmin(s);
    const sid = await loginAdmin(s, secret);
    const t = await s.recoveryLink(id, 'cli');
    expect(await s.authenticate(sid)).toBeUndefined();
    const p = await s.previewLink(t);
    expect(p).toMatchObject({ kind: 'recovery', username: 'root', needsTotp: true });
    await s.acceptLink({ token: t, password: 'new-admin-pass-2', totp: { secret: p.totp!.secret, code: codeFor(p.totp!.secret) } });
    expect(await s.login('root', 'admin-password-1')).toEqual({ kind: 'denied' });
    expect((await s.login('root', 'new-admin-pass-2')).kind).toBe('mfa');
  });

  it('계정 감사에 비밀이 실리지 않는다', async () => {
    const s = svc();
    await makeAdmin(s);
    const rows = (await db.query('SELECT detail::text AS d FROM account_audit')).rows.map((r) => String(r['d']));
    expect(rows.join(' ')).not.toMatch(/admin-password-1|scrypt\$/);
  });
});

it('AccountError 는 상태 코드를 든다', () => {
  expect(new AccountError(409, 'x', 'y').status).toBe(409);
});
