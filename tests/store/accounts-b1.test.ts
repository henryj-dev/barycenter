/**
 * 계정 B1 — 메일 링크·민감 작업 step-up·열린 스트림의 세션 확인 (실물 PG).
 *
 * 메일은 가짜 우편함으로 받는다. 재는 것: 재설정은 **늘 조용하고**(열거 방지) **MFA 를 풀지 않는다**,
 * 이메일은 새 주소에서 확인해야 바뀐다, 초대 메일은 커밋 뒤에 간다, step-up 은 세션의 MFA 시각만 새로 찍는다.
 */
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { TokenAuth } from '../../src/api/auth.js';
import { createApi } from '../../src/api/server.js';
import type { Mailer } from '../../src/accounts/mail.js';
import { ACCOUNT_MIGRATIONS } from '../../src/accounts/migrations.js';
import { Sealer } from '../../src/accounts/seal.js';
import { AccountService } from '../../src/accounts/service.js';
import { hotp, stepOf } from '../../src/accounts/totp.js';
import type { ConfigStore } from '../../src/store/config-store.js';
import type { ControlPlane } from '../../src/control/plane.js';
import type { LeaderElection } from '../../src/control/leader.js';
import { Db, dockerAvailable, pgFor, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('accounts-b1');
let db: Db;
// **지금 시각에서 시작한다.** 만료 비교는 DB 의 now() 로 하므로, 고정 날짜를 쓰면 실제 시각이 그 날짜를 지나는
// 순간(예: MFA 대기 5분) 테스트가 깨진다 — 2026-10-18 12:05 UTC 이후 CI 에서 실제로 그렇게 깨졌다.
// 시간창 재사용 거절을 피하려고 테스트 안에서는 앞으로만 민다.
let clock = Date.now();
const sealer = new Sealer(randomBytes(32).toString('base64'));
let outbox: { to: string; subject: string; text: string }[] = [];
const mailer: Mailer = { send: async (to, subject, text) => { outbox.push({ to, subject, text }); } };
const svc = (withMail = true): AccountService => new AccountService({
  db, sealer, now: () => clock, ...(withMail ? { mailer, publicUrl: 'https://bary.test' } : {}),
});
const tokenIn = (text: string, page: string): string => new RegExp(`/${page}#([\\w-]+)`).exec(text)![1]!;

function codeFor(b32: string, at = clock): string {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0; let v = 0; const out: number[] = [];
  for (const ch of b32) { v = (v << 5) | A.indexOf(ch); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } }
  return hotp(Buffer.from(out), stepOf(at));
}

async function admin(s: AccountService): Promise<{ id: string; secret: string; sid: string }> {
  const t = await s.bootstrap('cli');
  const p = await s.previewLink(t);
  const { userId } = await s.acceptLink({ token: t, username: 'root', password: 'admin-password-1', totp: { secret: p.totp!.secret, code: codeFor(p.totp!.secret) } });
  await db.query(`UPDATE users SET email='root@x.io' WHERE id=$1`, [userId]);
  const a = await s.login('root', 'admin-password-1');
  clock += 30_000;
  const b = await s.completeMfa((a as { sessionId: string }).sessionId, codeFor(p.totp!.secret));
  return { id: userId, secret: p.totp!.secret, sid: (b as { sessionId: string }).sessionId };
}

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 이 스위트는 실물 PG 를 쓴다');
  startPg(PG);
  db = new Db(PG.dsn);
}, 180_000);
afterAll(async () => { await db?.close(); stopPg(PG); });
beforeEach(async () => {
  outbox = [];
  // 테이블을 나열하지 않는다 — 마이그레이션이 늘 때마다 빠진 이름이 다음 스위트를 깨뜨린다.
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await db.migrate(ACCOUNT_MIGRATIONS);
});

describe('비밀번호 재설정', () => {
  it('**없는 주소도 같은 결과다** — 메일만 안 간다', async () => {
    const s = svc();
    await admin(s);
    await expect(s.requestPasswordReset('nobody@x.io')).resolves.toBeUndefined();
    expect(outbox).toHaveLength(0);
    await s.requestPasswordReset('ROOT@x.io');
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.text).not.toMatch(/root|admin/i);
  });

  it('5분 안에 다시 요청하면 메일을 또 보내지 않는다', async () => {
    const s = svc();
    await admin(s);
    await s.requestPasswordReset('root@x.io');
    await s.requestPasswordReset('root@x.io');
    expect(outbox).toHaveLength(1);
    clock += 5 * 60_000 + 1;
    await s.requestPasswordReset('root@x.io');
    expect(outbox).toHaveLength(2);
  });

  it('**재설정은 MFA 를 풀지 않고**, 세션을 끊고, 링크는 한 번만', async () => {
    const s = svc();
    const a = await admin(s);
    await s.requestPasswordReset('root@x.io');
    const t = tokenIn(outbox[0]!.text, 'reset');
    await s.confirmPasswordReset(t, 'brand-new-pass-9');
    expect(await s.authenticate(a.sid)).toBeUndefined();
    expect((await s.login('root', 'brand-new-pass-9')).kind).toBe('mfa');
    await expect(s.confirmPasswordReset(t, 'another-pass-99')).rejects.toMatchObject({ code: 'link_invalid' });
  });

  it('메일이 꺼져 있으면 요청은 조용히 끝나고 아무것도 안 만든다', async () => {
    const s = svc(false);
    await admin(s);
    await s.requestPasswordReset('root@x.io');
    expect((await db.query('SELECT count(*) AS n FROM password_resets')).rows[0]!['n']).toBe('0');
    expect(s.features()).toEqual({ mail: false });
  });
});

