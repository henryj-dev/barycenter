/**
 * IdP 권한 위임 — 역할 매핑 어댑터(일반 클레임 매핑 · 프로필 · 등록부)와 실효 범위.
 *
 * 재는 것: 역할 배열 · 여러 값(가장 높은 역할) · 매핑에 없는 값 무시 · 점 경로 · 접두로 거르기 · grant/deny ·
 * **deny 우선** · 모르는 entitlement 거절 · 모양 거절 · 상속 이름을 따라가지 않음 · 설정 모양 검사 · 모르는 구현 이름.
 */
import { describe, expect, it } from 'vitest';

import { claimsConfigProblem, claimsMapper, DEFAULT_ENTITLEMENT_MAP, readClaim, type ClaimsMapperConfig } from '../../src/accounts/idp-roles/claims.js';
import { effectiveScopes } from '../../src/accounts/idp-roles/mapper.js';
import { roleMapperFactory, roleMapperKinds, roleProfile, roleProfilesView } from '../../src/accounts/idp-roles/registry.js';

const lodestar = (over: Partial<ClaimsMapperConfig> = {}): ClaimsMapperConfig => ({
  ...roleProfile('lodestar')!,
  roleMap: { 'barycenter-admins': 'admin', 'barycenter-operators': 'operator', 'barycenter-auditors': 'auditor' },
  ...over,
});

describe('역할 클레임', () => {
  it('**배열에서 매핑에 있는 값만** 고르고, 둘 이상이면 가장 높은 역할', () => {
    const m = claimsMapper(lodestar());
    expect(m.fromClaims({ roles: ['heliopause-operators', 'barycenter-auditors', 'barycenter-operators'] }))
      .toEqual({ ok: true, value: { role: 'operator', grant: [], deny: [] } });
    expect(m.fromClaims({ roles: 'barycenter-admins' })).toMatchObject({ ok: true, value: { role: 'admin' } });
  });

  it('매핑에 있는 값이 하나도 없으면 거절 — 로컬 역할로 떨어지지 않는다', () => {
    const m = claimsMapper(lodestar());
    expect(m.fromClaims({ roles: ['heliopause-operators'] })).toMatchObject({ ok: false, reason: 'no-mapped-role' });
    expect(m.fromClaims({ roles: [] })).toMatchObject({ ok: false, reason: 'no-mapped-role' });
    expect(m.fromClaims({})).toMatchObject({ ok: false, reason: 'no-role-claim' });
  });

  it('문자열 · 문자열 배열이 아니면 거절', () => {
    const m = claimsMapper(lodestar());
    expect(m.fromClaims({ roles: 3 })).toMatchObject({ ok: false, reason: 'bad-claim-shape' });
    expect(m.fromClaims({ roles: ['barycenter-admins', 1] })).toMatchObject({ ok: false, reason: 'bad-claim-shape' });
    expect(m.fromClaims({ roles: ['barycenter-operators'], entitlements: { x: 1 } })).toMatchObject({ ok: false, reason: 'bad-claim-shape' });
  });

  it('설정이 없으면 거절(not-configured)', () => {
    expect(claimsMapper(lodestar({ roleClaim: null })).fromClaims({ roles: ['barycenter-admins'] })).toMatchObject({ ok: false, reason: 'not-configured' });
    expect(claimsMapper(lodestar({ roleMap: {} })).fromLists({ roles: ['barycenter-admins'], entitlements: [] })).toMatchObject({ ok: false, reason: 'not-configured' });
  });

  it('**점 경로**(Keycloak `realm_access.roles`) — 이름 그대로의 최상위 클레임이 먼저다', () => {
    const kc = claimsMapper({ ...roleProfile('keycloak')!, roleMap: { ops: 'operator', boss: 'admin' } });
    expect(kc.fromClaims({ realm_access: { roles: ['ops'] } })).toMatchObject({ ok: true, value: { role: 'operator' } });
    expect(kc.fromClaims({ 'realm_access.roles': ['boss'], realm_access: { roles: ['ops'] } })).toMatchObject({ ok: true, value: { role: 'admin' } });
    expect(kc.fromClaims({ realm_access: ['ops'] })).toMatchObject({ ok: false, reason: 'no-role-claim' });
  });

  it('상속 이름(`__proto__` · `constructor`)을 따라가지 않는다', () => {
    expect(readClaim({}, 'constructor.name')).toBeUndefined();
    expect(readClaim({ a: {} }, 'a.__proto__')).toBeUndefined();
    expect(readClaim({ a: { b: ['x'] } }, 'a.b')).toEqual(['x']);
  });
});

