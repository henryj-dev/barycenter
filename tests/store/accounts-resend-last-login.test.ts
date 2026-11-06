/**
 * 초대 다시 보내기 · 마지막 로그인 (#126 사람 화면 시안) — 실물 PG.
 *
 * 재는 것: 다시 보내면 **옛 링크가 죽고** 새 링크가 산다, 만료는 새로 시작한다, 쓰인·취소된 초대는 못 다시 보낸다,
 * 전달은 만들 때와 같다(메일 · 아니면 응답의 링크), 계정 감사에 남는다(비밀 없이).
 * 마지막 로그인은 **쓸 수 있는 세션이 생길 때만** 적힌다 — 실패·MFA 대기는 적지 않는다. 비밀번호·MFA·SSO 모두.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Mailer } from '../../src/accounts/mail.js';
import { ACCOUNT_MIGRATIONS } from '../../src/accounts/migrations.js';
import { Sealer } from '../../src/accounts/seal.js';
import { AccountService } from '../../src/accounts/service.js';
import { hotp, stepOf } from '../../src/accounts/totp.js';
import { Db, dockerAvailable, pgFor, startPg, stopPg, freshSchema } from './pg-fixture.js';

const PG = pgFor('accounts-resend');
let db: Db;
// 만료 비교 일부는 DB 의 now() 로 한다 — 지금 시각에서 시작하고 앞으로만 민다.
let clock = Date.now();
const sealer = new Sealer(randomBytes(32).toString('base64'));
let outbox: { to: string; text: string }[] = [];
const mailer: Mailer = { send: async (to, _subject, text) => { outbox.push({ to, text }); } };
const svc = (withMail = false): AccountService => new AccountService({
  db, sealer, now: () => clock, ...(withMail ? { mailer, publicUrl: 'https://bary.test' } : {}),
});
const tokenIn = (text: string): string => /\/invite#([\w-]+)/.exec(text)![1]!;

function codeFor(b32: string, at = clock): string {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0; let v = 0; const out: number[] = [];
  for (const ch of b32) { v = (v << 5) | A.indexOf(ch); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } }
  return hotp(Buffer.from(out), stepOf(at));
}

/** 밀리초까지 — 문자열로 바꾸면 초 아래가 잘린다. 없으면 null. */
const lastLogin = async (userId: string): Promise<number | null> => {
  const v = (await db.query('SELECT last_login_at FROM users WHERE id=$1', [userId])).rows[0]!['last_login_at'];
  return v === null ? null : (v as Date).getTime();
};

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 이 스위트는 실물 PG 를 쓴다');
  startPg(PG);
  db = new Db(PG.dsn);
}, 180_000);

afterAll(async () => { await db?.close(); stopPg(PG); });

beforeEach(async () => {
  await freshSchema(db);
  await db.migrate(ACCOUNT_MIGRATIONS);
  outbox = [];
  clock = Date.now();
});

