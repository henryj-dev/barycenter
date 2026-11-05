/**
 * 역할 매핑 등록부 — `BARY_IDP_ROLES_KIND` 의 이름으로 구현을 고른다(기본 `claims`).
 *
 * 다른 구현을 붙이려면: `RoleMapper` 를 구현한 파일 하나 + 아래 `MAPPERS` 에 한 줄.
 * 클레임 경로만 다른 IdP 는 구현이 아니라 **프로필**이다(`ROLE_PROFILES` 에 한 줄). 프로필은 공급자 설정의 기본값일 뿐이고,
 * 저장되는 것은 언제나 펼친 설정(클레임 · 접두 · 표)이다 — 프로필 이름이 바뀌어도 이미 저장한 공급자는 그대로다.
 */
import { claimsMapper, DEFAULT_ENTITLEMENT_MAP, type ClaimsMapperConfig } from './claims.js';
import type { Role } from '../../api/auth.js';
import type { RoleMapper } from './mapper.js';

const MAPPERS: Readonly<Record<string, (c: ClaimsMapperConfig) => RoleMapper>> = {
  claims: (c) => claimsMapper(c),
};

export const DEFAULT_ROLE_MAPPER = 'claims';

export function roleMapperKinds(): string[] {
  return Object.keys(MAPPERS);
}

/** 모르는 이름이면 던진다 — 기동이 거부된다(조용히 다른 해석으로 떨어지지 않게). */
export function roleMapperFactory(kind: string): (c: ClaimsMapperConfig) => RoleMapper {
  const make = Object.hasOwn(MAPPERS, kind) ? MAPPERS[kind] : undefined;
  if (make === undefined) throw new Error(`모르는 역할 매핑: ${kind} (쓸 수 있는 것: ${roleMapperKinds().join(', ')})`);
  return make;
}

/** 프로필 — 역할 매핑 값(IdP 쪽 이름)은 IdP 에 무엇을 등록했는지에 달려 있어 관리자가 넣는다. 여기는 클레임 자리만. */
export type RoleProfile = Pick<ClaimsMapperConfig, 'roleClaim' | 'entitlementClaim' | 'entitlementPrefix' | 'entitlementMap'>;

export const ROLE_PROFILES: Readonly<Record<string, RoleProfile>> = {
  /** lodestar(idp.tinyuniver.se) — 인가는 entitlements, roles 는 「무엇인가」. groups 는 조직 소속이라 쓰지 않는다. */
  lodestar: { roleClaim: 'roles', entitlementClaim: 'entitlements', entitlementPrefix: 'barycenter.', entitlementMap: DEFAULT_ENTITLEMENT_MAP },
  /** Keycloak — 렐름 역할. entitlement 에 해당하는 표준 클레임이 없다(클라이언트 역할을 쓰려면 경로를 손으로). */
  keycloak: { roleClaim: 'realm_access.roles', entitlementClaim: null, entitlementPrefix: '', entitlementMap: {} },
  /** Microsoft Entra ID — 앱 역할(`roles`). */
  entra: { roleClaim: 'roles', entitlementClaim: null, entitlementPrefix: '', entitlementMap: {} },
  /** Okta — 그룹 클레임(인가 서버에서 `groups` 를 내보내게 설정한다). */
  okta: { roleClaim: 'groups', entitlementClaim: null, entitlementPrefix: '', entitlementMap: {} },
};

/**
 * lodestar 에 등록하는 역할 이름(런북 「IdP 권한 정본」). 프로필을 **적용해도 매핑은 바꾸지 않는다** — 화면이 처음 채울 때만 권한다
 * (이미 만든 매핑을 프로필 버튼 하나로 덮지 않게).
 */
export const SUGGESTED_ROLE_MAPS: Readonly<Record<string, Readonly<Record<string, Role>>>> = {
  lodestar: { 'barycenter-admins': 'admin', 'barycenter-operators': 'operator', 'barycenter-auditors': 'auditor' },
};

/** 화면용 — 프로필마다 클레임 자리와 권하는 매핑. 비밀이 아니다. */
export function roleProfilesView(): Array<RoleProfile & { name: string; roleMap: Readonly<Record<string, Role>> }> {
  return Object.entries(ROLE_PROFILES).map(([name, p]) => ({ name, ...p, roleMap: SUGGESTED_ROLE_MAPS[name] ?? {} }));
}

export function roleProfile(name: string): RoleProfile | undefined {
  return Object.hasOwn(ROLE_PROFILES, name) ? ROLE_PROFILES[name] : undefined;
}