describe('entitlement — grant / deny', () => {
  it('**접두로 거른다** — 다른 앱의 entitlement 는 무시, 이 앱의 것은 표로 grant/deny', () => {
    const m = claimsMapper(lodestar());
    expect(m.fromClaims({ roles: ['barycenter-operators'], entitlements: ['plan.approve_own', 'barycenter.apply', 'barycenter.no_write'] }))
      .toEqual({ ok: true, value: { role: 'operator', grant: ['apply'], deny: ['write'] } });
  });

  it('entitlement 클레임이 없으면 빈 목록(IdP 는 빈 entitlements 를 빼고 보낸다)', () => {
    expect(claimsMapper(lodestar()).fromClaims({ roles: ['barycenter-operators'] }))
      .toEqual({ ok: true, value: { role: 'operator', grant: [], deny: [] } });
  });

  it('**접두가 붙었는데 표에 없으면 거절** — 모르는 deny 를 조용히 버리지 않는다', () => {
    expect(claimsMapper(lodestar()).fromClaims({ roles: ['barycenter-operators'], entitlements: ['barycenter.no_everything'] }))
      .toMatchObject({ ok: false, reason: 'unknown-entitlement' });
  });

  it('entitlement 클레임을 정하지 않으면 읽지 않는다(역할만)', () => {
    const m = claimsMapper(lodestar({ entitlementClaim: null }));
    expect(m.fromLists({ roles: ['barycenter-operators'], entitlements: ['barycenter.apply', 'barycenter.whatever'] }))
      .toEqual({ ok: true, value: { role: 'operator', grant: [], deny: [] } });
  });

  it('Role Change 의 목록도 같은 판정(fromLists)', () => {
    expect(claimsMapper(lodestar()).fromLists({ roles: ['barycenter-admins'], entitlements: ['barycenter.no_apply'] }))
      .toEqual({ ok: true, value: { role: 'admin', grant: [], deny: ['apply'] } });
  });
});

describe('실효 범위 = 역할 범위 ∪ grant − deny', () => {
  it('grant 는 더하고 deny 는 뺀다', () => {
    expect(effectiveScopes('operator', ['apply'], [])).toEqual(['read', 'write', 'apply']);
    expect(effectiveScopes('admin', [], ['apply'])).toEqual(['read', 'write', 'admin']);
  });

  it('**deny 가 이긴다** — 같은 범위를 grant 와 deny 로 받으면 없다', () => {
    expect(effectiveScopes('operator', ['apply'], ['apply'])).toEqual(['read', 'write']);
    const m = claimsMapper(lodestar());
    const r = m.fromClaims({ roles: ['barycenter-operators'], entitlements: ['barycenter.apply', 'barycenter.no_apply'] });
    expect(r.ok && effectiveScopes(r.value.role, r.value.grant, r.value.deny)).toEqual(['read', 'write']);
  });
});

describe('설정 · 등록부', () => {
  it('entitlement 를 읽는데 접두가 없으면 설정 거절 — 다른 앱의 entitlement 가 이 앱의 권한이 되지 않게', () => {
    expect(claimsConfigProblem(lodestar({ entitlementPrefix: '' }))).toMatch(/접두/);
    expect(claimsConfigProblem(lodestar())).toBeUndefined();
    expect(claimsConfigProblem(lodestar({ entitlementMap: { apply: 'grant:root' as never } }))).toMatch(/효과/);
    expect(claimsConfigProblem(lodestar({ roleMap: { x: 'root' as never } }))).toMatch(/역할 매핑/);
    expect(claimsConfigProblem(lodestar({ roleClaim: 'bad claim!' }))).toMatch(/모양/);
  });

  it('lodestar 프로필 = roles · entitlements · barycenter. · 기본 표, 권하는 매핑은 barycenter-admins …', () => {
    expect(roleProfile('lodestar')).toEqual({
      roleClaim: 'roles', entitlementClaim: 'entitlements', entitlementPrefix: 'barycenter.', entitlementMap: DEFAULT_ENTITLEMENT_MAP,
    });
    expect(roleProfilesView().find((p) => p.name === 'lodestar')?.roleMap).toEqual({
      'barycenter-admins': 'admin', 'barycenter-operators': 'operator', 'barycenter-auditors': 'auditor',
    });
    expect(roleProfile('okta')?.roleClaim).toBe('groups');
    expect(roleProfile('nope')).toBeUndefined();
  });

  it('모르는 구현 이름은 던진다(기동 거부)', () => {
    expect(roleMapperKinds()).toContain('claims');
    expect(() => roleMapperFactory('magic')).toThrow(/모르는 역할 매핑/);
  });
});