describe('초대 다시 보내기', () => {
  it('**옛 링크는 죽고 새 링크가 산다** — 같은 초대 행, 감사에 남는다', async () => {
    const s = svc();
    const first = await s.invite({ role: 'operator', email: 'op@example.com' }, 'user:root');
    const again = await s.resendInvitation(first.id, 'user:root', { ip: '10.0.0.9' });
    expect(again.id).toBe(first.id);
    expect(again.token).not.toBe(first.token);
    expect(again.mailed).toBe(false);
    await expect(s.previewLink(first.token)).rejects.toMatchObject({ code: 'link_invalid' });
    await expect(s.acceptLink({ token: first.token, username: 'op', password: 'operator-pass-1' }))
      .rejects.toMatchObject({ code: 'link_invalid' });
    expect(await s.previewLink(again.token)).toMatchObject({ kind: 'invite', role: 'operator', email: 'op@example.com' });
    await s.acceptLink({ token: again.token, username: 'op', password: 'operator-pass-1' });

    const audit = (await db.query(`SELECT actor, ip, detail FROM account_audit WHERE action='account.invite_resend'`)).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: 'user:root', ip: '10.0.0.9', detail: { id: first.id, role: 'operator', email: true } });
    // 비밀(토큰)은 어떤 형태로도 싣지 않는다.
    expect(JSON.stringify(audit)).not.toContain(again.token);
    expect(JSON.stringify(audit)).not.toContain(first.token);
  });

  it('**만료된 초대도 다시 보낸다** — 만료는 지금부터 다시 72시간', async () => {
    const s = svc();
    const first = await s.invite({ role: 'auditor' }, 'user:root');
    clock += 73 * 3600_000;
    await expect(s.previewLink(first.token)).rejects.toMatchObject({ code: 'link_invalid' });
    const again = await s.resendInvitation(first.id, 'user:root');
    expect(Date.parse(again.expiresAt)).toBe(clock + 72 * 3600_000);
    expect((await s.previewLink(again.token)).role).toBe('auditor');
  });

  it('쓰인·취소된·없는 초대는 404 — 다시 살리지 않는다', async () => {
    const s = svc();
    const used = await s.invite({ role: 'auditor' }, 'user:root');
    await s.acceptLink({ token: used.token, username: 'aud', password: 'auditor-pass-1' });
    await expect(s.resendInvitation(used.id, 'user:root')).rejects.toMatchObject({ status: 404, code: 'no_invitation' });
    const revoked = await s.invite({ role: 'auditor' }, 'user:root');
    await s.revokeInvitation(revoked.id, 'user:root');
    await expect(s.resendInvitation(revoked.id, 'user:root')).rejects.toMatchObject({ code: 'no_invitation' });
    await expect(s.previewLink(revoked.token)).rejects.toMatchObject({ code: 'link_invalid' });
    await expect(s.resendInvitation('00000000-0000-0000-0000-000000000000', 'user:root')).rejects.toMatchObject({ code: 'no_invitation' });
  });

  it('bootstrap 링크는 다시 보내지 않는다 — 첫 관리자 링크는 호스트 CLI 의 일이다', async () => {
    const s = svc();
    await s.bootstrap('cli');
    const id = String((await db.query(`SELECT id FROM invitations WHERE kind='bootstrap'`)).rows[0]!['id']);
    await expect(s.resendInvitation(id, 'user:root')).rejects.toMatchObject({ code: 'no_invitation' });
  });

  it('메일이 켜져 있으면 **새 링크를 메일로** 보낸다 — 옛 링크가 아니다', async () => {
    const s = svc(true);
    const first = await s.invite({ role: 'operator', email: 'op@example.com' }, 'user:root');
    expect(first.mailed).toBe(true);
    const again = await s.resendInvitation(first.id, 'user:root');
    expect(again.mailed).toBe(true);
    expect(outbox).toHaveLength(2);
    expect(outbox[1]!.to).toBe('op@example.com');
    expect(tokenIn(outbox[1]!.text)).toBe(again.token);
    await expect(s.previewLink(tokenIn(outbox[0]!.text))).rejects.toMatchObject({ code: 'link_invalid' });
  });
});

describe('마지막 로그인', () => {
  it('**비밀번호 로그인이 세션이 되면 적고**, 틀린 비밀번호는 적지 않는다', async () => {
    const s = svc();
    const { token } = await s.invite({ role: 'operator' }, 'test');
    const { userId } = await s.acceptLink({ token, username: 'op', password: 'operator-pass-1' });
    expect(await lastLogin(userId)).toBeNull();
    expect((await s.login('op', 'wrong-password-1')).kind).toBe('denied');
    expect(await lastLogin(userId)).toBeNull();
    expect((await s.login('op', 'operator-pass-1')).kind).toBe('session');
    expect(await lastLogin(userId)).toBe(clock);
    const row = (await s.listUsers()).find((u) => (u as { id: string }).id === userId);
    // 목록의 시각은 다른 시각 열과 같은 변환을 거친다(초 단위).
    expect(row).toMatchObject({ lastLoginAt: new Date(Math.floor(clock / 1000) * 1000).toISOString() });
  });

  it('**MFA 대기는 로그인이 아니다** — 코드가 틀려도 안 적고, 맞으면 그때 적는다', async () => {
    const s = svc();
    const t = await s.bootstrap('cli');
    const p = await s.previewLink(t);
    const { userId } = await s.acceptLink({ token: t, username: 'root', password: 'admin-password-1', totp: { secret: p.totp!.secret, code: codeFor(p.totp!.secret) } });
    const a = await s.login('root', 'admin-password-1');
    expect(a.kind).toBe('mfa');
    expect(await lastLogin(userId)).toBeNull();
    clock += 30_000;
    expect((await s.completeMfa((a as { sessionId: string }).sessionId, '000000')).kind).toBe('denied');
    expect(await lastLogin(userId)).toBeNull();
    clock += 30_000;
    expect((await s.completeMfa((a as { sessionId: string }).sessionId, codeFor(p.totp!.secret))).kind).toBe('session');
    expect(await lastLogin(userId)).toBe(clock);
  });

  it('SSO 로그인이 세션이 되면 적는다', async () => {
    const s = svc();
    const iss = 'https://idp.example.com';
    await s.setProviderJit(iss, true, 'test');
    const out = await s.completeSso('login', null, { iss, sub: 'sub-1', preferredUsername: 'kim' });
    expect(out.kind).toBe('session');
    const id = String((await db.query(`SELECT user_id FROM user_identities WHERE subject='sub-1'`)).rows[0]!['user_id']);
    expect(await lastLogin(id)).toBe(clock);
  });
});
