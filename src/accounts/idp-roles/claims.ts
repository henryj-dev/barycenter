/**
 * 일반 클레임 매핑 — 역할 클레임 하나 + entitlement 클레임 하나.
 *
 *   역할        설정한 클레임(문자열 또는 문자열 배열)에서 **매핑에 있는 값만** 고른다. 둘 이상이면 **가장 높은 역할**.
 *               하나도 없으면 거절(로컬 역할로 떨어지지 않는다). 매핑에 없는 값은 무시한다 — IdP 는 다른 앱의 역할도 싣는다.
 *   entitlement 설정한 클레임(배열)에서 **접두**(예 `barycenter.`)가 붙은 값만 본다. 접두 뒤의 이름을 표로 grant/deny 로 바꾼다.
 *               접두가 붙었는데 표에 없는 값은 **거절**이다 — 모르는 deny 를 조용히 버리면 막으려던 권한이 열린다.
 *               접두가 없는 값은 이 앱의 것이 아니다(무시). 클레임이 없으면 빈 목록이다(IdP 는 빈 entitlements 를 빼고 보낸다).
 *
 * 클레임 이름은 **점 경로**다 — `realm_access.roles` 는 `realm_access` 객체의 `roles`. 단, 이름 그대로의 최상위 클레임이
 * 있으면 그것이 먼저다(`https://example.com/roles` 같은 네임스페이스 클레임에도 점이 있다).
 *
 * lodestar 의 안내: groups 는 조직 소속이라 인가에 쓰지 않는다 · 인가는 entitlements · roles 는 「이 사람은 무엇인가」.
 */
import { roleRank, type Role, type Scope } from '../../api/auth.js';
import { isScope, normScopes, type IdpLists, type RoleMapper, type RoleMapResult } from './mapper.js';

/** entitlement 하나의 효과 — `grant:apply` 는 apply 를 더하고, `deny:apply` 는 apply 를 뺀다. */
export type EntitlementEffect = `${'grant' | 'deny'}:${Scope}`;

export type ClaimsMapperConfig = {
  /** 역할 클레임의 점 경로. null 이면 설정되지 않은 것이다(IdP 정본 계정은 로그인 거부). */
  roleClaim: string | null;
  /** IdP 역할 값 → barycenter 역할. */
  roleMap: Readonly<Record<string, Role>>;
  /** entitlement 클레임의 점 경로. null 이면 entitlement 를 읽지 않는다(grant/deny 없음 — 역할만). */
  entitlementClaim: string | null;
  /** 이 앱의 entitlement 접두. entitlement 를 읽으면 비어 있을 수 없다(`claimsConfigProblem`). */
  entitlementPrefix: string;
  /** 접두 뒤의 이름 → 효과. */
  entitlementMap: Readonly<Record<string, EntitlementEffect>>;
};

/** 기본 entitlement 표 — lodestar 에 `barycenter.apply` · `barycenter.no_apply` … 로 등록한다(런북). */
export const DEFAULT_ENTITLEMENT_MAP: Readonly<Record<string, EntitlementEffect>> = {
  write: 'grant:write',
  apply: 'grant:apply',
  admin: 'grant:admin',
  no_write: 'deny:write',
  no_apply: 'deny:apply',
  no_admin: 'deny:admin',
};

/** 클레임 이름 모양 — DDL 의 CHECK 와 같다. */
export const CLAIM_PATH = /^[A-Za-z0-9_.:/-]{1,200}$/;
/** 접두 모양 — 이름 앞에 붙는 짧은 값. */
export const ENTITLEMENT_PREFIX = /^[A-Za-z0-9_.:/-]{1,100}$/;
const EFFECT = /^(grant|deny):(read|write|apply|admin)$/;

export const isEntitlementEffect = (v: unknown): v is EntitlementEffect => typeof v === 'string' && EFFECT.test(v);