describe('이메일 변경', () => {
  it('**새 주소에서 확인해야 바뀐다**, 옛 주소엔 알림이 간다', async () => {
    const s = svc();
    const a = await admin(s);
    await s.requestEmailChange(a.id, 'New@x.io', 'admin-password-1');
    expect(outbox.map((m) => m.to).sort()).toEqual(['new@x.io', 'root@x.io']);
    expect(((await s.me(a.id)) as { email: string }).email).toBe('root@x.io');
    const t = tokenIn(outbox.find((m) => m.to === 'new@x.io')!.text, 'email');
    await s.confirmEmailChange(t);
    expect(((await s.me(a.id)) as { email: string }).email).toBe('new@x.io');
  });

  it('비밀번호를 다시 묻고, 쓰이는 주소면 **같은 응답에 메일만 없다**', async () => {
    const s = svc();
    const a = await admin(s);
    await expect(s.requestEmailChange(a.id, 'x@x.io', 'wrong-password-1')).rejects.toMatchObject({ code: 'reauth_failed' });
    const { token } = await s.invite({ role: 'auditor', email: 'taken@x.io' }, 'r');
    await s.acceptLink({ token, username: 'tk', password: 'auditor-pass-12' });
    outbox = [];
    await s.requestEmailChange(a.id, 'taken@x.io', 'admin-password-1');
    expect(outbox).toHaveLength(0);
  });
});

describe('초대 메일', () => {
  it('커밋 뒤에 보내고 보냈는지를 말한다', async () => {
    const s = svc();
    const out = await s.invite({ role: 'operator', email: 'op@x.io' }, 'user:root');
    expect(out.mailed).toBe(true);
    expect(tokenIn(outbox[0]!.text, 'invite')).toBe(out.token);
    const failing = new AccountService({ db, sealer, mailer: { send: async () => { throw new Error('smtp down'); } }, publicUrl: 'https://b' });
    expect((await failing.invite({ role: 'auditor', email: 'a@x.io' }, 'r')).mailed).toBe(false);
  });
});

describe('step-up · 세션 생존', () => {
  it('step-up 은 MFA 시각을 새로 찍고, 틀린 코드·인증 앱 없음은 거절', async () => {
    const s = svc();
    const a = await admin(s);
    await db.query(`UPDATE sessions SET mfa_at = now() - interval '1 hour'`);
    const before = (await s.authenticate(a.sid))!.account!.mfaAt!;
    await expect(s.stepUp((await s.authenticate(a.sid))!.account!.sessionHash, a.id, '000000')).rejects.toMatchObject({ code: 'step_up_failed' });
    clock += 30_000;
    await s.stepUp((await s.authenticate(a.sid))!.account!.sessionHash, a.id, codeFor(a.secret));
    expect((await s.authenticate(a.sid))!.account!.mfaAt!).toBeGreaterThan(before);
    const { token } = await s.invite({ role: 'operator' }, 'r');
    const { userId } = await s.acceptLink({ token, username: 'op', password: 'operator-pass-1' });
    const sid = ((await s.login('op', 'operator-pass-1')) as { sessionId: string }).sessionId;
    await expect(s.stepUp((await s.authenticate(sid))!.account!.sessionHash, userId, '123456')).rejects.toMatchObject({ code: 'no_totp' });
  });

  it('로그아웃하면 sessionAlive 가 거짓이다 (열린 스트림이 닫힌다)', async () => {
    const s = svc();
    const a = await admin(s);
    const h = (await s.authenticate(a.sid))!.account!.sessionHash;
    expect(await s.sessionAlive(h)).toBe(true);
    await s.logout(a.sid);
    expect(await s.sessionAlive(h)).toBe(false);
  });
});

describe('민감 작업 게이트 (HTTP)', () => {
  let server: Server | undefined;
  afterEach(async () => {
    server?.closeAllConnections?.();
    if (server !== undefined) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  it('**MFA 가 오래된 관리자 세션은 403 mfa_step_up_required → step-up 뒤 통과**', async () => {
    const s = svc();
    const a = await admin(s);
    server = createApi({
      db: {} as Db, store: {} as ConfigStore, control: {} as ControlPlane,
      auth: new TokenAuth([]), election: { state: { isLeader: false } } as unknown as LeaderElection,
      accounts: s,
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const H = { cookie: `bary_sid=${a.sid}`, origin: base, 'content-type': 'application/json' };
    const inv = (): Promise<Response> => fetch(`${base}/api/v1/invitations`, { method: 'POST', headers: H, body: JSON.stringify({ role: 'auditor' }) });
    // 방금 MFA 를 지났다 → 통과
    const first = await inv();
    expect(first.status, await first.clone().text()).toBe(200);
    await db.query(`UPDATE sessions SET mfa_at = now() - interval '20 minutes'`);
    const blocked = await inv();
    expect(blocked.status).toBe(403);
    expect((await blocked.json() as { code: string }).code).toBe('mfa_step_up_required');
    // 목록 보기는 민감 작업이 아니다
    expect((await fetch(`${base}/api/v1/users`, { headers: H })).status).toBe(200);
    // 서비스 시계를 **앞으로만** 민다 — 로그인 MFA 가 쓴 시간창보다 뒤여야 재사용 거절에 안 걸린다.
    clock += 60_000;
    const up = await fetch(`${base}/api/v1/session/step-up`, { method: 'POST', headers: H, body: JSON.stringify({ code: codeFor(a.secret, clock) }) });
    expect(up.status).toBe(200);
    expect((await inv()).status).toBe(200);
  });
});
