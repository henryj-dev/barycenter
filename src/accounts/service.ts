/**
 * 사람 계정 (공통 회원정책 1차 · 계획 A 단계).
 *
 * 저장소는 **공용 계정 PG** 하나다 — 모든 지역·전역 인스턴스가 같은 행을 본다. 그래서 같은 사람이
 * 인스턴스마다 생기지 않고, 로그아웃·정지·역할 하향이 **다음 보호된 요청부터** 어디서나 반영된다
 * (`authenticate` 가 요청마다 세션·계정을 확인한다). 확인하지 못하면 `AccountStoreUnavailable` 을
 * 던지고, 서버는 그 요청을 거부한다 — 캐시로 넘기지 않는다.
 *
 * A 단계에 **없는 것**: SSO 연결·JIT·IdP 권한 정본·IdP MFA·메일 재설정(B 단계).
 */
import { createHash, randomBytes } from 'node:crypto';

import { scopesOfRole, type Principal, type Role } from '../api/auth.js';
import type { Db, Queryable, Row } from '../store/pg.js';
import { burnPasswordTime, hashPassword, needsRehash, passwordProblem, verifyPassword } from './password.js';
import { mailText, type Mailer } from './mail.js';
import type { Sealer } from './seal.js';
import { base32Encode, newTotpSecret, otpauthUri, verifyTotp } from './totp.js';

export const SESSION_MAX_MS = 8 * 60 * 60 * 1000;
const MFA_PENDING_MS = 5 * 60 * 1000;
const INVITE_TTL_MS = 72 * 60 * 60 * 1000;
const BOOTSTRAP_TTL_MS = 24 * 60 * 60 * 1000;
const RECOVERY_TTL_MS = 24 * 60 * 60 * 1000;
const LOCK_AFTER = 5;
const LOCK_MAX_MS = 60 * 60 * 1000;
const RECOVERY_CODES = 10;
const RESET_TTL_MS = 30 * 60 * 1000;
const EMAIL_CHANGE_TTL_MS = 24 * 60 * 60 * 1000;
/** 같은 사람에게 재설정 메일을 연달아 보내지 않는다 — 메일 폭탄의 손잡이가 되지 않게. */
const RESET_EVERY_MS = 5 * 60 * 1000;
/** 민감 작업은 이만큼 안에 MFA 를 지난 세션만 (공통 정책 · 수치는 미정, 권장 기본). */
export const STEP_UP_MAX_AGE_MS = 15 * 60 * 1000;
/** last_seen 을 요청마다 쓰지 않는다 — 읽기 화면의 요청마다 쓰기가 생긴다. */
const TOUCH_EVERY_MS = 60_000;

const ROLES: readonly Role[] = ['auditor', 'operator', 'admin'];
export const USERNAME = /^[a-z0-9][a-z0-9._-]{1,62}$/;

/** 계정 PG 를 못 물었다. 「세션이 없다」와 다르다 — 서버는 401 이 아니라 503 으로 거부한다. */
export class AccountStoreUnavailable extends Error {}

/** 사람이 고칠 수 있는 거절(입력·상태). 서버가 4xx 로 바꾼다. */
export class AccountError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export type Meta = { ip?: string; userAgent?: string };
export type LoginOutcome =
  | { kind: 'session'; sessionId: string; maxAgeS: number }
  | { kind: 'mfa'; sessionId: string; maxAgeS: number }
  | { kind: 'denied' };

export type InvitePreview = { kind: string; role: Role; email: string | null; username?: string; needsTotp: boolean; totp?: { secret: string; uri: string } };

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const token = (): string => randomBytes(32).toString('base64url');
const str = (r: Row, k: string): string => String(r[k]);
const opt = (r: Row, k: string): string | null => (r[k] === null || r[k] === undefined ? null : String(r[k]));
const isRole = (v: unknown): v is Role => typeof v === 'string' && (ROLES as readonly string[]).includes(v);

export type AccountServiceOptions = {
  db: Db;
  sealer: Sealer;
  /** 인증 앱에 보이는 이름. */
  issuer?: string;
  now?: () => number;
  /** 없으면 메일 기능(초대 메일·재설정·이메일 변경)이 꺼진다. */
  mailer?: Mailer;
  /** 메일 속 링크의 앞부분(`BARY_PUBLIC_URL`). 메일을 켜려면 같이 있어야 한다. */
  publicUrl?: string;
};

export class AccountService {
  readonly #db: Db;
  readonly #sealer: Sealer;
  readonly #issuer: string;
  readonly #now: () => number;
  readonly #mail: { mailer: Mailer; base: string } | undefined;

  constructor(o: AccountServiceOptions) {
    this.#db = o.db;
    this.#sealer = o.sealer;
    this.#issuer = o.issuer ?? 'barycenter';
    this.#now = o.now ?? Date.now;
    this.#mail = o.mailer !== undefined && o.publicUrl !== undefined && o.publicUrl !== ''
      ? { mailer: o.mailer, base: o.publicUrl.replace(/\/+$/, '') } : undefined;
  }

  /** 화면이 「비밀번호를 잊었다」를 그릴지 고른다. 비밀이 아니다. */
  features(): { mail: boolean } {
    return { mail: this.#mail !== undefined };
  }

  // ── 저장소 접근 — 실패는 전부 「못 물었다」 ─────────────────────────────

  async #q(text: string, values?: readonly unknown[]): Promise<Row[]> {
    try {
      return (await this.#db.query(text, values)).rows;
    } catch (e) {
      if (e instanceof AccountError) throw e;
      throw new AccountStoreUnavailable(e instanceof Error ? e.message : String(e));
    }
  }

  async #tx<T>(fn: (c: Queryable) => Promise<T>): Promise<T> {
    try {
      return await this.#db.tx(fn);
    } catch (e) {
      if (e instanceof AccountError) throw e;
      // 유일성 위반은 사람이 고칠 것이다(이름이 겹친다) — 저장소 장애로 접지 않는다.
      if ((e as { code?: string }).code === '23505') {
        throw new AccountError(409, 'conflict', '이미 쓰이는 이름이나 이메일이다');
      }
      throw new AccountStoreUnavailable(e instanceof Error ? e.message : String(e));
    }
  }

