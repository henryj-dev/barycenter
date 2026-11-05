/**
 * IdP 권한 위임의 **어댑터 계약** — IdP 가 서명한 클레임(또는 Role Change SET 의 목록)을 barycenter 의 권한으로 바꾼다.
 *
 * 권한은 두 겹이다(A안 — 권한 종류 단위):
 *   · 역할(auditor | operator | admin) — 역할 → 범위 표(`scopesOfRole`)가 기본 범위를 정한다
 *   · grant / deny — 범위 하나씩 더하고 뺀다. **deny 가 이긴다**(`effectiveScopes`)
 *
 * 다른 모양의 IdP 를 붙이려면 이 인터페이스의 구현 하나와 `registry.ts` 의 등록 한 줄이면 된다. 클레임 경로만 다른 IdP
 * (Keycloak · Entra · Okta …)는 구현이 아니라 **프로필**이다(`registry.ts` 의 `ROLE_PROFILES`).
 *
 * **실패를 예외로 던지지 않는다** — 결과 객체다. 「매핑에 없다」를 try/catch 로 알아내면 언젠가 다른 예외를 「매핑 없음」 으로
 * (또는 그 반대로) 읽는다. 실패는 언제나 **그 로그인 거부**(또는 Role Change 면 모든 범위 deny)다 — 로컬 역할로 떨어지지 않는다.
 */
import { ALL_SCOPES, scopesOfRole, type Role, type Scope } from '../../api/auth.js';

/** 매핑 결과 — 계정 행에 그대로 쓴다(`users.role` · `idp_grant` · `idp_deny`). */
export type IdpAuthority = { role: Role; grant: Scope[]; deny: Scope[] };

/** 실패의 뜻. 사람이 원인을 가를 수 있게 나눈다. */
export type RoleMapFailure =
  /** 공급자에 역할 클레임 · 매핑이 설정되지 않았다 — 배포(관리자 설정) 문제다. */
  | 'not-configured'
  /** 역할 클레임이 없다. IdP 가 이 사람에게 이 앱의 역할을 주지 않았다. */
  | 'no-role-claim'
  /** 클레임 모양이 문자열 · 문자열 배열이 아니다. */
  | 'bad-claim-shape'
  /** 역할 값이 있지만 매핑에 있는 것이 하나도 없다. */
  | 'no-mapped-role'
  /** 접두(예 `barycenter.`)가 붙은 entitlement 인데 표에 없다 — 모르는 권한을 조용히 버리지 않는다. */
  | 'unknown-entitlement';

export type RoleMapResult = { ok: true; value: IdpAuthority } | { ok: false; reason: RoleMapFailure; detail: string };

/** IdP 가 말한 그대로의 두 목록 — Role Change SET 이 이 모양으로 온다(`events[…] = { roles, entitlements }`). */
export type IdpLists = { roles: readonly string[]; entitlements: readonly string[] };

export interface RoleMapper {
  /** 서명 검증을 지난 ID Token 클레임 → 권한. 판정 때문에 던지지 않는다. */
  fromClaims(claims: Readonly<Record<string, unknown>>): RoleMapResult;
  /** 이미 목록으로 온 것(Role Change SET) → 권한. 판정 때문에 던지지 않는다. */
  fromLists(lists: IdpLists): RoleMapResult;
}

const SCOPE_ORDER: readonly Scope[] = ALL_SCOPES;

/** 범위 목록을 정해진 순서 · 중복 없이. 저장 · 비교 · 화면이 같은 모양을 본다. */
export function normScopes(xs: Iterable<Scope>): Scope[] {
  const s = new Set(xs);
  return SCOPE_ORDER.filter((x) => s.has(x));
}

/**
 * **실효 범위 = 역할 범위 ∪ grant − deny.** deny 가 언제나 이긴다(같은 범위가 둘에 다 있으면 없다).
 * `admin` 범위 grant 의 조건(둘째 인증 · 마지막 관리자)은 여기서 보지 않는다 — 쓰는 자리(`AccountService`)가 본다.
 */
export function effectiveScopes(role: Role, grant: readonly Scope[], deny: readonly Scope[]): Scope[] {
  const out = new Set<Scope>([...scopesOfRole(role), ...grant]);
  for (const d of deny) out.delete(d);
  return normScopes(out);
}

export const isScope = (v: unknown): v is Scope => typeof v === 'string' && (SCOPE_ORDER as readonly string[]).includes(v);
