/**
 * 사람 계정 (공통 회원정책 1차 · 계획 A 단계).
 *
 * 저장소는 **공용 계정 PG** 하나다 — 모든 지역·전역 인스턴스가 같은 행을 본다. 그래서 같은 사람이
 * 인스턴스마다 생기지 않고, 로그아웃·정지·역할 하향이 **다음 보호된 요청부터** 어디서나 반영된다
 * (`authenticate` 가 요청마다 세션·계정을 확인한다). 확인하지 못하면 `AccountStoreUnavailable` 을
 * 던지고, 서버는 그 요청을 거부한다 — 캐시로 넘기지 않는다.
 *
 * A 단계에 **없는 것**: SSO 연결·JIT·IdP 권한 정본·IdP MFA·메일 재설정(B 단계).
 *
 * 둘째 인증 수단은 어댑터다(`./mfa/`). 기본은 로컬 TOTP, IdP OTP 를 켜면(`idpMfa`) 그 IdP 와 이어진 사람은
 * IdP 의 OTP 로 통과한다. 복구 코드는 언제나 로컬이다.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { ALL_SCOPES, minRole, PERSONAL_TOKEN, roleRank, scopesOfRole, type Principal, type Role, type Scope } from '../api/auth.js';
import type { Db, Queryable, Row } from '../store/pg.js';
import { burnPasswordTime, hashPassword, needsRehash, passwordProblem, verifyPassword } from './password.js';
import { mailText, type Mailer } from './mail.js';
import type { Sealer } from './sealer/provider.js';
import { base32Encode, newTotpSecret, otpauthUri, verifyTotp } from './totp.js';
import { localTotp } from './mfa/local.js';
import type { MfaFailure, MfaMethod, MfaProvider } from './mfa/provider.js';
import {
  claimsConfigProblem, claimsMapper, isEntitlementEffect, type ClaimsMapperConfig, type EntitlementEffect,
} from './idp-roles/claims.js';
import { effectiveScopes, isScope, normScopes, type IdpAuthority, type RoleMapper, type RoleMapResult } from './idp-roles/mapper.js';
import { roleProfile } from './idp-roles/registry.js';
import type { RoleChange } from './idp-roles/role-change.js';
import { log } from '../obs/log.js';

/** 세션 수명 (회원 공통 수치 1차) — 절대 12시간, 요청이 없으면 30분 뒤 끝난다. */
export const SESSION_MAX_MS = 12 * 60 * 60 * 1000;
export const SESSION_IDLE_MS = 30 * 60 * 1000;
/** 미확인 인증 앱 등록이 유효한 시간 (공통 수치 1차 — TOTP 등록 코드 24시간). */
const TOTP_SETUP_TTL_MS = 24 * 60 * 60 * 1000;
/** 감사 기록 보존 (공통 수치 1차 — 1년). */
export const AUDIT_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
const MFA_PENDING_MS = 5 * 60 * 1000;
const INVITE_TTL_MS = 72 * 60 * 60 * 1000;
const BOOTSTRAP_TTL_MS = 24 * 60 * 60 * 1000;
const RECOVERY_TTL_MS = 24 * 60 * 60 * 1000;
const LOCK_AFTER = 5;
/** 지연 상한이자 계수 초기화 시간 (공통 수치 1차 추가 — 시작 1초, 상한 15분, 마지막 실패 뒤 15분이면 초기화). */
const LOCK_MAX_MS = 15 * 60 * 1000;
const LOCK_BASE_MS = 1000;
const RECOVERY_CODES = 10;
const RESET_TTL_MS = 30 * 60 * 1000;
const EMAIL_CHANGE_TTL_MS = 24 * 60 * 60 * 1000;
/** 같은 사람에게 재설정 메일을 연달아 보내지 않는다 — 메일 폭탄의 손잡이가 되지 않게. */
const RESET_EVERY_MS = 5 * 60 * 1000;
/** 민감 작업은 이만큼 안에 MFA 를 지난 세션만 (공통 정책 · 수치는 미정, 권장 기본). */
export const STEP_UP_MAX_AGE_MS = 10 * 60 * 1000;
/** last_seen 을 요청마다 쓰지 않는다 — 읽기 화면의 요청마다 쓰기가 생긴다. */
const TOUCH_EVERY_MS = 60_000;
/** 개인 API 토큰 만료 (사용자 승인 설계) — 기본 90일, 최대 365일. 만료 없는 토큰은 없다. */
export const TOKEN_DEFAULT_DAYS = 90;
export const TOKEN_MAX_DAYS = 365;
/** 한 사람이 동시에 가질 수 있는 (철회 안 된) 토큰 수. 넘으면 먼저 폐기한다. */
const TOKEN_MAX_PER_USER = 50;
/** 토큰 이름 — 시안의 규칙(영문·숫자로 시작, 영문·숫자·`.`·`_`·`-`, 63자까지). DDL 의 CHECK 와 같다. */
export const TOKEN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ROLES: readonly Role[] = ['auditor', 'operator', 'admin'];
/** 5번째 실패부터 1초·2초·4초 … 최대 15분. 그 전은 0. */
function backoffMs(failures: number): number {
  return failures >= LOCK_AFTER ? Math.min(LOCK_MAX_MS, LOCK_BASE_MS * 2 ** (failures - LOCK_AFTER)) : 0;
}

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
  | { kind: 'mfa'; sessionId: string; maxAgeS: number; method: SecondFactorKind }
  | { kind: 'denied' };

/** 그 사람의 둘째 인증이 어느 쪽인가 — 화면이 「어느 코드를 넣는가」를 말한다. */
export type SecondFactorKind = 'totp' | 'idp';

/** IdP 가 서명한 클레임 중 우리가 쓰는 것. 검증은 호출자(`verifiedIdClaims`)가 끝냈다. */
export type SsoClaims = {
  iss: string; sub: string; preferredUsername?: string;
  /** 서명 검증을 지난 클레임 전체 — IdP 권한 정본 계정의 역할 클레임을 여기서 읽는다(B3). */
  raw?: Record<string, unknown>;
};

export type SsoOutcome = LoginOutcome | { kind: 'linked' } | { kind: 'not_linked' };

/** 내 토큰 목록의 한 줄 — **비밀은 없다**(값·해시 둘 다). `prefix` 는 유출된 값을 찾아 맞춰 보는 비밀 아닌 앞부분이다. */
export type ApiTokenRow = {
  id: string; name: string; role: Role; prefix: string;
  createdAt: string; expiresAt: string; lastUsedAt: string | null;
};

export type InvitePreview = { kind: string; role: Role; email: string | null; username?: string; needsTotp: boolean; totp?: { secret: string; uri: string } };

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const token = (): string => randomBytes(32).toString('base64url');
const str = (r: Row, k: string): string => String(r[k]);
const opt = (r: Row, k: string): string | null => (r[k] === null || r[k] === undefined ? null : String(r[k]));
const isRole = (v: unknown): v is Role => typeof v === 'string' && (ROLES as readonly string[]).includes(v);

/**
 * 「실효 관리자」 — 역할이 admin 이거나 admin 범위를 grant 받았고, admin 범위를 deny 받지 않았다(deny 가 이긴다).
 * 마지막 관리자 보호 · 관리자 MFA 가 이것으로 잰다. 별칭 `u` 의 users 행에 쓴다.
 */
const ADMIN_SQL = `((u.role='admin' OR 'admin' = ANY(u.idp_grant)) AND NOT ('admin' = ANY(u.idp_deny)))`;
/** 실효 권한 정본이 IdP 인가 — 그 사람의 정본이 idp 이거나, 이어진 공급자가 「이 공급자의 SSO 사용자는 모두 IdP 정본」 이다. */
const IDP_AUTHORITY_SQL = `(u.role_authority='idp' OR EXISTS (SELECT 1 FROM user_identities pi JOIN sso_providers pp ON pp.issuer=pi.issuer
  WHERE pi.user_id=u.id AND pp.idp_authority))`;
/** 공급자 기본 정본 때문에 IdP 정본인가 — 화면이 「왜 손으로 못 바꾸나」 를 말한다. */
const PROVIDER_AUTHORITY_SQL = `EXISTS (SELECT 1 FROM user_identities pi JOIN sso_providers pp ON pp.issuer=pi.issuer
  WHERE pi.user_id=u.id AND pp.idp_authority)`;
const PROVIDER_COLS = `issuer, jit_enabled, jit_role, role_claim, role_map, idp_authority, entitlement_claim, entitlement_prefix,
  entitlement_map, updated_at, updated_by`;

const scopeList = (v: unknown): Scope[] => (Array.isArray(v) ? normScopes(v.filter(isScope)) : []);
/** 행의 권한(역할 · grant · deny). 역할이 모르는 값이면 undefined — 호출자가 닫는다. */
function authorityOfRow(r: Row): IdpAuthority | undefined {
  const role = r['role'];
  if (!isRole(role)) return undefined;
  return { role, grant: scopeList(r['idp_grant']), deny: scopeList(r['idp_deny']) };
}
const scopesOfAuthority = (a: IdpAuthority): Scope[] => effectiveScopes(a.role, a.grant, a.deny);
const sameAuthority = (a: IdpAuthority, b: IdpAuthority): boolean =>
  a.role === b.role && a.grant.join() === b.grant.join() && a.deny.join() === b.deny.join();
/** 감사 · 화면에 남길 짧은 모양 — `operator +apply -write`. */
const authorityText = (a: IdpAuthority): string =>
  [a.role, ...a.grant.map((g) => `+${g}`), ...a.deny.map((d) => `-${d}`)].join(' ');

/**
 * 화면에 보일 권한 — 사람의 정본(`roleAuthority`, 손으로 고른 값)과 **실효** 정본(`idpAuthority` — 공급자 기본 정본 포함),
 * IdP 가 준 grant/deny, 그리고 실효 범위. 행에 `idp_authority` · `by_provider` 칸이 있어야 한다.
 */
function authorityView(r: Row): {
  roleAuthority: string; idpAuthority: boolean; roleAuthorityByProvider: boolean; idpGrant: Scope[]; idpDeny: Scope[]; scopes: Scope[];
} {
  const a = authorityOfRow(r);
  return {
    roleAuthority: str(r, 'role_authority'),
    idpAuthority: r['idp_authority'] === true,
    roleAuthorityByProvider: r['by_provider'] === true,
    idpGrant: a?.grant ?? [], idpDeny: a?.deny ?? [],
    scopes: a === undefined ? [] : scopesOfAuthority(a),
  };
}