/** 설정의 모양 문제 — 없으면 undefined. 저장 전에 부른다(사람이 고칠 문장). */
export function claimsConfigProblem(c: ClaimsMapperConfig): string | undefined {
  if (c.roleClaim !== null && !CLAIM_PATH.test(c.roleClaim)) return '역할 클레임 이름 모양이 아니다';
  if (c.entitlementClaim !== null) {
    if (!CLAIM_PATH.test(c.entitlementClaim)) return 'entitlement 클레임 이름 모양이 아니다';
    if (!ENTITLEMENT_PREFIX.test(c.entitlementPrefix)) {
      return 'entitlement 를 읽으려면 접두가 필요하다(예 barycenter.) — 접두 없이 읽으면 다른 앱의 entitlement 까지 이 앱의 권한이 된다';
    }
  }
  for (const [k, v] of Object.entries(c.roleMap)) {
    if (k === '' || k.length > 200) return '역할 매핑의 IdP 값이 비었거나 너무 길다';
    if (v !== 'auditor' && v !== 'operator' && v !== 'admin') return `역할 매핑 값은 auditor | operator | admin 이다 (${k} → ${String(v)})`;
  }
  for (const [k, v] of Object.entries(c.entitlementMap)) {
    if (k === '' || k.length > 200) return 'entitlement 표의 이름이 비었거나 너무 길다';
    if (!isEntitlementEffect(v)) return `entitlement 효과는 grant:<범위> 또는 deny:<범위> 다 (${k} → ${String(v)})`;
  }
  return undefined;
}

/**
 * 점 경로로 클레임을 읽는다. **자기 속성만** 따라간다 — `__proto__` · `constructor` 같은 상속 이름으로 엉뚱한 값을 읽지 않게.
 * 이름 그대로의 최상위 클레임이 있으면 그것이 먼저다.
 */
export function readClaim(claims: Readonly<Record<string, unknown>>, path: string): unknown {
  if (Object.hasOwn(claims, path)) return claims[path];
  let cur: unknown = claims;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !Object.hasOwn(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** 문자열 → [그것], 문자열 배열 → 그대로. 그 밖은 undefined(모양이 틀렸다). */
function stringList(v: unknown): string[] | undefined {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  return undefined;
}

export function claimsMapper(c: ClaimsMapperConfig): RoleMapper {
  const fromLists = (l: IdpLists): RoleMapResult => decide(c, l);
  return {
    fromLists,
    fromClaims(claims) {
      if (c.roleClaim === null || Object.keys(c.roleMap).length === 0) {
        return { ok: false, reason: 'not-configured', detail: '공급자에 역할 클레임 · 매핑이 설정되지 않았다' };
      }
      const rv = readClaim(claims, c.roleClaim);
      if (rv === undefined || rv === null) return { ok: false, reason: 'no-role-claim', detail: `역할 클레임(${c.roleClaim})이 없다` };
      const roles = stringList(rv);
      if (roles === undefined) return { ok: false, reason: 'bad-claim-shape', detail: `역할 클레임(${c.roleClaim})이 문자열 · 문자열 배열이 아니다` };
      let entitlements: string[] = [];
      if (c.entitlementClaim !== null) {
        const ev = readClaim(claims, c.entitlementClaim);
        if (ev !== undefined && ev !== null) {
          const list = stringList(ev);
          if (list === undefined) {
            return { ok: false, reason: 'bad-claim-shape', detail: `entitlement 클레임(${c.entitlementClaim})이 문자열 · 문자열 배열이 아니다` };
          }
          entitlements = list;
        }
      }
      return decide(c, { roles, entitlements });
    },
  };
}

function decide(c: ClaimsMapperConfig, l: IdpLists): RoleMapResult {
  if (Object.keys(c.roleMap).length === 0) {
    return { ok: false, reason: 'not-configured', detail: '공급자에 역할 매핑이 설정되지 않았다' };
  }
  let role: Role | undefined;
  for (const v of l.roles) {
    const m = Object.hasOwn(c.roleMap, v) ? c.roleMap[v] : undefined;
    if (m === undefined) continue;
    if (role === undefined || roleRank(m) > roleRank(role)) role = m;
  }
  if (role === undefined) {
    return { ok: false, reason: 'no-mapped-role', detail: `매핑에 있는 역할 값이 없다 (받은 값 ${l.roles.length}개)` };
  }
  const grant: Scope[] = [];
  const deny: Scope[] = [];
  if (c.entitlementClaim !== null) {
    for (const e of l.entitlements) {
      if (!e.startsWith(c.entitlementPrefix)) continue;
      const name = e.slice(c.entitlementPrefix.length);
      const effect = Object.hasOwn(c.entitlementMap, name) ? c.entitlementMap[name] : undefined;
      if (effect === undefined) return { ok: false, reason: 'unknown-entitlement', detail: `표에 없는 entitlement: ${e}` };
      const [kind, scope] = effect.split(':') as ['grant' | 'deny', string];
      if (!isScope(scope)) return { ok: false, reason: 'unknown-entitlement', detail: `표의 효과가 범위가 아니다: ${e}` };
      (kind === 'grant' ? grant : deny).push(scope);
    }
  }
  return { ok: true, value: { role, grant: normScopes(grant), deny: normScopes(deny) } };
}