  async #audit(c: Queryable | undefined, actor: string, action: string, subject: string | null, meta: Meta, detail?: unknown): Promise<void> {
    const q = 'INSERT INTO account_audit (actor, action, subject_user, ip, detail) VALUES ($1,$2,$3,$4,$5)';
    const v = [actor, action, subject, meta.ip ?? null, detail === undefined ? null : JSON.stringify(detail)];
    if (c !== undefined) await c.query(q, v);
    else await this.#q(q, v);
  }

  // ── 일회용 링크: 초대 · bootstrap · 복구 ────────────────────────────────

  /** 활성 admin 이 하나도 없을 때만. 호스트 CLI 가 부른다. */
  async bootstrap(by: string): Promise<string> {
    return this.#tx(async (c) => {
      const admins = (await c.query(`SELECT 1 FROM users WHERE role='admin' AND status='active' LIMIT 1`)).rows;
      if (admins.length > 0) throw new AccountError(409, 'admin_exists', '활성 관리자가 이미 있다 — bootstrap 은 첫 관리자용이다');
      const t = token();
      await c.query(
        `INSERT INTO invitations (token_hash, kind, role, invited_by, expires_at)
         VALUES ($1,'bootstrap','admin',$2,$3)`,
        [sha(t), by, new Date(this.#now() + BOOTSTRAP_TTL_MS)],
      );
      await this.#audit(c, by, 'account.bootstrap_link', null, {});
      return t;
    });
  }

  async invite(input: { email?: string; role: string }, by: string, meta: Meta = {}): Promise<{ id: string; token: string; expiresAt: string; mailed: boolean }> {
    if (!isRole(input.role)) throw new AccountError(400, 'malformed', '역할은 auditor | operator | admin 이다');
    const email = input.email === undefined ? null : normEmail(input.email);
    const t = token();
    const at = new Date(this.#now() + INVITE_TTL_MS);
    return this.#tx(async (c) => {
      const r = (await c.query(
        `INSERT INTO invitations (token_hash, kind, email, role, invited_by, expires_at)
         VALUES ($1,'invite',$2,$3,$4,$5) RETURNING id`,
        [sha(t), email, input.role, by, at],
      )).rows[0]!;
      await this.#audit(c, by, 'account.invite', null, meta, { role: input.role, email: email !== null });
      return { id: str(r, 'id'), token: t, expiresAt: at.toISOString() };
    }).then(async (out) => {
      // 커밋한 **뒤에** 보낸다 — 보낸 메일의 링크가 롤백된 행을 가리키지 않게. 실패해도 초대는 산다
      // (관리자에게 링크가 있다). 보냈는지를 그대로 말한다.
      let mailed = false;
      if (email !== null && this.#mail !== undefined) {
        const [subject, text] = mailText.invite(`${this.#mail.base}/invite#${out.token}`, input.role, INVITE_TTL_MS / 3600_000);
        mailed = await this.#mail.mailer.send(email, subject, text).then(() => true, () => false);
      }
      return { ...out, mailed };
    });
  }

  // ── 메일 링크: 비밀번호 재설정 · 이메일 변경 ──────────────────────────

  /**
   * **언제나 조용히 끝난다** — 주소가 있든 없든, 메일이 꺼졌든 같다(열거 방지). 보낼 수 있는 경우에만
   * 보낸다: active 계정, 그 주소, 최근 5분 안에 보낸 적 없음.
   */
  async requestPasswordReset(emailIn: string, meta: Meta = {}): Promise<void> {
    if (this.#mail === undefined) return;
    let email: string;
    try { email = normEmail(emailIn); } catch { return; }
    const u = (await this.#q(
      `SELECT u.id, (SELECT max(created_at) FROM password_resets r WHERE r.user_id=u.id) AS last
         FROM users u WHERE u.email=$1 AND u.status='active'`, [email],
    ))[0];
    if (u === undefined) return;
    if (u['last'] !== null && this.#now() - new Date(String(u['last'])).getTime() < RESET_EVERY_MS) return;
    const t = token();
    await this.#tx(async (c) => {
      await c.query(`UPDATE password_resets SET used_at=now() WHERE user_id=$1 AND used_at IS NULL`, [str(u, 'id')]);
      await c.query(
        // 만든 시각도 **앱 시계**로 적는다 — 5분 간격 비교를 같은 시계로 하려고.
        `INSERT INTO password_resets (token_hash, user_id, created_at, expires_at, ip) VALUES ($1,$2,$3,$4,$5)`,
        [sha(t), str(u, 'id'), new Date(this.#now()), new Date(this.#now() + RESET_TTL_MS), meta.ip ?? null],
      );
      await this.#audit(c, 'anonymous', 'account.reset_request', str(u, 'id'), meta);
    });
    const [subject, text] = mailText.reset(`${this.#mail.base}/reset#${t}`, RESET_TTL_MS / 60_000);
    // 보내기 실패를 밖에 알리지 않는다 — 알리면 「그 주소는 계정이 있다」가 드러난다.
    await this.#mail.mailer.send(email, subject, text).catch(() => undefined);
  }

  /** 새 비밀번호를 정한다. **MFA 는 그대로다.** 그 사람의 세션은 전부 끊긴다. */
  async confirmPasswordReset(t: string, password: string, meta: Meta = {}): Promise<void> {
    const problem = passwordProblem(password);
    if (problem !== undefined) throw new AccountError(400, 'weak_password', problem);
    const hash = await hashPassword(password);
    await this.#tx(async (c) => {
      const r = (await c.query(
        `SELECT r.user_id FROM password_resets r JOIN users u ON u.id=r.user_id
          WHERE r.token_hash=$1 AND r.used_at IS NULL AND r.expires_at > now() AND u.status='active'
          FOR UPDATE OF r`, [sha(t)],
      )).rows[0];
      if (r === undefined) throw new AccountError(404, 'link_invalid', '링크가 없거나 만료됐거나 이미 쓰였다');
      const userId = str(r, 'user_id');
      await c.query(`UPDATE password_resets SET used_at=now() WHERE token_hash=$1`, [sha(t)]);
      await c.query(`UPDATE users SET password_hash=$2, failed_logins=0, locked_until=NULL, updated_at=now() WHERE id=$1`, [userId, hash]);
      await c.query(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [userId]);
      await this.#audit(c, `user:${userId}`, 'account.reset_confirm', userId, meta);
    });
  }

  /** 새 주소로 확인 링크를 보낸다. 옛 주소에는 「요청이 왔다」를 알린다. 확인 전까지 주소는 그대로다. */
  async requestEmailChange(userId: string, newEmailIn: string, password: string, meta: Meta = {}): Promise<void> {
    if (this.#mail === undefined) throw new AccountError(409, 'mail_disabled', '메일이 꺼져 있어 주소를 확인할 수 없다 — 관리자에게 부탁한다');
    const newEmail = normEmail(newEmailIn);
    await this.#requirePassword(userId, password);
    const t = token();
    const old = await this.#tx(async (c) => {
      const taken = (await c.query(`SELECT 1 FROM users WHERE email=$1`, [newEmail])).rows.length > 0;
      // 쓰이는 주소여도 **같은 응답**이다 — 확인 메일은 안 보낸다(그 주소의 주인에게 묻지 않는다).
      const u = (await c.query(`SELECT email FROM users WHERE id=$1`, [userId])).rows[0];
      if (!taken) {
        await c.query(`UPDATE email_changes SET used_at=now() WHERE user_id=$1 AND used_at IS NULL`, [userId]);
        await c.query(
          `INSERT INTO email_changes (token_hash, user_id, new_email, expires_at) VALUES ($1,$2,$3,$4)`,
          [sha(t), userId, newEmail, new Date(this.#now() + EMAIL_CHANGE_TTL_MS)],
        );
      }
      await this.#audit(c, `user:${userId}`, 'account.email_change_request', userId, meta);
      return { taken, old: u === undefined ? null : opt(u, 'email') };
    });
    if (old.taken) return;
    const [subject, text] = mailText.emailChange(`${this.#mail.base}/email#${t}`, EMAIL_CHANGE_TTL_MS / 3600_000);
    const sent = await this.#mail.mailer.send(newEmail, subject, text).then(() => true, () => false);
    if (!sent) throw new AccountError(502, 'mail_failed', '확인 메일을 보내지 못했다 — 잠시 뒤 다시 한다');
    if (old.old !== null) {
      const [s2, t2] = mailText.emailChangedNotice(newEmail);
      await this.#mail.mailer.send(old.old, s2, t2).catch(() => undefined);
    }
  }

  async confirmEmailChange(t: string, meta: Meta = {}): Promise<void> {
    await this.#tx(async (c) => {
      const r = (await c.query(
        `SELECT e.user_id, e.new_email FROM email_changes e JOIN users u ON u.id=e.user_id
          WHERE e.token_hash=$1 AND e.used_at IS NULL AND e.expires_at > now() AND u.status='active'
          FOR UPDATE OF e`, [sha(t)],
      )).rows[0];
      if (r === undefined) throw new AccountError(404, 'link_invalid', '링크가 없거나 만료됐거나 이미 쓰였다');
      await c.query(`UPDATE email_changes SET used_at=now() WHERE token_hash=$1`, [sha(t)]);
      await c.query(`UPDATE users SET email=$2, updated_at=now() WHERE id=$1`, [str(r, 'user_id'), str(r, 'new_email')]);
      await this.#audit(c, `user:${str(r, 'user_id')}`, 'account.email_change_confirm', str(r, 'user_id'), meta);
    });
  }

  /** 관리자 MFA 초기화·호스트 CLI 복구. 대상의 세션을 전부 끊는다. */
  async recoveryLink(userId: string, by: string, meta: Meta = {}): Promise<string> {
    const t = token();
    return this.#tx(async (c) => {
      const u = (await c.query(`SELECT role, status FROM users WHERE id=$1 FOR UPDATE`, [userId])).rows[0];
      if (u === undefined || str(u, 'status') === 'deleted') throw new AccountError(404, 'no_user', '그런 계정이 없다');
      await c.query(`UPDATE invitations SET revoked_at=now() WHERE for_user=$1 AND used_at IS NULL AND revoked_at IS NULL`, [userId]);
      await c.query(
        `INSERT INTO invitations (token_hash, kind, for_user, role, invited_by, expires_at)
         VALUES ($1,'recovery',$2,$3,$4,$5)`,
        [sha(t), userId, str(u, 'role'), by, new Date(this.#now() + RECOVERY_TTL_MS)],
      );
      await c.query(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [userId]);
      await this.#audit(c, by, 'account.recovery_link', userId, meta);
      return t;
    });
  }

  async listInvitations(): Promise<unknown[]> {
    return (await this.#q(
      `SELECT id, kind, email, role, invited_by, created_at, expires_at, used_at, revoked_at
         FROM invitations WHERE kind <> 'recovery' ORDER BY created_at DESC LIMIT 200`,
    )).map((r) => ({
      id: str(r, 'id'), kind: str(r, 'kind'), email: opt(r, 'email'), role: str(r, 'role'),
      invitedBy: str(r, 'invited_by'), createdAt: iso(r['created_at']), expiresAt: iso(r['expires_at']),
      usedAt: isoOpt(r['used_at']), revokedAt: isoOpt(r['revoked_at']),
    }));
  }

  async revokeInvitation(id: string, by: string, meta: Meta = {}): Promise<void> {
    await this.#tx(async (c) => {
      const n = (await c.query(`UPDATE invitations SET revoked_at=now() WHERE id=$1 AND used_at IS NULL AND revoked_at IS NULL`, [id])).rowCount;
      if (n === 0) throw new AccountError(404, 'no_invitation', '쓸 수 있는 초대가 아니다');
      await this.#audit(c, by, 'account.invite_revoke', null, meta, { id });
    });
  }

  /**
   * 링크를 **쓰지 않고** 들여다본다. TOTP 가 필요하면 비밀을 새로 뽑아 준다 — 화면이 QR 로 보여 주고,
   * 수락 요청이 그 비밀과 코드를 함께 돌려보낸다(비밀은 어차피 사용자에게 보인다).
   */
  async previewLink(t: string): Promise<InvitePreview> {
    const inv = await this.#usableLink(undefined, t);
    const needsTotp = str(inv, 'role') === 'admin';
    const secret = newTotpSecret();
    const account = opt(inv, 'username') ?? opt(inv, 'email') ?? 'new-user';
    return {
      kind: str(inv, 'kind'), role: str(inv, 'role') as Role, email: opt(inv, 'email'),
      ...(opt(inv, 'username') === null ? {} : { username: opt(inv, 'username')! }),
      needsTotp,
      ...(needsTotp ? { totp: { secret: base32Encode(secret), uri: otpauthUri(secret, account, this.#issuer) } } : {}),
    };
  }

  /**
   * 링크를 쓴다. invite·bootstrap 은 계정을 만들고, recovery 는 그 계정의 비밀번호(와 MFA)를 다시 정한다.
   * **admin 은 TOTP 를 같이 맞춰야 끝난다** — 관리자 로그인에 MFA 가 필수다(공통 정책).
   * 돌려주는 복구 코드는 이번 한 번만 보인다.
   */
  async acceptLink(input: {
    token: string; username?: string; password: string; displayName?: string;
    totp?: { secret: string; code: string };
  }, meta: Meta = {}): Promise<{ userId: string; recoveryCodes?: string[] }> {
    const problem = passwordProblem(input.password);
    if (problem !== undefined) throw new AccountError(400, 'weak_password', problem);
    const hash = await hashPassword(input.password);
    return this.#tx(async (c) => {
      const inv = await this.#usableLink(c, input.token);
      const kind = str(inv, 'kind');
      const role = str(inv, 'role') as Role;
      let totp: { sealedFor: (uid: string) => string; step: number } | undefined;
      if (input.totp !== undefined || role === 'admin') {
        if (input.totp === undefined) throw new AccountError(400, 'totp_required', '관리자는 인증 앱(TOTP) 등록이 필요하다');
        const secret = base32Decode(input.totp.secret);
        const step = verifyTotp(secret, input.totp.code, this.#now(), 0);
        if (step === undefined) throw new AccountError(400, 'totp_mismatch', '인증 앱의 코드가 맞지 않는다');
        totp = { sealedFor: (uid) => this.#sealer.seal(secret, `totp:${uid}`), step };
      }
      let userId: string;
      if (kind === 'recovery') {
        userId = str(inv, 'for_user');
        await c.query(
          `UPDATE users SET password_hash=$2, failed_logins=0, locked_until=NULL, updated_at=now() WHERE id=$1`,
          [userId, hash],
        );
        await c.query('DELETE FROM mfa_totp WHERE user_id=$1', [userId]);
        await c.query('DELETE FROM mfa_recovery_codes WHERE user_id=$1', [userId]);
        await c.query(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [userId]);
      } else {
        const username = (input.username ?? '').trim().toLowerCase();
        if (!USERNAME.test(username)) throw new AccountError(400, 'bad_username', '아이디는 영소문자·숫자·._- 2~63자다');
        userId = str((await c.query(
          `INSERT INTO users (username, display_name, email, role, password_hash, created_by)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [username, input.displayName ?? null, opt(inv, 'email'), role, hash, `invite:${str(inv, 'id')}`],
        )).rows[0]!, 'id');
      }
      await c.query(`UPDATE invitations SET used_at=now(), used_by=$2 WHERE id=$1`, [str(inv, 'id'), userId]);
      let codes: string[] | undefined;
      if (totp !== undefined) {
        await c.query(
          `INSERT INTO mfa_totp (user_id, secret_sealed, last_step, confirmed_at) VALUES ($1,$2,$3,now())`,
          [userId, totp.sealedFor(userId), totp.step],
        );
        codes = await this.#newRecoveryCodes(c, userId);
      }
      await this.#audit(c, `user:${userId}`, `account.${kind}_accept`, userId, meta);
      return { userId, ...(codes === undefined ? {} : { recoveryCodes: codes }) };
    });
  }

  async #usableLink(c: Queryable | undefined, t: string): Promise<Row> {
    const q = `SELECT i.*, u.username FROM invitations i LEFT JOIN users u ON u.id = i.for_user
                WHERE i.token_hash=$1 ${c === undefined ? '' : 'FOR UPDATE OF i'}`;
    const rows = c === undefined ? await this.#q(q, [sha(t)]) : (await c.query(q, [sha(t)])).rows;
    const inv = rows[0];
    // 없음·만료·사용됨·취소됨을 **가르지 않는다** — 링크를 추측하는 쪽에 단서를 안 준다.
    if (inv === undefined || inv['used_at'] !== null || inv['revoked_at'] !== null
      || new Date(String(inv['expires_at'])).getTime() <= this.#now()) {
      throw new AccountError(404, 'link_invalid', '링크가 없거나 만료됐거나 이미 쓰였다');
    }
    return inv;
  }

  // ── 로그인 · MFA · 세션 ────────────────────────────────────────────────

  /**
   * **응답은 계정 유무와 무관하게 같다** — 없는 계정·틀린 비밀번호·잠김·정지가 모두 `denied` 다.
   * 없는 계정도 scrypt 한 번만큼 시간을 쓴다.
   */
  async login(identifier: string, password: string, meta: Meta = {}): Promise<LoginOutcome> {
    const id = identifier.trim().toLowerCase();
    const u = (await this.#q(
      `SELECT u.id, u.username, u.role, u.status, u.password_hash, u.failed_logins, u.locked_until,
              t.confirmed_at AS totp_at
         FROM users u LEFT JOIN mfa_totp t ON t.user_id = u.id
        WHERE (u.username=$1 OR u.email=$1) AND u.status <> 'deleted'`,
      [id],
    ))[0];
    const now = this.#now();
    if (u === undefined || u['password_hash'] === null) {
      await burnPasswordTime(password);
      return { kind: 'denied' };
    }
    const userId = str(u, 'id');
    const locked = u['locked_until'] !== null && new Date(String(u['locked_until'])).getTime() > now;
    const ok = await verifyPassword(password, str(u, 'password_hash'));
    if (!ok || locked || str(u, 'status') !== 'active') {
      if (!ok) await this.#failed(userId, Number(u['failed_logins']), meta);
      return { kind: 'denied' };
    }
    await this.#q(`UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=$1`, [userId]);
    if (needsRehash(str(u, 'password_hash'))) {
      await this.#q(`UPDATE users SET password_hash=$2 WHERE id=$1`, [userId, await hashPassword(password)]);
    }
    const hasTotp = u['totp_at'] !== null;
    // admin 인데 TOTP 가 없는 상태는 만들지 않지만(수락·승격이 막는다), 만들어졌다면 들이지 않는다.
    if (str(u, 'role') === 'admin' && !hasTotp) return { kind: 'denied' };
    if (hasTotp) {
      const sid = await this.#newSession(userId, now + MFA_PENDING_MS, true, ['pwd'], meta);
      return { kind: 'mfa', sessionId: sid, maxAgeS: MFA_PENDING_MS / 1000 };
    }
    const sid = await this.#newSession(userId, now + SESSION_MAX_MS, false, ['pwd'], meta);
    await this.#audit(undefined, `user:${str(u, 'username')}`, 'session.login', userId, meta);
    return { kind: 'session', sessionId: sid, maxAgeS: SESSION_MAX_MS / 1000 };
  }

  /** 계정 단위 잠금 — 인스턴스를 가리지 않는다(공용 PG). 5번부터 1분, 2분, … 최대 1시간. */
  async #failed(userId: string, prev: number, meta: Meta): Promise<void> {
    const n = prev + 1;
    const lockMs = n >= LOCK_AFTER ? Math.min(LOCK_MAX_MS, 60_000 * 2 ** (n - LOCK_AFTER)) : 0;
    await this.#q(
      `UPDATE users SET failed_logins=$2, locked_until=$3 WHERE id=$1`,
      [userId, n, lockMs === 0 ? null : new Date(this.#now() + lockMs)],
    );
    if (lockMs > 0) await this.#audit(undefined, 'system', 'account.locked', userId, meta, { failures: n });
  }

  /**
   * MFA 단계. 맞으면 **새 세션 id 로 바꾼다** — 비밀번호 단계의 id 를 그대로 키우면, 그 id 를
   * 미리 심어 둔 쪽이 MFA 뒤의 세션을 갖는다(세션 고정).
   */
  async completeMfa(pendingId: string | undefined, code: string, meta: Meta = {}): Promise<LoginOutcome> {
    if (pendingId === undefined) return { kind: 'denied' };
    const now = this.#now();
    return this.#tx(async (c) => {
      const s = (await c.query(
        `SELECT s.user_id, s.created_at, u.username, u.failed_logins, u.status, t.secret_sealed, t.last_step
           FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN mfa_totp t ON t.user_id = s.user_id
          WHERE s.id_hash=$1 AND s.mfa_pending AND s.revoked_at IS NULL AND s.expires_at > now()
          FOR UPDATE OF s`,
        [sha(pendingId)],
      )).rows[0];
      if (s === undefined || str(s, 'status') !== 'active') return { kind: 'denied' } as const;
      const userId = str(s, 'user_id');
      const method = await this.#secondFactor(c, userId, code, s['secret_sealed'] === null ? null : str(s, 'secret_sealed'), Number(s['last_step']));
      if (method === undefined) {
        await c.query(`UPDATE users SET failed_logins=failed_logins+1 WHERE id=$1`, [userId]);
        return { kind: 'denied' } as const;
      }
      await c.query(`UPDATE sessions SET revoked_at=now() WHERE id_hash=$1`, [sha(pendingId)]);
      const sid = token();
      await c.query(
        `INSERT INTO sessions (id_hash, user_id, expires_at, mfa_pending, auth_methods, mfa_at, ip, user_agent)
         VALUES ($1,$2,$3,false,$4,now(),$5,$6)`,
        [sha(sid), userId, new Date(now + SESSION_MAX_MS), ['pwd', method], meta.ip ?? null, meta.userAgent ?? null],
      );
      await c.query(`UPDATE users SET failed_logins=0 WHERE id=$1`, [userId]);
      await this.#audit(c, `user:${str(s, 'username')}`, 'session.login', userId, meta, { mfa: method });
      return { kind: 'session', sessionId: sid, maxAgeS: SESSION_MAX_MS / 1000 } as const;
    });
  }

  /**
   * 둘째 인증 수단 하나 — TOTP 또는 복구 코드. 로그인 MFA 와 step-up 이 같은 문을 쓴다.
   * 성공한 수단 이름, 아니면 undefined.
   */
  async #secondFactor(c: Queryable, userId: string, code: string, sealed: string | null, lastStep: number): Promise<string | undefined> {
    if (sealed !== null) {
      const step = verifyTotp(this.#sealer.open(sealed, `totp:${userId}`), code, this.#now(), lastStep);
      if (step !== undefined) {
        // 조건부 갱신 — 같은 창의 코드가 동시에 두 번 와도 한쪽만 이긴다.
        const won = (await c.query(`UPDATE mfa_totp SET last_step=$2 WHERE user_id=$1 AND last_step < $2`, [userId, step])).rowCount;
        if (won === 1) return 'totp';
      }
    }
    if (/^[a-z0-9]{4}-[a-z0-9]{4}$/i.test(code.trim())) {
      const used = (await c.query(
        `UPDATE mfa_recovery_codes SET used_at=now() WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL`,
        [userId, sha(code.trim().toLowerCase())],
      )).rowCount;
      if (used === 1) return 'recovery';
    }
    return undefined;
  }

  /**
   * **민감 작업 앞의 재확인** (step-up). 지금 세션에 MFA 시각을 새로 찍는다 — 세션을 새로 만들지 않는다.
   * 인증 앱이 없으면 할 수 없다(먼저 등록한다).
   */
  async stepUp(sessionHash: string, userId: string, code: string, meta: Meta = {}): Promise<void> {
    await this.#tx(async (c) => {
      const t = (await c.query(
        `SELECT t.secret_sealed, t.last_step FROM mfa_totp t WHERE t.user_id=$1 AND t.confirmed_at IS NOT NULL FOR UPDATE`, [userId],
      )).rows[0];
      if (t === undefined) throw new AccountError(409, 'no_totp', '인증 앱을 먼저 등록한다 — 민감 작업은 MFA 가 필요하다');
      const method = await this.#secondFactor(c, userId, code, str(t, 'secret_sealed'), Number(t['last_step']));
      if (method === undefined) {
        await c.query(`UPDATE users SET failed_logins=failed_logins+1 WHERE id=$1`, [userId]);
        throw new AccountError(403, 'step_up_failed', '인증 코드가 맞지 않는다');
      }
      await c.query(
        `UPDATE sessions SET mfa_at=now(), auth_methods = array_append(auth_methods, $2)
          WHERE id_hash=$1 AND revoked_at IS NULL`, [sessionHash, `step-up:${method}`],
      );
      await this.#audit(c, `user:${userId}`, 'session.step_up', userId, meta, { method });
    });
  }

  /** 열린 SSE 의 하트비트가 묻는다. 못 물으면 던진다 — 스트림 쪽이 닫는다. */
  async sessionAlive(sessionHash: string): Promise<boolean> {
    const r = await this.#q(
      `SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
        WHERE s.id_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > now() AND NOT s.mfa_pending AND u.status='active'`,
      [sessionHash],
    );
    return r.length > 0;
  }

  async #newSession(userId: string, expiresAt: number, pending: boolean, methods: string[], meta: Meta): Promise<string> {
    const sid = token();
    await this.#q(
      `INSERT INTO sessions (id_hash, user_id, expires_at, mfa_pending, auth_methods, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [sha(sid), userId, new Date(expiresAt), pending, methods, meta.ip ?? null, meta.userAgent ?? null],
    );
    return sid;
  }

  /**
   * **모든 보호된 요청이 여기를 지난다.** 세션이 살아 있고(철회·만료 아님·MFA 대기 아님), 계정이
   * active 이고, 역할을 **지금** 읽는다 — 로그아웃·정지·역할 하향이 다음 요청부터 반영된다.
   * 못 물으면 `AccountStoreUnavailable`(서버가 503 으로 거부한다).
   */
  async authenticate(sessionId: string | undefined): Promise<Principal | undefined> {
    if (sessionId === undefined || sessionId === '') return undefined;
    const h = sha(sessionId);
    const r = (await this.#q(
      `SELECT s.user_id, s.mfa_at, s.last_seen_at, u.username, u.role
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > now() AND NOT s.mfa_pending
          AND u.status='active'`,
      [h],
    ))[0];
    if (r === undefined) return undefined;
    const role = str(r, 'role');
    if (!isRole(role)) return undefined;
    const mfaAt = r['mfa_at'] === null ? undefined : new Date(String(r['mfa_at'])).getTime();
    // 관리자는 MFA 를 거친 세션만 — 역할이 세션 도중 admin 으로 올라도 그 세션으로는 관리자가 못 된다.
    if (role === 'admin' && mfaAt === undefined) return undefined;
    if (this.#now() - new Date(String(r['last_seen_at'])).getTime() > TOUCH_EVERY_MS) {
      await this.#q(`UPDATE sessions SET last_seen_at=now() WHERE id_hash=$1`, [h]);
    }
    return {
      name: `user:${str(r, 'username')}`, role, scopes: new Set(scopesOfRole(role)),
      account: { userId: str(r, 'user_id'), sessionHash: h, ...(mfaAt === undefined ? {} : { mfaAt }) },
    };
  }

  /** 로그아웃 — 쿠키를 지우는 것만으로 끝내지 않는다. 서버에서 그 세션을 철회한다. */
  async logout(sessionId: string | undefined, meta: Meta = {}): Promise<void> {
    if (sessionId === undefined || sessionId === '') return;
    const r = (await this.#q(
      `UPDATE sessions SET revoked_at=now() WHERE id_hash=$1 AND revoked_at IS NULL RETURNING user_id`,
      [sha(sessionId)],
    ))[0];
    if (r !== undefined) await this.#audit(undefined, `user:${str(r, 'user_id')}`, 'session.logout', str(r, 'user_id'), meta);
  }

  async logoutAll(userId: string, actor: string, meta: Meta = {}): Promise<number> {
    const rows = await this.#q(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL RETURNING 1`, [userId]);
    await this.#audit(undefined, actor, 'session.logout_all', userId, meta, { sessions: rows.length });
    return rows.length;
  }

  // ── 내 계정 ──────────────────────────────────────────────────────────

  async me(userId: string): Promise<unknown> {
    const u = (await this.#q(
      `SELECT u.id, u.username, u.display_name, u.email, u.role, u.role_authority, u.created_at,
              t.confirmed_at AS totp_at,
              (SELECT count(*) FROM mfa_recovery_codes c WHERE c.user_id=u.id AND c.used_at IS NULL) AS codes_left
         FROM users u LEFT JOIN mfa_totp t ON t.user_id=u.id WHERE u.id=$1`,
      [userId],
    ))[0];
    if (u === undefined) throw new AccountError(404, 'no_user', '계정이 없다');
    const sessions = (await this.#q(
      `SELECT created_at, last_seen_at, expires_at, auth_methods, ip, user_agent FROM sessions
        WHERE user_id=$1 AND revoked_at IS NULL AND expires_at > now() AND NOT mfa_pending
        ORDER BY last_seen_at DESC LIMIT 20`,
      [userId],
    )).map((s) => ({
      createdAt: iso(s['created_at']), lastSeenAt: iso(s['last_seen_at']), expiresAt: iso(s['expires_at']),
      methods: s['auth_methods'], ip: opt(s, 'ip'), userAgent: opt(s, 'user_agent'),
    }));
    return {
      id: str(u, 'id'), username: str(u, 'username'), displayName: opt(u, 'display_name'),
      email: opt(u, 'email'), role: str(u, 'role'), roleAuthority: str(u, 'role_authority'),
      createdAt: iso(u['created_at']),
      mfa: { totp: u['totp_at'] !== null, recoveryCodesLeft: Number(u['codes_left']) },
      sessions,
    };
  }

  /** 현재 비밀번호를 다시 확인한다. 바꾸면 **이 세션 말고** 전부 끊는다. */
  async changePassword(userId: string, current: string, next: string, keepSessionHash: string, meta: Meta = {}): Promise<void> {
    const problem = passwordProblem(next);
    if (problem !== undefined) throw new AccountError(400, 'weak_password', problem);
    await this.#requirePassword(userId, current);
    const hash = await hashPassword(next);
    await this.#tx(async (c) => {
      await c.query(`UPDATE users SET password_hash=$2, updated_at=now() WHERE id=$1`, [userId, hash]);
      await c.query(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL AND id_hash <> $2`, [userId, keepSessionHash]);
      await this.#audit(c, `user:${userId}`, 'account.password_change', userId, meta);
    });
  }

  async #requirePassword(userId: string, password: string): Promise<void> {
    const r = (await this.#q(`SELECT password_hash FROM users WHERE id=$1`, [userId]))[0];
    if (r === undefined || r['password_hash'] === null || !(await verifyPassword(password, str(r, 'password_hash')))) {
      throw new AccountError(403, 'reauth_failed', '현재 비밀번호가 맞지 않는다');
    }
  }

  /** TOTP 등록 시작 — 비밀을 새로 뽑아 미확인 상태로 둔다. 이미 확인된 TOTP 가 있으면 먼저 지워야 한다. */
  async beginTotp(userId: string, username: string): Promise<{ secret: string; uri: string }> {
    const secret = newTotpSecret();
    await this.#tx(async (c) => {
      const cur = (await c.query(`SELECT confirmed_at FROM mfa_totp WHERE user_id=$1 FOR UPDATE`, [userId])).rows[0];
      if (cur !== undefined && cur['confirmed_at'] !== null) {
        throw new AccountError(409, 'totp_exists', '이미 등록된 인증 앱이 있다 — 먼저 해제한다');
      }
      await c.query(
        `INSERT INTO mfa_totp (user_id, secret_sealed) VALUES ($1,$2)
         ON CONFLICT (user_id) DO UPDATE SET secret_sealed=EXCLUDED.secret_sealed, last_step=0, created_at=now()`,
        [userId, this.#sealer.seal(secret, `totp:${userId}`)],
      );
    });
    return { secret: base32Encode(secret), uri: otpauthUri(secret, username, this.#issuer) };
  }

  async confirmTotp(userId: string, code: string, meta: Meta = {}): Promise<string[]> {
    return this.#tx(async (c) => {
      const t = (await c.query(`SELECT secret_sealed, confirmed_at FROM mfa_totp WHERE user_id=$1 FOR UPDATE`, [userId])).rows[0];
      if (t === undefined || t['confirmed_at'] !== null) throw new AccountError(409, 'no_pending_totp', '확인할 등록이 없다');
      const step = verifyTotp(this.#sealer.open(str(t, 'secret_sealed'), `totp:${userId}`), code, this.#now(), 0);
      if (step === undefined) throw new AccountError(400, 'totp_mismatch', '인증 앱의 코드가 맞지 않는다');
      await c.query(`UPDATE mfa_totp SET confirmed_at=now(), last_step=$2 WHERE user_id=$1`, [userId, step]);
      const codes = await this.#newRecoveryCodes(c, userId);
      await this.#audit(c, `user:${userId}`, 'account.totp_enable', userId, meta);
      return codes;
    });
  }

  /** admin 은 해제할 수 없다 — 관리자 로그인에 MFA 가 필수다. */
  async removeTotp(userId: string, password: string, meta: Meta = {}): Promise<void> {
    await this.#requirePassword(userId, password);
    await this.#tx(async (c) => {
      const u = (await c.query(`SELECT role FROM users WHERE id=$1`, [userId])).rows[0];
      if (u !== undefined && str(u, 'role') === 'admin') throw new AccountError(409, 'admin_needs_mfa', '관리자는 인증 앱을 해제할 수 없다');
      await c.query('DELETE FROM mfa_totp WHERE user_id=$1', [userId]);
      await c.query('DELETE FROM mfa_recovery_codes WHERE user_id=$1', [userId]);
      await this.#audit(c, `user:${userId}`, 'account.totp_disable', userId, meta);
    });
  }

  async regenerateRecoveryCodes(userId: string, password: string, meta: Meta = {}): Promise<string[]> {
    await this.#requirePassword(userId, password);
    return this.#tx(async (c) => {
      const t = (await c.query(`SELECT confirmed_at FROM mfa_totp WHERE user_id=$1`, [userId])).rows[0];
      if (t === undefined || t['confirmed_at'] === null) throw new AccountError(409, 'no_totp', '인증 앱이 없으면 복구 코드도 없다');
      const codes = await this.#newRecoveryCodes(c, userId);
      await this.#audit(c, `user:${userId}`, 'account.recovery_codes', userId, meta);
      return codes;
    });
  }

  async #newRecoveryCodes(c: Queryable, userId: string): Promise<string[]> {
    await c.query('DELETE FROM mfa_recovery_codes WHERE user_id=$1', [userId]);
    const codes: string[] = [];
    for (let i = 0; i < RECOVERY_CODES; i++) {
      const raw = randomBytes(5).toString('hex').slice(0, 8);
      const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
      codes.push(code);
      await c.query('INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1,$2)', [userId, sha(code)]);
    }
    return codes;
  }

  // ── 관리 ─────────────────────────────────────────────────────────────

  async listUsers(): Promise<unknown[]> {
    return (await this.#q(
      `SELECT u.id, u.username, u.display_name, u.email, u.role, u.role_authority, u.status, u.created_at,
              u.locked_until, t.confirmed_at IS NOT NULL AS totp
         FROM users u LEFT JOIN mfa_totp t ON t.user_id=u.id WHERE u.status <> 'deleted' ORDER BY u.username`,
    )).map((u) => ({
      id: str(u, 'id'), username: str(u, 'username'), displayName: opt(u, 'display_name'), email: opt(u, 'email'),
      role: str(u, 'role'), roleAuthority: str(u, 'role_authority'), status: str(u, 'status'),
      createdAt: iso(u['created_at']), lockedUntil: isoOpt(u['locked_until']), totp: u['totp'] === true,
    }));
  }

  /**
   * 역할·상태를 바꾼다. **마지막 활성 admin 은 강등·정지할 수 없다.** admin 으로 올리려면 그 사람이
   * TOTP 를 등록해 둬야 한다. 정지는 그 사람 세션을 즉시 철회한다(역할 하향은 다음 요청의 재읽기로 반영).
   */
  async updateUser(userId: string, patch: { role?: string; status?: string }, by: string, meta: Meta = {}): Promise<void> {
    if (patch.role !== undefined && !isRole(patch.role)) throw new AccountError(400, 'malformed', '역할은 auditor | operator | admin 이다');
    if (patch.status !== undefined && patch.status !== 'active' && patch.status !== 'suspended') {
      throw new AccountError(400, 'malformed', '상태는 active | suspended 다 (삭제는 따로)');
    }
    await this.#tx(async (c) => {
      // admin 행을 잠근다 — 둘이 동시에 서로를 강등해 관리자가 0 이 되는 경합을 막는다.
      await c.query(`SELECT id FROM users WHERE role='admin' AND status='active' FOR UPDATE`);
      const u = (await c.query(
        `SELECT u.role, u.status, t.confirmed_at FROM users u LEFT JOIN mfa_totp t ON t.user_id=u.id WHERE u.id=$1 FOR UPDATE OF u`,
        [userId],
      )).rows[0];
      if (u === undefined || str(u, 'status') === 'deleted') throw new AccountError(404, 'no_user', '그런 계정이 없다');
      const role = patch.role ?? str(u, 'role');
      const status = patch.status ?? str(u, 'status');
      if (str(u, 'role') === 'admin' && str(u, 'status') === 'active' && (role !== 'admin' || status !== 'active')) {
        await this.#guardLastAdmin(c, userId);
      }
      if (role === 'admin' && str(u, 'role') !== 'admin' && u['confirmed_at'] === null) {
        throw new AccountError(409, 'admin_needs_mfa', '관리자로 올리려면 그 사람이 먼저 인증 앱을 등록해야 한다');
      }
      await c.query(`UPDATE users SET role=$2, status=$3, updated_at=now() WHERE id=$1`, [userId, role, status]);
      if (status === 'suspended') {
        await c.query(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [userId]);
      }
      await this.#audit(c, by, 'account.update', userId, meta, { role, status });
    });
  }

  /** 소프트 삭제 — 로그인 수단을 지우고 username 은 묘비로 남긴다(재사용 금지, 감사 대응 유지). */
  async deleteUser(userId: string, by: string, meta: Meta = {}): Promise<void> {
    await this.#tx(async (c) => {
      await c.query(`SELECT id FROM users WHERE role='admin' AND status='active' FOR UPDATE`);
      const u = (await c.query(`SELECT role, status FROM users WHERE id=$1 FOR UPDATE`, [userId])).rows[0];
      if (u === undefined || str(u, 'status') === 'deleted') throw new AccountError(404, 'no_user', '그런 계정이 없다');
      if (str(u, 'role') === 'admin' && str(u, 'status') === 'active') await this.#guardLastAdmin(c, userId);
      await c.query(
        `UPDATE users SET status='deleted', email=NULL, password_hash=NULL, display_name=NULL,
                          deleted_at=now(), updated_at=now() WHERE id=$1`,
        [userId],
      );
      await c.query('DELETE FROM mfa_totp WHERE user_id=$1', [userId]);
      await c.query('DELETE FROM mfa_recovery_codes WHERE user_id=$1', [userId]);
      await c.query(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [userId]);
      await c.query(`UPDATE invitations SET revoked_at=now() WHERE for_user=$1 AND used_at IS NULL`, [userId]);
      await this.#audit(c, by, 'account.delete', userId, meta);
    });
  }

  async #guardLastAdmin(c: Queryable, exceptUserId: string): Promise<void> {
    const others = (await c.query(
      `SELECT count(*) AS n FROM users WHERE role='admin' AND status='active' AND id <> $1`, [exceptUserId],
    )).rows[0]!;
    if (Number(others['n']) === 0) {
      throw new AccountError(409, 'last_admin', '마지막 활성 관리자는 강등·정지·삭제할 수 없다');
    }
  }

  async userIdByName(username: string): Promise<string | undefined> {
    const r = (await this.#q(`SELECT id FROM users WHERE username=$1 AND status <> 'deleted'`, [username.toLowerCase()]))[0];
    return r === undefined ? undefined : str(r, 'id');
  }

  async accountAudit(limit: number): Promise<unknown[]> {
    return (await this.#q(
      `SELECT id, at, actor, action, subject_user, ip FROM account_audit ORDER BY at DESC, id DESC LIMIT $1`,
      [Math.max(1, Math.min(1000, limit))],
    )).map((r) => ({
      id: str(r, 'id'), at: iso(r['at']), actor: str(r, 'actor'), action: str(r, 'action'),
      subjectUser: opt(r, 'subject_user'), ip: opt(r, 'ip'),
    }));
  }
}

function normEmail(v: string): string {
  const e = v.trim().toLowerCase();
  // 모양만 본다 — 실제로 받는지는 초대 메일이 확인한다(B 단계).
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 254) throw new AccountError(400, 'bad_email', '이메일 모양이 아니다');
  return e;
}

function base32Decode(s: string): Buffer {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = s.toUpperCase().replace(/[\s=]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new AccountError(400, 'malformed', 'TOTP 비밀이 base32 가 아니다');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (out.length < 16) throw new AccountError(400, 'malformed', 'TOTP 비밀이 너무 짧다');
  return Buffer.from(out);
}

const iso = (v: unknown): string => new Date(String(v)).toISOString();
const isoOpt = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));