/** 공급자 행 → 매핑 설정. 저장할 때 이미 검사했다 — 여기서는 모양이 틀린 칸을 버린다(닫힘: 버린 값은 아무것도 열지 않는다). */
function mappingOfRow(r: Row | undefined): ClaimsMapperConfig {
  const roleMap: Record<string, Role> = {};
  for (const [k, v] of Object.entries((r?.['role_map'] ?? {}) as Record<string, unknown>)) if (isRole(v)) roleMap[k] = v;
  const entitlementMap: Record<string, EntitlementEffect> = {};
  for (const [k, v] of Object.entries((r?.['entitlement_map'] ?? {}) as Record<string, unknown>)) if (isEntitlementEffect(v)) entitlementMap[k] = v;
  return {
    roleClaim: r === undefined ? null : opt(r, 'role_claim'),
    roleMap,
    entitlementClaim: r === undefined ? null : opt(r, 'entitlement_claim'),
    entitlementPrefix: r === undefined ? '' : String(r['entitlement_prefix'] ?? ''),
    entitlementMap,
  };
}

export type RoleChangeOutcome =
  /** 반영했다. `sessions` 는 끊은 세션 수(역할을 잃었을 때만 끊는다 — 나머지는 다음 요청이 새 범위로 읽는다). */
  | { kind: 'applied'; from: string; to: string; sessions: number }
  /** 이 사람에게는 반영하지 않는다(연결 없음 · IdP 정본 아님 · 로컬 정지). 감사에만 남는다. */
  | { kind: 'ignored'; why: string }
  /** 같은 jti 를 이미 받았다. */
  | { kind: 'replay' }
  /** 이 사람에게 이미 적용한 것보다 새롭지 않다(늦게 온 옛 스냅숏). */
  | { kind: 'stale' }
  /** 안전장치가 막았다(마지막 관리자 · 관리자 MFA). 역할은 그대로다. */
  | { kind: 'refused'; why: string };

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
  /**
   * IdP OTP. 켜면 `user_identities` 에서 **이 issuer** 와 이어진 사람의 둘째 인증이 IdP OTP 다(로컬 TOTP 대신).
   * issuer 는 OIDC 로그인의 issuer 와 같아야 한다 — 연결의 subject 가 IdP 의 사용자 id 다.
   */
  idpMfa?: { issuer: string; provider: MfaProvider };
  /**
   * 역할 매핑 구현(`./idp-roles/registry.ts` 의 `roleMapperFactory`). 기본은 일반 클레임 매핑(`claims`).
   * 공급자 행의 설정(역할 클레임 · 매핑 · entitlement)을 받아 매퍼를 만든다.
   */
  roleMapper?: (c: ClaimsMapperConfig) => RoleMapper;
};

export class AccountService {
  readonly #db: Db;
  readonly #sealer: Sealer;
  readonly #issuer: string;
  readonly #now: () => number;
  readonly #mail: { mailer: Mailer; base: string } | undefined;
  readonly #localMfa: MfaProvider;
  readonly #idpMfa: { issuer: string; provider: MfaProvider; host: string } | undefined;
  readonly #roleMapper: (c: ClaimsMapperConfig) => RoleMapper;

  constructor(o: AccountServiceOptions) {
    this.#roleMapper = o.roleMapper ?? claimsMapper;
    this.#db = o.db;
    this.#sealer = o.sealer;
    this.#issuer = o.issuer ?? 'barycenter';
    this.#now = o.now ?? Date.now;
    this.#localMfa = localTotp({ sealer: this.#sealer, now: () => this.#now() });
    this.#idpMfa = o.idpMfa === undefined ? undefined : { ...o.idpMfa, host: hostOf(o.idpMfa.issuer) };
    this.#mail = o.mailer !== undefined && o.publicUrl !== undefined && o.publicUrl !== ''
      ? { mailer: o.mailer, base: o.publicUrl.replace(/\/+$/, '') } : undefined;
  }

  /** 화면이 「비밀번호를 잊었다」를 그릴지 고른다. 비밀이 아니다. */
  features(): { mail: boolean } {
    return { mail: this.#mail !== undefined };
  }

  // ── 봉인 — 실패는 던진다(트랜잭션 안에서는 `#tx` 가 「못 물었다」 503 으로 접는다 — 예전과 같다) ──────

  async #seal(plain: Buffer, aad: string): Promise<string> {
    const r = await this.#sealer.seal(plain, aad);
    if (!r.ok) throw new Error(`봉인 실패 (${this.#sealer.kind} · ${r.reason}): ${r.detail}`);
    return r.sealed;
  }

  async #open(sealed: string, aad: string): Promise<Buffer> {
    const r = await this.#sealer.open(sealed, aad);
    if (!r.ok) throw new Error(`봉인 열기 실패 (${r.reason}): ${r.detail}`);
    return r.plain;
  }

  /** IdP OTP 가 켜졌으면 화면에 보일 IdP 이름(issuer 의 호스트). 비밀이 아니다. */
  idpMfaHost(): string | undefined {
    return this.#idpMfa?.host;
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
      const admins = (await c.query(`SELECT 1 FROM users u WHERE ${ADMIN_SQL} AND u.status='active' LIMIT 1`)).rows;
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

  /**
   * 초대를 다시 보낸다 — 아직 쓰이지 않은(대기·만료) 초대만. **옛 링크는 이 순간 죽는다**: 같은 행의 토큰 해시를
   * 새 것으로 바꾸므로 옛 토큰은 어떤 행과도 맞지 않는다. 만료는 지금부터 다시 72시간. 전달은 만들 때와 같다 —
   * 이메일이 있고 메일이 켜져 있으면 메일, 아니면 새 링크가 이 응답에만 한 번 나온다. 쓰인·취소된 초대는 404.
   */
  async resendInvitation(id: string, by: string, meta: Meta = {}): Promise<{ id: string; token: string; expiresAt: string; mailed: boolean }> {
    const t = token();
    const at = new Date(this.#now() + INVITE_TTL_MS);
    const out = await this.#tx(async (c) => {
      const r = (await c.query(
        `UPDATE invitations SET token_hash=$2, expires_at=$3
          WHERE id=$1 AND kind='invite' AND used_at IS NULL AND revoked_at IS NULL
          RETURNING email, role`,
        [id, sha(t), at],
      )).rows[0];
      if (r === undefined) throw new AccountError(404, 'no_invitation', '다시 보낼 수 있는 초대가 아니다');
      const email = opt(r, 'email');
      await this.#audit(c, by, 'account.invite_resend', null, meta, { id, role: str(r, 'role'), email: email !== null });
      return { email, role: str(r, 'role') };
    });
    let mailed = false;
    if (out.email !== null && this.#mail !== undefined) {
      const [subject, text] = mailText.invite(`${this.#mail.base}/invite#${t}`, out.role, INVITE_TTL_MS / 3600_000);
      mailed = await this.#mail.mailer.send(out.email, subject, text).then(() => true, () => false);
    }
    return { id, token: t, expiresAt: at.toISOString(), mailed };
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
      let totp: { sealedFor: (uid: string) => Promise<string>; step: number } | undefined;
      if (input.totp !== undefined || role === 'admin') {
        if (input.totp === undefined) throw new AccountError(400, 'totp_required', '관리자는 인증 앱(TOTP) 등록이 필요하다');
        const secret = base32Decode(input.totp.secret);
        const step = verifyTotp(secret, input.totp.code, this.#now(), 0);
        if (step === undefined) throw new AccountError(400, 'totp_mismatch', '인증 앱의 코드가 맞지 않는다');
        totp = { sealedFor: (uid) => this.#seal(secret, `totp:${uid}`), step };
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
        // 복구는 인증 수단을 처음부터 다시 정하는 일이다 — 옛 수단으로 만든 토큰도 거둔다(사용자 결정 2026-11-04).
        // 비밀번호만 바꾸는 것(`changePassword` · 메일 재설정)은 토큰을 그대로 둔다.
        await this.#revokeAllTokens(c, userId, `user:${userId}`, 'recovery', meta);
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
          [userId, await totp.sealedFor(userId), totp.step],
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

  // ── SSO (로컬 권한 정본) ─────────────────────────────────────────────

  /**
   * OIDC 흐름을 연다. `link` 는 로그인한 사람이 **비밀번호를 다시 넣어야** 연다(공통 정책: 연결은 재인증 뒤).
   * 비밀번호가 없는 계정(JIT 로 생긴 것)은 더 연결하지 못한다 — 그 사람의 유일한 증거가 IdP 다.
   */
  async beginSso(intent: 'login' | 'link', state: string, nonce: string, codeVerifier: string,
    link?: { userId: string; password: string }): Promise<string> {
    if (intent === 'link') {
      if (link === undefined) throw new AccountError(400, 'malformed', '연결은 로그인한 사람만 한다');
      const r = (await this.#q(`SELECT password_hash FROM users WHERE id=$1`, [link.userId]))[0];
      if (r === undefined || r['password_hash'] === null) {
        throw new AccountError(409, 'needs_password', '비밀번호가 없는 계정은 SSO 를 더 잇지 못한다');
      }
      await this.#requirePassword(link.userId, link.password);
    }
    const id = token();
    await this.#q(`DELETE FROM login_flows WHERE expires_at < now()`);
    await this.#q(
      `INSERT INTO login_flows (id_hash, state, nonce, code_verifier, intent, user_id, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [sha(id), state, nonce, codeVerifier, intent, intent === 'link' ? link!.userId : null, new Date(this.#now() + 10 * 60_000)],
    );
    return id;
  }

  /** 흐름을 꺼낸다 — **한 번만.** state 가 맞아야 PKCE 검증값·nonce 를 내준다. */
  async takeSsoFlow(flowId: string | undefined, state: string):
    Promise<{ codeVerifier: string; nonce: string; intent: 'login' | 'link'; userId: string | null } | undefined> {
    if (flowId === undefined || flowId === '') return undefined;
    const r = (await this.#q(
      `DELETE FROM login_flows WHERE id_hash=$1 RETURNING state, nonce, code_verifier, intent, user_id, expires_at`,
      [sha(flowId)],
    ))[0];
    if (r === undefined || str(r, 'state') !== state || new Date(String(r['expires_at'])).getTime() <= this.#now()) return undefined;
    return {
      codeVerifier: str(r, 'code_verifier'), nonce: str(r, 'nonce'),
      intent: str(r, 'intent') as 'login' | 'link', userId: opt(r, 'user_id'),
    };
  }

  /**
   * IdP 가 확인해 준 (iss, sub) 로 끝낸다.
   *   login: 연결된 계정 → 로그인. MFA 가 있는 사람(관리자는 필수)은 둘째 인증 단계 — IdP 의 amr/acr 는 믿지 않는다.
   *          둘째 인증은 로컬 TOTP, 또는 IdP OTP 가 켜졌고 그 IdP 와 이어졌으면 IdP OTP(IdP 에 직접 물어 판정받는다).
   *          연결이 없으면 그 공급자에 JIT 가 켜졌을 때만 계정을 새로 만들고(auditor — 공급자 기본 IdP 정본이면 매핑 결과),
   *          아니면 `not_linked`. 실효 정본이 IdP 면 로그인마다 클레임을 매핑으로 맞춘다(`#syncIdp`).
   *   link : 다른 계정에 이미 묶인 identity 면 거절.
   */
  async completeSso(intent: 'login' | 'link', userIdForLink: string | null, claims: SsoClaims, meta: Meta = {}): Promise<SsoOutcome> {
    if (intent === 'link') {
      await this.#tx(async (c) => {
        const cur = (await c.query(`SELECT user_id FROM user_identities WHERE issuer=$1 AND subject=$2`, [claims.iss, claims.sub])).rows[0];
        if (cur !== undefined && str(cur, 'user_id') !== userIdForLink) {
          throw new AccountError(409, 'identity_taken', '그 SSO 계정은 이미 다른 사람에게 연결돼 있다');
        }
        if (cur === undefined) {
          await c.query(
            `INSERT INTO user_identities (issuer, subject, user_id, linked_by) VALUES ($1,$2,$3,$4)`,
            [claims.iss, claims.sub, userIdForLink, `user:${userIdForLink}`],
          );
        }
        await this.#audit(c, `user:${userIdForLink}`, 'account.sso_link', userIdForLink, meta, { issuer: claims.iss });
      });
      return { kind: 'linked' };
    }
    const userSql = `SELECT u.id, u.username, u.role, u.idp_grant, u.idp_deny, u.status, t.confirmed_at AS totp_at,
              ${IDP_AUTHORITY_SQL} AS idp_authority
         FROM user_identities i JOIN users u ON u.id=i.user_id LEFT JOIN mfa_totp t ON t.user_id=u.id
        WHERE i.issuer=$1 AND i.subject=$2`;
    let row = (await this.#q(userSql, [claims.iss, claims.sub]))[0];
    const provider = (await this.#q(`SELECT ${PROVIDER_COLS} FROM sso_providers WHERE issuer=$1`, [claims.iss]))[0];
    const mapper = this.#roleMapper(mappingOfRow(provider));
    if (row === undefined) {
      if (provider === undefined || provider['jit_enabled'] !== true) return { kind: 'not_linked' };
      // 공급자 기본 정본이 켜졌으면 **만들기 전에** 매핑을 본다 — IdP 가 이 앱의 역할을 안 준 사람의 계정을 만들지 않는다.
      if (provider['idp_authority'] === true) {
        const pre = mapper.fromClaims(claims.raw ?? {});
        if (!pre.ok) {
          await this.#audit(undefined, `sso:${claims.iss}`, 'account.idp_role_refused', null, meta, { why: pre.detail, reason: pre.reason, jit: true });
          return { kind: 'denied' };
        }
      }
      await this.#jitCreate(claims, meta);
      row = (await this.#q(userSql, [claims.iss, claims.sub]))[0];
      if (row === undefined) return { kind: 'denied' };
    }
    // 로컬 정지·삭제가 **언제나 우선**이다 — IdP 가 뭐라 하든.
    if (str(row, 'status') !== 'active') return { kind: 'denied' };
    const userId = str(row, 'id');
    let current = authorityOfRow(row);
    if (current === undefined) return { kind: 'denied' };
    const factor = await this.#factorOf(undefined, userId, row['totp_at'] !== null);
    if (row['idp_authority'] === true) {
      const mapped = mapper.fromClaims(claims.raw ?? {});
      const synced = await this.#syncIdp(userId, mapped, `sso:${claims.iss}`, meta);
      if (synced === undefined) return { kind: 'denied' };
      current = synced;
    }
    await this.#q(`UPDATE user_identities SET last_login_at=now() WHERE issuer=$1 AND subject=$2`, [claims.iss, claims.sub]);
    if (scopesOfAuthority(current).includes('admin') && factor === undefined) return { kind: 'denied' };
    if (factor !== undefined) {
      const sid = await this.#newSession(userId, this.#now() + MFA_PENDING_MS, true, ['sso'], meta);
      return { kind: 'mfa', sessionId: sid, maxAgeS: MFA_PENDING_MS / 1000, method: factor };
    }
    const sid = await this.#newSession(userId, this.#now() + SESSION_MAX_MS, false, ['sso'], meta);
    await this.#audit(undefined, `user:${userId}`, 'session.login', userId, meta, { sso: claims.iss });
    return { kind: 'session', sessionId: sid, maxAgeS: SESSION_MAX_MS / 1000 };
  }

  /**
   * **IdP 정본 계정의 권한 맞추기** — 로그인 때(클레임)와 Role Change 때(SET) 같은 문이다. 매핑 결과(역할 · grant · deny)를
   * 계정 행에 쓴다. 맞출 수 없으면 undefined — 호출자가 **그 로그인을 거부**한다(로컬 역할로 떨어지지 않는다):
   *   · 매핑이 거절했다(클레임 없음 · 매핑에 있는 값 없음 · 모르는 entitlement · 설정 없음)
   *   · 마지막 실효 관리자의 admin 범위를 빼려 한다(관리자가 0 이 되지 않게 — 빼지 않고 거부)
   *   · admin 범위를 새로 주는데 둘째 인증(로컬 TOTP 또는 IdP OTP)이 없다(관리자는 MFA 가 필수)
   * 맞춘 권한은 그 사람의 **다른 세션에도** 다음 요청부터 보인다(`authenticate` 가 매번 읽는다).
   */
  async #syncIdp(userId: string, mapped: RoleMapResult, actor: string, meta: Meta): Promise<IdpAuthority | undefined> {
    if (!mapped.ok) {
      await this.#audit(undefined, actor, 'account.idp_role_refused', userId, meta, { why: mapped.detail, reason: mapped.reason });
      return undefined;
    }
    const out = await this.#tx((c) => this.#applyIdp(c, userId, mapped.value, actor, meta));
    return out.ok ? out.value : undefined;
  }

  /**
   * 권한을 바꾼다(호출자의 트랜잭션 안). 안전장치는 `#syncIdp` 의 둘. 거부는 감사(`account.idp_role_refused`)에 남긴다.
   * 실효 관리자 행을 잠근다 — 둘이 동시에 서로를 내려 관리자가 0 이 되는 경합을 막는다(`updateUser` 와 같다).
   */
  async #applyIdp(c: Queryable, userId: string, next: IdpAuthority, actor: string, meta: Meta):
    Promise<{ ok: true; value: IdpAuthority; from: IdpAuthority } | { ok: false; why: string }> {
    await c.query(`SELECT u.id FROM users u WHERE ${ADMIN_SQL} AND u.status='active' FOR UPDATE`);
    const r = (await c.query(
      `SELECT u.role, u.idp_grant, u.idp_deny, u.status, t.confirmed_at AS totp_at
         FROM users u LEFT JOIN mfa_totp t ON t.user_id=u.id WHERE u.id=$1 FOR UPDATE OF u`, [userId],
    )).rows[0];
    const cur = r === undefined ? undefined : authorityOfRow(r);
    if (r === undefined || cur === undefined) return { ok: false, why: '계정이 없다' };
    if (sameAuthority(cur, next)) return { ok: true, value: cur, from: cur };
    const refuse = async (why: string): Promise<{ ok: false; why: string }> => {
      await this.#audit(c, actor, 'account.idp_role_refused', userId, meta, { why, from: authorityText(cur), to: authorityText(next) });
      return { ok: false, why };
    };
    const wasAdmin = scopesOfAuthority(cur).includes('admin');
    const isAdmin = scopesOfAuthority(next).includes('admin');
    if (isAdmin && !wasAdmin && (await this.#factorOf(c, userId, r['totp_at'] !== null && r['totp_at'] !== undefined)) === undefined) {
      return refuse('관리자 범위를 주려면 둘째 인증(인증 앱 또는 IdP OTP)이 먼저 있어야 한다');
    }
    if (wasAdmin && !isAdmin && str(r, 'status') === 'active') {
      const others = (await c.query(
        `SELECT count(*) AS n FROM users u WHERE ${ADMIN_SQL} AND u.status='active' AND u.id <> $1`, [userId],
      )).rows[0]!;
      if (Number(others['n']) === 0) return refuse('마지막 활성 관리자의 관리자 범위를 빼려 했다');
    }
    await c.query(`UPDATE users SET role=$2, idp_grant=$3, idp_deny=$4, updated_at=now() WHERE id=$1`, [userId, next.role, next.grant, next.deny]);
    await this.#audit(c, actor, 'account.idp_role_sync', userId, meta, { from: authorityText(cur), to: authorityText(next) });
    return { ok: true, value: next, from: cur };
  }

  /**
   * **Role Change 즉시 반영** — IdP 가 push 한 서명된 SET(검증은 호출자가 끝냈다). 다음 로그인을 기다리지 않는다.
   *
   * 한 트랜잭션: jti 를 먼저 적고(같은 SET 의 재전송은 replay), 그 사람의 마지막 txn 보다 새로울 때만(늦게 온 옛 스냅숏은 stale)
   * 로그인과 **같은 매핑 · 같은 안전장치**(`#applyIdp`)로 바꾼다. 열린 세션은 다음 요청부터 새 범위로 읽힌다(`authenticate`).
   *
   * IdP 정본이 아닌 사람 · 연결이 없는 sub · 로컬 정지는 **무시**한다(감사만). 매핑이 거절하면(이 앱의 역할이 없어졌다)
   * 로컬 역할로 떨어지지 않는다 — 모든 범위를 deny 하고 세션을 끊는다(다음 로그인은 매핑이 다시 판정한다).
   */
  async applyRoleChange(issuer: string, ch: RoleChange, meta: Meta = {}): Promise<RoleChangeOutcome> {
    const actor = `sso:${issuer}`;
    return this.#tx(async (c): Promise<RoleChangeOutcome> => {
      const fresh = (await c.query(
        `INSERT INTO idp_set_jti (issuer, jti, expires_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [issuer, ch.jti, new Date(ch.exp * 1000)],
      )).rowCount;
      if (fresh === 0) return { kind: 'replay' };
      const i = (await c.query(
        `SELECT i.user_id, i.role_change_txn::text AS txn, u.status, ${IDP_AUTHORITY_SQL} AS idp_authority
           FROM user_identities i JOIN users u ON u.id=i.user_id WHERE i.issuer=$1 AND i.subject=$2 FOR UPDATE OF i`,
        [issuer, ch.sub],
      )).rows[0];
      if (i === undefined) {
        await this.#audit(c, actor, 'account.idp_role_change_ignored', null, meta, { why: '이 sub 와 이어진 계정이 없다', sub: ch.sub });
        return { kind: 'ignored', why: 'no_identity' };
      }
      const userId = str(i, 'user_id');
      if (i['txn'] !== null && BigInt(str(i, 'txn')) >= ch.txn) return { kind: 'stale' };
      await c.query(`UPDATE user_identities SET role_change_txn=$3 WHERE issuer=$1 AND subject=$2`, [issuer, ch.sub, ch.txn.toString()]);
      const ignore = async (why: string, text: string): Promise<RoleChangeOutcome> => {
        await this.#audit(c, actor, 'account.idp_role_change_ignored', userId, meta, { why: text });
        return { kind: 'ignored', why };
      };
      if (str(i, 'status') !== 'active') return ignore('not_active', '로컬에서 정지 · 삭제된 계정이다(로컬이 우선)');
      if (i['idp_authority'] !== true) return ignore('local_authority', '권한 정본이 로컬이다 — IdP 의 역할 변경을 쓰지 않는다');
      const p = (await c.query(`SELECT ${PROVIDER_COLS} FROM sso_providers WHERE issuer=$1`, [issuer])).rows[0];
      const mapped = this.#roleMapper(mappingOfRow(p)).fromLists({ roles: ch.roles, entitlements: ch.entitlements });
      let next: IdpAuthority;
      if (mapped.ok) {
        next = mapped.value;
      } else {
        const cur = (await c.query(`SELECT role FROM users WHERE id=$1`, [userId])).rows[0];
        const role = cur !== undefined && isRole(cur['role']) ? cur['role'] : 'auditor';
        // 역할을 잃었다 — 로컬 역할로 떨어지지 않게 **모든 범위를 뺀다**. 역할 칸은 그대로 둔다(마지막 관리자 판정이 같은 문을 지난다).
        next = { role, grant: [], deny: [...ALL_SCOPES] };
        await this.#audit(c, actor, 'account.idp_role_refused', userId, meta, { why: mapped.detail, reason: mapped.reason, roleChange: true });
      }
      const out = await this.#applyIdp(c, userId, next, actor, meta);
      if (!out.ok) return { kind: 'refused', why: out.why };
      let sessions = 0;
      if (!scopesOfAuthority(out.value).includes('read')) {
        sessions = (await c.query(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [userId])).rowCount ?? 0;
      }
      const from = authorityText(out.from);
      const to = authorityText(out.value);
      await this.#audit(c, actor, 'account.idp_role_change', userId, meta, { from, to, sessions });
      return { kind: 'applied', from, to, sessions };
    });
  }

  /**
   * JIT — **새 계정만** 만든다(이름·이메일이 같은 기존 계정에 붙이지 않는다). 처음에는 auditor · 비밀번호 없음 · 이메일 없음
   * (IdP 의 이메일을 확인된 주소로 믿지 않는다). 공급자 기본 정본이 켜졌으면 바로 이어 매핑 결과로 맞춘다(`completeSso`).
   * 이름이 겹치면 짧은 접미사를 붙인다.
   */
  async #jitCreate(claims: SsoClaims, meta: Meta): Promise<string> {
    const base = (claims.preferredUsername ?? '').toLowerCase().replace(/[^a-z0-9._-]/g, '').replace(/^[^a-z0-9]+/, '').slice(0, 50)
      || `sso-${sha(`${claims.iss}|${claims.sub}`).slice(0, 8)}`;
    return this.#tx(async (c) => {
      let name = base.length >= 2 ? base : `${base}-u`;
      for (let i = 0; (await c.query(`SELECT 1 FROM users WHERE username=$1`, [name])).rows.length > 0; i++) {
        if (i > 5) throw new AccountError(409, 'conflict', '쓸 수 있는 이름을 못 골랐다');
        name = `${base.slice(0, 50)}-${randomBytes(2).toString('hex')}`;
      }
      const id = str((await c.query(
        `INSERT INTO users (username, role, created_by) VALUES ($1,'auditor',$2) RETURNING id`, [name, `sso:${claims.iss}`],
      )).rows[0]!, 'id');
      await c.query(
        `INSERT INTO user_identities (issuer, subject, user_id, linked_by) VALUES ($1,$2,$3,'jit')`, [claims.iss, claims.sub, id],
      );
      await this.#audit(c, `sso:${claims.iss}`, 'account.jit_create', id, meta);
      return id;
    });
  }

  /** 다른 로그인 수단(비밀번호 또는 다른 identity)이 남을 때만 끊는다 — 스스로 잠기지 않게. */
  async unlinkIdentity(userId: string, issuer: string, subject: string, password: string, meta: Meta = {}): Promise<void> {
    await this.#requirePassword(userId, password);
    await this.#tx(async (c) => {
      const n = (await c.query(`DELETE FROM user_identities WHERE issuer=$1 AND subject=$2 AND user_id=$3`, [issuer, subject, userId])).rowCount;
      if (n === 0) throw new AccountError(404, 'no_identity', '그 연결이 없다');
      // IdP OTP 가 관리자의 유일한 둘째 인증이면 끊지 않는다 — 관리자는 MFA 가 필수다(인증 앱 해제를 막는 것과 같다).
      const u = (await c.query(
        `SELECT ${ADMIN_SQL} AS admin, t.confirmed_at FROM users u LEFT JOIN mfa_totp t ON t.user_id=u.id WHERE u.id=$1`, [userId],
      )).rows[0];
      if (u !== undefined && u['admin'] === true
        && (await this.#factorOf(c, userId, u['confirmed_at'] !== null && u['confirmed_at'] !== undefined)) === undefined) {
        throw new AccountError(409, 'admin_needs_mfa', '관리자의 유일한 둘째 인증(IdP OTP)이라 끊을 수 없다 — 먼저 인증 앱을 등록한다');
      }
      // 공급자 기본 정본으로 IdP 정본이던 사람이 연결을 끊으면 로컬 정본이 된다 — IdP 가 준 grant/deny 를 남기지 않는다.
      await this.#settleLocal(c, userId);
      await this.#audit(c, `user:${userId}`, 'account.sso_unlink', userId, meta, { issuer });
    });
  }

  /**
   * 실효 정본이 로컬이면 IdP 가 준 grant/deny 를 지운다(호출자의 트랜잭션 안). 로컬 정본에서는 역할만이 권한이다.
   * 지우면 범위가 늘 수 있다(deny 가 사라진다) — 그래서 정본을 로컬로 돌리는 것은 관리자만 하는 일이다(`updateUser` ·
   * 공급자 기본 정본 끄기). 연결 끊기는 그 사람의 역할을 넘지 않는다(역할 범위로 돌아갈 뿐이다).
   */
  async #settleLocal(c: Queryable, userId?: string): Promise<void> {
    await c.query(
      `UPDATE users u SET idp_grant='{}', idp_deny='{}' WHERE (cardinality(u.idp_grant) > 0 OR cardinality(u.idp_deny) > 0)
          AND NOT ${IDP_AUTHORITY_SQL} ${userId === undefined ? '' : 'AND u.id=$1'}`,
      userId === undefined ? [] : [userId],
    );
  }

  async providers(): Promise<unknown[]> {
    return (await this.#q(`SELECT ${PROVIDER_COLS} FROM sso_providers ORDER BY issuer`)).map((r) => {
      const m = mappingOfRow(r);
      return {
        issuer: str(r, 'issuer'), jitEnabled: r['jit_enabled'] === true, jitRole: str(r, 'jit_role'),
        roleClaim: m.roleClaim, roleMap: m.roleMap,
        /** 이 공급자의 SSO 사용자는 모두 IdP 권한 정본이다. */
        idpAuthority: r['idp_authority'] === true,
        entitlementClaim: m.entitlementClaim, entitlementPrefix: m.entitlementPrefix, entitlementMap: m.entitlementMap,
        updatedAt: iso(r['updated_at']), updatedBy: str(r, 'updated_by'),
      };
    });
  }

  /**
   * 공급자의 권한 매핑 — 역할 클레임 · 매핑, entitlement 클레임 · 접두 · 표. **준 칸만** 바꾼다. `profile`(lodestar · keycloak ·
   * entra · okta)을 주면 그 프로필의 클레임 자리로 먼저 채우고, 같이 준 칸이 그 위에 덮는다. 저장 전에 전체 모양을 본다.
   */
  async setProviderMapping(issuer: string, input: {
    profile?: unknown; roleClaim?: unknown; roleMap?: unknown;
    entitlementClaim?: unknown; entitlementPrefix?: unknown; entitlementMap?: unknown;
  }, by: string, meta: Meta = {}): Promise<void> {
    if (issuer.trim() === '') throw new AccountError(400, 'malformed', 'issuer 가 비었다');
    const bad = (m: string): never => { throw new AccountError(400, 'malformed', m); };
    const nullableStr = (v: unknown, what: string): string | null =>
      (v === null || v === '' ? null : typeof v === 'string' ? v.trim() : bad(`'${what}' 은 문자열 또는 null 이다`));
    const obj = (v: unknown, what: string): Record<string, unknown> =>
      (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : bad(`'${what}' 은 객체다`));
    await this.#tx(async (c) => {
      const cur = mappingOfRow((await c.query(`SELECT ${PROVIDER_COLS} FROM sso_providers WHERE issuer=$1 FOR UPDATE`, [issuer])).rows[0]);
      let next: ClaimsMapperConfig = { ...cur };
      if (input.profile !== undefined) {
        const p = typeof input.profile === 'string' ? roleProfile(input.profile) : undefined;
        if (p === undefined) bad(`모르는 프로필: ${String(input.profile)} (lodestar · keycloak · entra · okta)`);
        next = { ...next, ...p! };
      }
      if (input.roleClaim !== undefined) next.roleClaim = nullableStr(input.roleClaim, 'roleClaim');
      if (input.roleMap !== undefined) next.roleMap = obj(input.roleMap, 'roleMap') as Record<string, Role>;
      if (input.entitlementClaim !== undefined) next.entitlementClaim = nullableStr(input.entitlementClaim, 'entitlementClaim');
      if (input.entitlementPrefix !== undefined) {
        next.entitlementPrefix = typeof input.entitlementPrefix === 'string' ? input.entitlementPrefix.trim() : bad("'entitlementPrefix' 는 문자열이다");
      }
      if (input.entitlementMap !== undefined) next.entitlementMap = obj(input.entitlementMap, 'entitlementMap') as Record<string, EntitlementEffect>;
      const problem = claimsConfigProblem(next);
      if (problem !== undefined) bad(problem);
      await c.query(
        `INSERT INTO sso_providers (issuer, role_claim, role_map, entitlement_claim, entitlement_prefix, entitlement_map, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (issuer) DO UPDATE SET role_claim=EXCLUDED.role_claim, role_map=EXCLUDED.role_map,
           entitlement_claim=EXCLUDED.entitlement_claim, entitlement_prefix=EXCLUDED.entitlement_prefix,
           entitlement_map=EXCLUDED.entitlement_map, updated_at=now(), updated_by=EXCLUDED.updated_by`,
        [issuer, next.roleClaim, JSON.stringify(next.roleMap), next.entitlementClaim, next.entitlementPrefix,
          JSON.stringify(next.entitlementMap), by],
      );
      await this.#audit(c, by, 'account.sso_roles', null, meta, {
        issuer, roleClaim: next.roleClaim, keys: Object.keys(next.roleMap).length,
        entitlementClaim: next.entitlementClaim, entitlementPrefix: next.entitlementPrefix, entitlements: Object.keys(next.entitlementMap).length,
      });
    });
  }

  /**
   * 「이 공급자의 SSO 사용자는 모두 IdP 권한 정본」 켬/끔. **켜려면 역할 클레임 · 매핑이 먼저 있어야 한다** — 없이 켜면 그 공급자로
   * 오는 사람이 모두 로그인 거부된다(관리자 포함). 켜는 순간 역할을 바꾸지 않는다 — 다음 SSO 로그인 · Role Change 가 안전장치를
   * 지나며 맞춘다. 끄면 그 사람들은 각자의 정본으로 돌아가고, 로컬 정본이 된 사람의 grant/deny 는 지운다(역할만 남는다).
   */
  async setProviderAuthority(issuer: string, enabled: boolean, by: string, meta: Meta = {}): Promise<void> {
    if (issuer.trim() === '') throw new AccountError(400, 'malformed', 'issuer 가 비었다');
    await this.#tx(async (c) => {
      if (enabled) {
        const m = mappingOfRow((await c.query(`SELECT ${PROVIDER_COLS} FROM sso_providers WHERE issuer=$1`, [issuer])).rows[0]);
        if (m.roleClaim === null || Object.keys(m.roleMap).length === 0) {
          throw new AccountError(409, 'roles_not_configured', '역할 클레임과 매핑을 먼저 저장한다 — 없이 켜면 이 공급자로 오는 사람이 모두 로그인을 거부당한다');
        }
      }
      await c.query(
        `INSERT INTO sso_providers (issuer, idp_authority, updated_by) VALUES ($1,$2,$3)
         ON CONFLICT (issuer) DO UPDATE SET idp_authority=EXCLUDED.idp_authority, updated_at=now(), updated_by=EXCLUDED.updated_by`,
        [issuer, enabled, by],
      );
      if (!enabled) await this.#settleLocal(c);
      await this.#audit(c, by, 'account.sso_authority', null, meta, { issuer, enabled });
    });
  }

  /** 공급자별 JIT — 관리자가 **명시적으로** 켠다(공통 정책). 켜도 auditor 만. */
  async setProviderJit(issuer: string, enabled: boolean, by: string, meta: Meta = {}): Promise<void> {
    if (issuer.trim() === '') throw new AccountError(400, 'malformed', 'issuer 가 비었다');
    await this.#tx(async (c) => {
      await c.query(
        `INSERT INTO sso_providers (issuer, jit_enabled, updated_by) VALUES ($1,$2,$3)
         ON CONFLICT (issuer) DO UPDATE SET jit_enabled=EXCLUDED.jit_enabled, updated_at=now(), updated_by=EXCLUDED.updated_by`,
        [issuer, enabled, by],
      );
      await this.#audit(c, by, 'account.sso_jit', null, meta, { issuer, enabled });
    });
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
              t.confirmed_at AS totp_at, ${ADMIN_SQL} AS admin
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
    const locked = this.#locked(u['locked_until'], now);
    const ok = await verifyPassword(password, str(u, 'password_hash'));
    if (!ok || locked || str(u, 'status') !== 'active') {
      if (!ok) await this.#failed(userId, Number(u['failed_logins']), meta);
      return { kind: 'denied' };
    }
    const factor = await this.#factorOf(undefined, userId, u['totp_at'] !== null);
    // **둘째 인증이 있으면 여기서 실패 계수를 지우지 않는다** — 비밀번호를 아는 상대가 로그인을 되풀이해
    // 계수를 지우며 인증 코드를 무한히 넣을 수 있다. 지우는 것은 MFA 단계가 성공했을 때다.
    if (factor === undefined) await this.#q(`UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=$1`, [userId]);
    if (needsRehash(str(u, 'password_hash'))) {
      await this.#q(`UPDATE users SET password_hash=$2 WHERE id=$1`, [userId, await hashPassword(password)]);
    }
    // admin 인데 MFA 가 없는 상태는 만들지 않지만(수락·승격이 막는다), 만들어졌다면 들이지 않는다.
    if (u['admin'] === true && factor === undefined) return { kind: 'denied' };
    if (factor !== undefined) {
      const sid = await this.#newSession(userId, now + MFA_PENDING_MS, true, ['pwd'], meta);
      return { kind: 'mfa', sessionId: sid, maxAgeS: MFA_PENDING_MS / 1000, method: factor };
    }
    const sid = await this.#newSession(userId, now + SESSION_MAX_MS, false, ['pwd'], meta);
    await this.#audit(undefined, `user:${str(u, 'username')}`, 'session.login', userId, meta);
    return { kind: 'session', sessionId: sid, maxAgeS: SESSION_MAX_MS / 1000 };
  }

  #locked(lockedUntil: unknown, now: number): boolean {
    return lockedUntil !== null && lockedUntil !== undefined && new Date(String(lockedUntil)).getTime() > now;
  }

  /**
   * 계정 단위 잠금 — 인스턴스를 가리지 않는다(공용 PG). 비밀번호·인증 코드 실패를 같이 센다.
   * **5번째 실패부터** 1초, 2초, 4초 … 최대 15분(공통 수치 1차 — 지수 지연, 영구 잠금 없음). 마지막 실패 뒤
   * 15분이 지났으면 처음부터 센다. 증가는 SQL 한 문장이라 동시에 온 실패도 빠지지 않는다.
   */
  async #failed(userId: string, _prev: number, meta: Meta, c?: Queryable): Promise<void> {
    const run = async (q: Queryable): Promise<number> => {
      const r = (await q.query(
        `UPDATE users SET failed_logins = CASE WHEN last_failed_at IS NULL OR last_failed_at < $2 THEN 1 ELSE failed_logins + 1 END,
                          last_failed_at = $3
          WHERE id=$1 RETURNING failed_logins`,
        [userId, new Date(this.#now() - LOCK_MAX_MS), new Date(this.#now())],
      )).rows[0];
      const n = Number(r?.['failed_logins'] ?? 0);
      const ms = backoffMs(n);
      await q.query(`UPDATE users SET locked_until=$2 WHERE id=$1`, [userId, ms === 0 ? null : new Date(this.#now() + ms)]);
      return n;
    };
    const n = c !== undefined ? await run(c) : await this.#tx(run);
    const lockMs = backoffMs(n);
    if (lockMs > 0) await this.#audit(c, 'system', 'account.locked', userId, meta, { failures: n });
  }

  /**
   * **IP 단위 시도 제한** (공통 수치 1차) — 공용 계정 PG 에서 센다. 여러 인스턴스가 같은 값을 본다.
   * 막혀 있으면 남은 초, 아니면 undefined. **검증보다 먼저 묻는다** — 막힌 동안에는 비밀번호를 보지 않는다.
   */
  async throttleWait(key: string): Promise<number | undefined> {
    const r = (await this.#q(`SELECT blocked_until FROM auth_throttle WHERE key=$1`, [key]))[0];
    if (r === undefined || r['blocked_until'] === null) return undefined;
    const left = new Date(String(r['blocked_until'])).getTime() - this.#now();
    return left > 0 ? Math.ceil(left / 1000) : undefined;
  }

  /**
   * 실패(또는 세는 요청) 하나를 더한다. 마지막 실패에서 15분이 지났으면 처음부터 센다 — 영구 잠금은 없다.
   * 성공해도 지우지 않는다: 같은 IP 의 다른 계정 성공으로 공격자의 계수가 지워지면 안 된다.
   */
  async throttleFail(key: string): Promise<number | undefined> {
    const now = new Date(this.#now());
    const fresh = new Date(this.#now() - LOCK_MAX_MS);
    const r = (await this.#q(
      `INSERT INTO auth_throttle (key, failures, last_failure_at) VALUES ($1, 1, $2)
       ON CONFLICT (key) DO UPDATE SET
         failures = CASE WHEN auth_throttle.last_failure_at < $3 THEN 1 ELSE auth_throttle.failures + 1 END,
         last_failure_at = $2
       RETURNING failures`,
      [key, now, fresh],
    ))[0]!;
    const ms = backoffMs(Number(r['failures']));
    if (ms === 0) return undefined;
    await this.#q(`UPDATE auth_throttle SET blocked_until=$2 WHERE key=$1`, [key, new Date(this.#now() + ms)]);
    return Math.ceil(ms / 1000);
  }

  /**
   * 보존 기한 정리 (공통 수치 1차) — 감사 기록 1년, 끝난 시도 계수. 여러 인스턴스가 동시에 돌려도 같다.
   */
  async purgeExpired(): Promise<{ audit: number }> {
    const audit = (await this.#q(
      `WITH d AS (DELETE FROM account_audit WHERE at < $1 RETURNING 1) SELECT count(*)::int AS n FROM d`,
      [new Date(this.#now() - AUDIT_RETENTION_MS)],
    ))[0]!;
    await this.#q(`DELETE FROM auth_throttle WHERE last_failure_at < $1`, [new Date(this.#now() - LOCK_MAX_MS)]);
    // 수명이 지난 SET 의 jti — 그 뒤의 재전송은 exp 검사가 막는다.
    await this.#q(`DELETE FROM idp_set_jti WHERE expires_at < $1`, [new Date(this.#now())]);
    return { audit: Number(audit['n']) };
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
        `SELECT s.user_id, s.created_at, u.username, u.failed_logins, u.locked_until, u.status
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.id_hash=$1 AND s.mfa_pending AND s.revoked_at IS NULL AND s.expires_at > now()
          FOR UPDATE OF s, u`,
        [sha(pendingId)],
      )).rows[0];
      if (s === undefined || str(s, 'status') !== 'active') return { kind: 'denied' } as const;
      const userId = str(s, 'user_id');
      // 인증 코드도 같은 계정 잠금에 걸린다 — 비밀번호를 아는 상대가 코드를 무작정 넣는 길을 막는다.
      if (this.#locked(s['locked_until'], now)) return { kind: 'denied' } as const;
      const f = await this.#secondFactor(c, userId, code);
      if (!f.ok) {
        // 틀린 코드만 계정 잠금에 센다. IdP 에 못 물었다 · IdP 가 막았다는 사람 말로 거절한다 — 닫힘이다.
        if (f.reason !== 'wrong-code') throw idpMfaRefusal(f.reason);
        await this.#failed(userId, Number(s['failed_logins']), meta, c);
        return { kind: 'denied' } as const;
      }
      const method = f.method;
      await c.query(`UPDATE sessions SET revoked_at=now() WHERE id_hash=$1`, [sha(pendingId)]);
      const sid = token();
      await c.query(
        `INSERT INTO sessions (id_hash, user_id, expires_at, mfa_pending, auth_methods, mfa_at, ip, user_agent)
         VALUES ($1,$2,$3,false,$4,now(),$5,$6)`,
        [sha(sid), userId, new Date(now + SESSION_MAX_MS), ['pwd', method], meta.ip ?? null, meta.userAgent ?? null],
      );
      await c.query(`UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=$1`, [userId]);
      await this.#markLogin(c, userId);
      await this.#audit(c, `user:${str(s, 'username')}`, 'session.login', userId, meta, { mfa: method });
      return { kind: 'session', sessionId: sid, maxAgeS: SESSION_MAX_MS / 1000 } as const;
    });
  }

  /**
   * 둘째 인증 수단 하나 — 그 사람의 제공자(로컬 TOTP 또는 IdP OTP) 또는 복구 코드. **로그인 MFA 와 step-up 이
   * 이 문 하나를 쓴다.** 복구 코드(xxxx-xxxx)는 언제나 로컬이고, OTP 와 모양이 겹치지 않아 IdP 에 보내지 않는다.
   * IdP 의 실패(unavailable 등)는 그대로 돌려준다 — 로컬 TOTP 로 몰래 넘어가지 않는다.
   */
  async #secondFactor(c: Queryable, userId: string, code: string):
  Promise<{ ok: true; method: MfaMethod | 'recovery' } | { ok: false; reason: MfaFailure; detail: string }> {
    if (/^[a-z0-9]{4}-[a-z0-9]{4}$/i.test(code.trim())) {
      const used = (await c.query(
        `UPDATE mfa_recovery_codes SET used_at=now() WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL`,
        [userId, sha(code.trim().toLowerCase())],
      )).rowCount;
      return used === 1 ? { ok: true, method: 'recovery' } : { ok: false, reason: 'wrong-code', detail: '복구 코드가 맞지 않는다' };
    }
    const subject = await this.#idpSubject(c, userId);
    const provider = subject !== undefined && this.#idpMfa !== undefined ? this.#idpMfa.provider : this.#localMfa;
    const r = await provider.verify({ userId, subject, code, db: c });
    if (r.ok) return { ok: true, method: provider.method };
    if (r.reason !== 'wrong-code') {
      // 운영자가 원인을 찾게 남긴다. 코드 · 서비스 토큰은 detail 에도 없다.
      log.warn('accounts.mfa_idp_failed', { reason: r.reason, detail: r.detail, user: userId });
    }
    return r;
  }

  /** 그 사람의 IdP 주체 — IdP OTP 가 켜졌고 **같은 issuer** 와 이어졌을 때만. 연결이 여럿이면 먼저 이은 것. */
  async #idpSubject(c: Queryable | undefined, userId: string): Promise<string | undefined> {
    if (this.#idpMfa === undefined) return undefined;
    const q = `SELECT subject FROM user_identities WHERE user_id=$1 AND issuer=$2 ORDER BY linked_at LIMIT 1`;
    const v = [userId, this.#idpMfa.issuer];
    const r = (c !== undefined ? (await c.query(q, v)).rows : await this.#q(q, v))[0];
    return r === undefined ? undefined : str(r, 'subject');
  }

  /** 「MFA 가 있다」 판정 — 있으면 그 종류(IdP OTP 연결이 앞선다), 없으면 undefined. */
  async #factorOf(c: Queryable | undefined, userId: string, hasTotp: boolean): Promise<SecondFactorKind | undefined> {
    if ((await this.#idpSubject(c, userId)) !== undefined) return 'idp';
    return hasTotp ? 'totp' : undefined;
  }

  /**
   * **민감 작업 앞의 재확인** (step-up). 지금 세션에 MFA 시각을 새로 찍는다 — 세션을 새로 만들지 않는다.
   * 둘째 인증(인증 앱 또는 IdP OTP 연결)이 없으면 할 수 없다(먼저 등록한다).
   */
  async stepUp(sessionHash: string, userId: string, code: string, meta: Meta = {}): Promise<void> {
    await this.#tx(async (c) => {
      const t = (await c.query(
        `SELECT 1 FROM mfa_totp t WHERE t.user_id=$1 AND t.confirmed_at IS NOT NULL FOR UPDATE`, [userId],
      )).rows[0];
      if ((await this.#factorOf(c, userId, t !== undefined)) === undefined) {
        throw new AccountError(409, 'no_totp', '인증 앱을 먼저 등록한다 — 민감 작업은 MFA 가 필요하다');
      }
      const u = (await c.query(`SELECT failed_logins, locked_until FROM users WHERE id=$1 FOR UPDATE`, [userId])).rows[0]!;
      if (this.#locked(u['locked_until'], this.#now())) {
        throw new AccountError(429, 'locked', '실패가 너무 많다 — 잠시 뒤 다시 한다');
      }
      const f = await this.#secondFactor(c, userId, code);
      if (!f.ok) {
        if (f.reason !== 'wrong-code') throw idpMfaRefusal(f.reason);
        await this.#failed(userId, Number(u['failed_logins']), meta, c);
        throw new AccountError(403, 'step_up_failed', '인증 코드가 맞지 않는다');
      }
      const method = f.method;
      await c.query(`UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=$1`, [userId]);
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
        WHERE s.id_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > now() AND NOT s.mfa_pending AND u.status='active'
          AND NOT ('read' = ANY(u.idp_deny))
          AND s.last_seen_at > now() - make_interval(secs => $2::double precision / 1000)`,
      [sessionHash, SESSION_IDLE_MS],
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
    // MFA 를 기다리는 세션은 아직 로그인이 아니다 — 끝난 세션만 「마지막 로그인」에 적는다.
    if (!pending) await this.#markLogin(undefined, userId);
    return sid;
  }

  /** 쓸 수 있는 세션이 생긴 순간 — 비밀번호(MFA 없음)·SSO·MFA 완료가 모두 여기로 온다. */
  async #markLogin(c: Queryable | undefined, userId: string): Promise<void> {
    const q = `UPDATE users SET last_login_at=$2 WHERE id=$1`;
    const v = [userId, new Date(this.#now())];
    if (c !== undefined) await c.query(q, v);
    else await this.#q(q, v);
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
      `SELECT s.user_id, s.mfa_at, s.last_seen_at, u.username, u.role, u.idp_grant, u.idp_deny
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > now() AND NOT s.mfa_pending
          AND s.last_seen_at > now() - make_interval(secs => $2::double precision / 1000)
          AND u.status='active'`,
      [h, SESSION_IDLE_MS],
    ))[0];
    if (r === undefined) return undefined;
    const a = authorityOfRow(r);
    if (a === undefined) return undefined;
    const role = a.role;
    // **실효 범위** = 역할 범위 ∪ grant − deny (IdP 정본 계정의 grant/deny — 로컬 정본은 비어 있다). 요청마다 읽는다 —
    // Role Change 가 바꾼 범위가 열린 세션에 다음 요청부터 보인다.
    const scopes = scopesOfAuthority(a);
    const mfaAt = r['mfa_at'] === null ? undefined : new Date(String(r['mfa_at'])).getTime();
    // 관리자 범위는 MFA 를 거친 세션만 — 세션 도중 admin 으로 올라도(역할이든 grant 든) 그 세션으로는 관리자가 못 된다.
    if (scopes.includes('admin') && mfaAt === undefined) return undefined;
    if (this.#now() - new Date(String(r['last_seen_at'])).getTime() > TOUCH_EVERY_MS) {
      await this.#q(`UPDATE sessions SET last_seen_at=now() WHERE id_hash=$1`, [h]);
    }
    return {
      name: `user:${str(r, 'username')}`, role, scopes: new Set(scopes),
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
      `SELECT u.id, u.username, u.display_name, u.email, u.role, u.role_authority, u.created_at, u.idp_grant, u.idp_deny,
              ${IDP_AUTHORITY_SQL} AS idp_authority, ${PROVIDER_AUTHORITY_SQL} AS by_provider,
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
    const identities = (await this.#q(
      `SELECT issuer, subject, linked_at, last_login_at FROM user_identities WHERE user_id=$1 ORDER BY linked_at`, [userId],
    )).map((i) => ({ issuer: str(i, 'issuer'), subject: str(i, 'subject'), linkedAt: iso(i['linked_at']), lastLoginAt: isoOpt(i['last_login_at']) }));
    const hasPassword = (await this.#q(`SELECT password_hash IS NOT NULL AS p FROM users WHERE id=$1`, [userId]))[0]?.['p'] === true;
    const idp = this.#idpMfa !== undefined && (await this.#idpSubject(undefined, userId)) !== undefined ? this.#idpMfa.host : undefined;
    return {
      identities, hasPassword,
      id: str(u, 'id'), username: str(u, 'username'), displayName: opt(u, 'display_name'),
      email: opt(u, 'email'), role: str(u, 'role'), ...authorityView(u),
      createdAt: iso(u['created_at']),
      // method: 로그인 · step-up 이 받는 코드. 'idp' 면 그 IdP 의 인증 앱 코드다(로컬 인증 앱이 있어도 쓰지 않는다).
      mfa: {
        totp: u['totp_at'] !== null, recoveryCodesLeft: Number(u['codes_left']),
        method: idp === undefined ? 'totp' : 'idp', ...(idp === undefined ? {} : { idp }),
      },
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
        `INSERT INTO mfa_totp (user_id, secret_sealed, created_at) VALUES ($1,$2,$3)
         ON CONFLICT (user_id) DO UPDATE SET secret_sealed=EXCLUDED.secret_sealed, last_step=0, created_at=EXCLUDED.created_at`,
        [userId, await this.#seal(secret, `totp:${userId}`), new Date(this.#now())],
      );
    });
    return { secret: base32Encode(secret), uri: otpauthUri(secret, username, this.#issuer) };
  }

  async confirmTotp(userId: string, code: string, meta: Meta = {}): Promise<string[]> {
    return this.#tx(async (c) => {
      const t = (await c.query(`SELECT secret_sealed, confirmed_at, created_at FROM mfa_totp WHERE user_id=$1 FOR UPDATE`, [userId])).rows[0];
      if (t === undefined || t['confirmed_at'] !== null) throw new AccountError(409, 'no_pending_totp', '확인할 등록이 없다');
      if (new Date(String(t['created_at'])).getTime() + TOTP_SETUP_TTL_MS < this.#now()) {
        throw new AccountError(410, 'totp_setup_expired', '인증 앱 등록이 만료됐다(24시간) — 처음부터 다시 등록한다');
      }
      const step = verifyTotp(await this.#open(str(t, 'secret_sealed'), `totp:${userId}`), code, this.#now(), 0);
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
      const u = (await c.query(`SELECT ${ADMIN_SQL} AS admin FROM users u WHERE u.id=$1`, [userId])).rows[0];
      if (u !== undefined && u['admin'] === true) throw new AccountError(409, 'admin_needs_mfa', '관리자는 인증 앱을 해제할 수 없다');
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

  // ── 개인 API 토큰 ────────────────────────────────────────────────────
  //
  // 한 사람의 것이다. 역할은 발급 때 주인의 역할 이하로 고르고, 인증할 때마다 주인의 **지금** 역할로 다시 깎는다.
  // 값은 발급 응답에 한 번만 나간다 — 저장·감사·로그에는 해시도 값도 남기지 않는다(감사는 id·이름·역할·만료).

  /** 철회되지 않은 내 토큰. 만료된 것도 보인다(「만료」로) — 사라지면 왜 안 되는지 알 길이 없다. */
  async listTokens(userId: string): Promise<ApiTokenRow[]> {
    if (!UUID.test(userId)) return [];
    return (await this.#q(
      `SELECT id, name, role, lookup, created_at, expires_at, last_used_at FROM api_tokens
        WHERE user_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC`, [userId],
    )).map((r) => ({
      id: str(r, 'id'), name: str(r, 'name'), role: str(r, 'role') as Role, prefix: `bary_${str(r, 'lookup')}`,
      createdAt: isoAt(r['created_at']), expiresAt: isoAt(r['expires_at']),
      lastUsedAt: r['last_used_at'] === null ? null : isoAt(r['last_used_at']),
    }));
  }

  /**
   * 토큰을 만든다. **역할은 주인의 지금 역할 이하**, 만료는 1–365일(정수, 기본 90). 주인은 active 여야 한다.
   * 돌려주는 `token` 은 이번 한 번만 보인다 — 서버에는 SHA-256 만 남는다.
   */
  async issueToken(userId: string, input: { name: unknown; role: unknown; expiresInDays?: unknown }, actor: string, meta: Meta = {}):
    Promise<ApiTokenRow & { token: string }> {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!TOKEN_NAME.test(name)) {
      throw new AccountError(400, 'bad_token_name', '이름은 영문·숫자로 시작하고 영문, 숫자, 점(.), 밑줄(_), 하이픈(-)만 쓸 수 있다. 63자까지다');
    }
    if (!isRole(input.role)) throw new AccountError(400, 'malformed', '역할은 auditor | operator | admin 이다');
    const role = input.role;
    const days = input.expiresInDays === undefined ? TOKEN_DEFAULT_DAYS : input.expiresInDays;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > TOKEN_MAX_DAYS) {
      throw new AccountError(400, 'bad_expiry', `만료는 1–${TOKEN_MAX_DAYS}일(정수)이다 — 만료 없는 토큰은 없다`);
    }
    if (!UUID.test(userId)) throw new AccountError(404, 'no_user', '계정이 없다');
    const lookup = randomBytes(8).toString('hex');
    const value = `bary_${lookup}_${randomBytes(32).toString('base64url')}`;
    const created = new Date(this.#now());
    const expires = new Date(created.getTime() + days * DAY_MS);
    return this.#tx(async (c) => {
      const u = (await c.query(`SELECT role, status FROM users WHERE id=$1 FOR UPDATE`, [userId])).rows[0];
      if (u === undefined || str(u, 'status') !== 'active') throw new AccountError(404, 'no_user', '쓸 수 있는 계정이 아니다');
      const owner = str(u, 'role');
      if (!isRole(owner) || roleRank(role) > roleRank(owner)) {
        throw new AccountError(403, 'role_exceeds_owner', `토큰 역할은 내 역할(${owner}) 이하로만 고른다`);
      }
      const n = (await c.query(`SELECT count(*) AS n FROM api_tokens WHERE user_id=$1 AND revoked_at IS NULL`, [userId])).rows[0]!;
      if (Number(n['n']) >= TOKEN_MAX_PER_USER) {
        throw new AccountError(409, 'too_many_tokens', `토큰은 ${TOKEN_MAX_PER_USER}개까지다 — 안 쓰는 것을 먼저 폐기한다`);
      }
      const id = str((await c.query(
        `INSERT INTO api_tokens (user_id, name, role, lookup, token_hash, created_at, created_by, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [userId, name, role, lookup, sha(value), created, actor, expires],
      )).rows[0]!, 'id');
      await this.#audit(c, actor, 'account.token_issue', userId, meta, { tokenId: id, name, role, expiresAt: expires.toISOString() });
      return {
        id, name, role, prefix: `bary_${lookup}`, createdAt: created.toISOString(), expiresAt: expires.toISOString(),
        lastUsedAt: null, token: value,
      };
    });
  }

  /**
   * 토큰을 폐기한다 — `ownerId` 의 것만. 내 토큰은 나, 남의 토큰은 관리자 경로가 주인 id 를 넘긴다.
   * 없거나·이미 폐기됐거나·남의 것이면 똑같이 404 다.
   */
  async revokeToken(ownerId: string, tokenId: string, actor: string, meta: Meta = {}): Promise<void> {
    if (!UUID.test(ownerId) || !UUID.test(tokenId)) throw new AccountError(404, 'no_token', '그런 토큰이 없다');
    await this.#tx(async (c) => {
      const r = (await c.query(
        `UPDATE api_tokens SET revoked_at=$3, revoked_by=$4 WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL
         RETURNING name, role, expires_at`,
        [tokenId, ownerId, new Date(this.#now()), actor],
      )).rows[0];
      if (r === undefined) throw new AccountError(404, 'no_token', '그런 토큰이 없다');
      await this.#audit(c, actor, 'account.token_revoke', ownerId, meta, {
        tokenId, name: str(r, 'name'), role: str(r, 'role'), expiresAt: isoAt(r['expires_at']),
      });
    });
  }

  /**
   * **개인 토큰 인증.** `bary_` 모양이 아니면 DB 에 묻지 않는다. `lookup` 으로 행을 찾고 해시를 **상수 시간**으로
   * 비교한다. 철회·만료·주인 정지/삭제는 전부 undefined(401). 실효 역할 = min(토큰 역할, 주인의 지금 역할).
   * 성공하면 `last_used_at` 을 적는다 — 1분에 한 번까지(조건부 UPDATE 라 동시 요청도 한 번만 쓴다).
   * 못 물으면 `AccountStoreUnavailable`(서버가 503 으로 거부한다).
   */
  async authenticateToken(value: string): Promise<Principal | undefined> {
    const m = PERSONAL_TOKEN.exec(value);
    if (m === null) return undefined;
    const r = (await this.#q(
      `SELECT t.id, t.user_id, t.name, t.role AS token_role, t.token_hash, t.expires_at, t.revoked_at, t.last_used_at,
              u.username, u.role AS user_role, u.idp_grant, u.idp_deny, u.status
         FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.lookup=$1`, [m[1]],
    ))[0];
    if (r === undefined) return undefined;
    const want = Buffer.from(sha(value), 'utf8');
    const got = Buffer.from(str(r, 'token_hash'), 'utf8');
    if (got.length !== want.length || !timingSafeEqual(got, want)) return undefined;
    const now = this.#now();
    if (r['revoked_at'] !== null || new Date(String(r['expires_at'])).getTime() <= now) return undefined;
    if (str(r, 'status') !== 'active') return undefined;
    const tokenRole = str(r, 'token_role');
    const ownerRole = str(r, 'user_role');
    if (!isRole(tokenRole) || !isRole(ownerRole)) return undefined;
    const role = minRole(tokenRole, ownerRole);
    // 토큰은 주인의 **실효 범위**를 넘지 못한다 — 역할 범위와 주인의 지금 범위(grant/deny 반영)의 교집합. grant 는 토큰으로
    // 옮겨 가지 않고(토큰 역할이 정한다), deny 는 옮겨 간다.
    const owner = new Set(scopesOfAuthority({ role: ownerRole, grant: scopeList(r['idp_grant']), deny: scopeList(r['idp_deny']) }));
    const scopes = scopesOfRole(role).filter((x) => owner.has(x));
    const last = r['last_used_at'] === null ? undefined : new Date(String(r['last_used_at'])).getTime();
    if (last === undefined || now - last >= TOUCH_EVERY_MS) {
      await this.#q(
        `UPDATE api_tokens SET last_used_at=$2 WHERE id=$1 AND (last_used_at IS NULL OR last_used_at <= $3)`,
        [str(r, 'id'), new Date(now), new Date(now - TOUCH_EVERY_MS)],
      );
    }
    return {
      name: `user:${str(r, 'username')}/token:${str(r, 'name')}`, role, scopes: new Set(scopes),
      token: { id: str(r, 'id'), userId: str(r, 'user_id') },
    };
  }

  /**
   * 그 사람의 살아 있는 토큰을 전부 거둔다 — 정지 · 복구 링크 사용. 거둔 것이 있으면 계정 감사에 id 와 개수를 남긴다
   * (값 · 해시는 없다).
   */
  async #revokeAllTokens(c: Queryable, userId: string, by: string, reason: 'suspend' | 'recovery', meta: Meta): Promise<void> {
    const ids = (await c.query(
      `UPDATE api_tokens SET revoked_at=$3, revoked_by=$2 WHERE user_id=$1 AND revoked_at IS NULL RETURNING id`,
      [userId, by, new Date(this.#now())],
    )).rows.map((r) => str(r, 'id'));
    if (ids.length > 0) await this.#audit(c, by, 'account.token_revoke_all', userId, meta, { reason, count: ids.length, tokenIds: ids });
  }

  /** 열린 SSE 의 하트비트가 묻는다(개인 토큰). 못 물으면 던진다 — 스트림 쪽이 닫는다. */
  async tokenAlive(tokenId: string): Promise<boolean> {
    if (!UUID.test(tokenId)) return false;
    const r = await this.#q(
      `SELECT 1 FROM api_tokens t JOIN users u ON u.id=t.user_id
        WHERE t.id=$1 AND t.revoked_at IS NULL AND t.expires_at > $2 AND u.status='active' AND NOT ('read' = ANY(u.idp_deny))`,
      [tokenId, new Date(this.#now())],
    );
    return r.length > 0;
  }

  // ── 관리 ─────────────────────────────────────────────────────────────

  async listUsers(): Promise<unknown[]> {
    return (await this.#q(
      `SELECT u.id, u.username, u.display_name, u.email, u.role, u.role_authority, u.status, u.created_at,
              u.locked_until, u.last_login_at, t.confirmed_at IS NOT NULL AS totp, u.idp_grant, u.idp_deny,
              ${IDP_AUTHORITY_SQL} AS idp_authority, ${PROVIDER_AUTHORITY_SQL} AS by_provider,
              (SELECT count(*) FROM api_tokens k WHERE k.user_id=u.id AND k.revoked_at IS NULL AND k.expires_at > $1) AS tokens
         FROM users u LEFT JOIN mfa_totp t ON t.user_id=u.id WHERE u.status <> 'deleted' ORDER BY u.username`,
      [new Date(this.#now())],
    )).map((u) => ({
      id: str(u, 'id'), username: str(u, 'username'), displayName: opt(u, 'display_name'), email: opt(u, 'email'),
      role: str(u, 'role'), ...authorityView(u), status: str(u, 'status'),
      createdAt: iso(u['created_at']), lockedUntil: isoOpt(u['locked_until']), totp: u['totp'] === true,
      lastLoginAt: isoOpt(u['last_login_at']),
      /** 철회되지 않고 만료되지 않은 개인 API 토큰 수. */
      tokens: Number(u['tokens']),
    }));
  }

  /**
   * 역할·상태를 바꾼다. **마지막 활성 admin 은 강등·정지할 수 없다.** admin 으로 올리려면 그 사람이
   * TOTP 를 등록해 둬야 한다. 정지는 그 사람 세션을 즉시 철회한다(역할 하향은 다음 요청의 재읽기로 반영).
   */
  async updateUser(userId: string, patch: { role?: string; status?: string; roleAuthority?: string }, by: string, meta: Meta = {}): Promise<void> {
    if (patch.role !== undefined && !isRole(patch.role)) throw new AccountError(400, 'malformed', '역할은 auditor | operator | admin 이다');
    if (patch.roleAuthority !== undefined && patch.roleAuthority !== 'local' && patch.roleAuthority !== 'idp') {
      throw new AccountError(400, 'malformed', '권한 정본은 local | idp 다');
    }
    if (patch.status !== undefined && patch.status !== 'active' && patch.status !== 'suspended') {
      throw new AccountError(400, 'malformed', '상태는 active | suspended 다 (삭제는 따로)');
    }
    await this.#tx(async (c) => {
      // 실효 관리자 행을 잠근다 — 둘이 동시에 서로를 강등해 관리자가 0 이 되는 경합을 막는다.
      await c.query(`SELECT u.id FROM users u WHERE ${ADMIN_SQL} AND u.status='active' FOR UPDATE`);
      const u = (await c.query(
        `SELECT u.role, u.status, u.role_authority, u.idp_grant, u.idp_deny, t.confirmed_at,
                EXISTS (SELECT 1 FROM user_identities i WHERE i.user_id=u.id) AS has_identity,
                ${PROVIDER_AUTHORITY_SQL} AS by_provider
           FROM users u LEFT JOIN mfa_totp t ON t.user_id=u.id WHERE u.id=$1 FOR UPDATE OF u`,
        [userId],
      )).rows[0];
      if (u === undefined || str(u, 'status') === 'deleted') throw new AccountError(404, 'no_user', '그런 계정이 없다');
      const cur = authorityOfRow(u);
      if (cur === undefined) throw new AccountError(409, 'bad_role', '계정의 역할 값을 읽을 수 없다');
      const authority = patch.roleAuthority ?? str(u, 'role_authority');
      const byProvider = u['by_provider'] === true;
      const idpRules = authority === 'idp' || byProvider;
      // IdP 가 정본이면 역할은 SSO 로그인 · Role Change 가 맞춘다 — 관리자가 손으로 바꾸면 다음에 덮인다. 그러니 막는다.
      if (idpRules && patch.role !== undefined) {
        throw new AccountError(409, 'role_from_idp', byProvider
          ? '이 계정의 역할은 IdP 가 정한다(공급자 기본 정본) — 먼저 「사람 → SSO 공급자」 에서 공급자 기본 IdP 정본을 끈다'
          : '이 계정의 역할은 IdP 가 정한다 — 먼저 권한 정본을 local 로 바꾼다');
      }
      if (authority === 'idp' && u['has_identity'] !== true) {
        throw new AccountError(409, 'no_identity', 'SSO 가 연결되지 않은 계정은 IdP 를 권한 정본으로 둘 수 없다');
      }
      const role = patch.role ?? str(u, 'role');
      const status = patch.status ?? str(u, 'status');
      if (!isRole(role)) throw new AccountError(409, 'bad_role', '계정의 역할 값을 읽을 수 없다');
      // 로컬 정본이 되면 IdP 가 준 grant/deny 는 지운다 — 역할만이 권한이다.
      const next: IdpAuthority = idpRules ? { role, grant: cur.grant, deny: cur.deny } : { role, grant: [], deny: [] };
      const wasAdmin = scopesOfAuthority(cur).includes('admin');
      const isAdmin = scopesOfAuthority(next).includes('admin');
      if (wasAdmin && str(u, 'status') === 'active' && (!isAdmin || status !== 'active')) {
        await this.#guardLastAdmin(c, userId);
      }
      if (isAdmin && !wasAdmin && (await this.#factorOf(c, userId, u['confirmed_at'] !== null)) === undefined) {
        throw new AccountError(409, 'admin_needs_mfa', '관리자로 올리려면 그 사람이 먼저 인증 앱을 등록(또는 IdP OTP 의 IdP 와 연결)해야 한다');
      }
      await c.query(
        `UPDATE users SET role=$2, status=$3, role_authority=$4, idp_grant=$5, idp_deny=$6, updated_at=now() WHERE id=$1`,
        [userId, role, status, authority, next.grant, next.deny],
      );
      if (status === 'suspended') {
        await c.query(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [userId]);
      }
      await this.#audit(c, by, 'account.update', userId, meta, { role, status, roleAuthority: authority });
      // 개인 토큰도 세션과 같다 — 정지는 거둔다. 다시 활성해도 돌아오지 않는다(사용자 결정 2026-11-04).
      if (status === 'suspended') await this.#revokeAllTokens(c, userId, by, 'suspend', meta);
    });
  }

  /**
   * 탈퇴(소프트 삭제) — **개인정보는 즉시 지운다**(공통 수치 1차): 이메일·이름·비밀번호·인증 앱·복구 코드·
   * 세션(IP·UA 포함)·진행 중 메일 링크. 남기는 것은 username 묘비(재사용 금지)와 **SSO 연결 (iss, sub)** 이다 —
   * 같은 IdP 계정이 다른 사람 계정에 다시 붙거나 JIT 로 새로 생기지 않게 한다(로그인은 status 로 막힌다).
   * 감사 기록은 1년 보존 규칙을 따른다.
   */
  async deleteUser(userId: string, by: string, meta: Meta = {}): Promise<void> {
    await this.#tx(async (c) => {
      await c.query(`SELECT u.id FROM users u WHERE ${ADMIN_SQL} AND u.status='active' FOR UPDATE`);
      const u = (await c.query(`SELECT u.status, ${ADMIN_SQL} AS admin FROM users u WHERE u.id=$1 FOR UPDATE`, [userId])).rows[0];
      if (u === undefined || str(u, 'status') === 'deleted') throw new AccountError(404, 'no_user', '그런 계정이 없다');
      if (u['admin'] === true && str(u, 'status') === 'active') await this.#guardLastAdmin(c, userId);
      await c.query(
        `UPDATE users SET status='deleted', email=NULL, password_hash=NULL, display_name=NULL,
                          deleted_at=now(), updated_at=now() WHERE id=$1`,
        [userId],
      );
      await c.query('DELETE FROM mfa_totp WHERE user_id=$1', [userId]);
      await c.query('DELETE FROM mfa_recovery_codes WHERE user_id=$1', [userId]);
      await c.query(`DELETE FROM sessions WHERE user_id=$1`, [userId]);
      await c.query(
        `UPDATE invitations SET email=NULL, revoked_at=CASE WHEN used_at IS NULL THEN now() ELSE revoked_at END
          WHERE for_user=$1 OR used_by=$1`, [userId],
      );
      await c.query(`DELETE FROM password_resets WHERE user_id=$1`, [userId]);
      await c.query(`DELETE FROM email_changes WHERE user_id=$1`, [userId]);
      await c.query(`DELETE FROM login_flows WHERE user_id=$1`, [userId]);
      // 개인 토큰도 거둔다 — 인증은 어차피 주인 상태로 막지만, 묘비 계정에 산 토큰을 남기지 않는다.
      await c.query(`UPDATE api_tokens SET revoked_at=now(), revoked_by=$2 WHERE user_id=$1 AND revoked_at IS NULL`, [userId, by]);
      await this.#audit(c, by, 'account.delete', userId, meta);
    });
  }

  async #guardLastAdmin(c: Queryable, exceptUserId: string): Promise<void> {
    const others = (await c.query(
      `SELECT count(*) AS n FROM users u WHERE ${ADMIN_SQL} AND u.status='active' AND u.id <> $1`, [exceptUserId],
    )).rows[0]!;
    if (Number(others['n']) === 0) {
      throw new AccountError(409, 'last_admin', '마지막 활성 관리자는 강등·정지·삭제할 수 없다');
    }
  }

  async userIdByName(username: string): Promise<string | undefined> {
    const r = (await this.#q(`SELECT id FROM users WHERE username=$1 AND status <> 'deleted'`, [username.toLowerCase()]))[0];
    return r === undefined ? undefined : str(r, 'id');
  }

  /**
   * **전역 조회 감사** (지역·전역 대시보드 공통 정책 1차 4번, 2026-10-18 사용자 결정). 전역에서 누가 어느 지역의
   * 어느 화면을 언제 봤는지 공용 감사 저장소에 남긴다. SSE 는 접속 단위다. **응답 본문·쿼리·비밀값은 싣지 않는다** —
   * 지역 이름과 경로(허용 목록의 이름)뿐이다. 못 남기면 던진다 — 호출자가 그 조회를 거부한다.
   */
  async recordGlobalView(actor: string, view: { region: string | null; path: string; stream?: boolean }, subjectUser: string | null, meta: Meta = {}): Promise<void> {
    await this.#q(
      'INSERT INTO account_audit (actor, action, subject_user, ip, detail) VALUES ($1,$2,$3,$4,$5)',
      [actor, view.stream === true ? 'global.events_open' : 'global.view', subjectUser, meta.ip ?? null,
        JSON.stringify({ region: view.region, path: view.path })],
    );
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
/** 밀리초까지 — `String(Date)` 를 거치면 초 아래가 잘린다. 토큰의 만료는 발급 응답과 목록·감사가 같은 값이어야 한다. */
const isoAt = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();

/** 화면에 보일 IdP 이름 — issuer 의 호스트. URL 이 아니면 그대로. */
function hostOf(issuer: string): string {
  try {
    return new URL(issuer).host || issuer;
  } catch {
    return issuer;
  }
}

/**
 * 둘째 인증의 「틀린 코드가 아닌」 실패 → 사람 말의 거절. **모두 닫힌다** — 다른 수단으로 넘어가지 않는다.
 * 서비스 토큰 거절과 닿지 못함은 둘 다 이 배포의 문제라 503 이다(코드를 다시 넣어 봐야 소용없다).
 */
function idpMfaRefusal(reason: Exclude<MfaFailure, 'wrong-code'>): AccountError {
  switch (reason) {
    case 'rate-limited': return new AccountError(429, 'mfa_idp_rate_limited', 'IdP 가 시도를 잠시 막았어요 — 잠시 뒤 다시 해요');
    case 'account-inactive': return new AccountError(403, 'mfa_idp_inactive', 'IdP 에서 이 계정이 활성이 아니에요');
    case 'not-enrolled': return new AccountError(404, 'mfa_idp_not_enrolled', 'IdP 에 OTP 가 없어요 — IdP 에서 먼저 인증 앱을 등록해요');
    case 'service-token':
    case 'unavailable':
      return new AccountError(503, 'mfa_idp_unavailable', 'IdP 에 물을 수 없어요 — 잠시 뒤 다시 해요');
  }
}
