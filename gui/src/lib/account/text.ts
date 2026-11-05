import type { Authority, Role, Scope } from './api';

/** 계정 화면들이 같이 쓰는 문구 — 같은 규칙을 화면마다 다르게 말하지 않게. 규칙 자체는 서버가 진다. */
/** 시안의 역할 이름(관리자 · 운영자 · 보기). 서버 값(admin · operator · auditor)은 바꾸지 않는다. */
export const ROLE_LABEL: Readonly<Record<Role, string>> = { admin: '관리자', operator: '운영자', auditor: '보기' };

export const PASSWORD_HELP = '8자 이상, 영소문자 · 영대문자 · 숫자 · 특수문자 중 3종류를 써요.';

/** 토큰 역할이 여는 범위 — 시안의 「범위」 칸(read · write · apply)을 우리 역할로 읽는다. 서버의 역할 → 스코프 표와 같다. */
export const ROLE_SCOPES: Readonly<Record<Role, string>> = { auditor: 'read', operator: 'read · write', admin: 'read · write · apply · admin' };

/** 토큰 이름 규칙 — 서버(`TOKEN_NAME`)와 같다. 화면은 미리 알리기만 하고 판정은 서버가 진다. */
export const TOKEN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
export const TOKEN_NAME_HELP = '이름은 영문·숫자로 시작하고 영문, 숫자, 점(.), 밑줄(_), 하이픈(-)만 쓸 수 있어요. 63자까지예요.';

/** 범위 이름 — 시안의 「범위」 칸(read · write · apply · admin)을 사람 말로. */
export const SCOPE_LABEL: Readonly<Record<Scope, string>> = { read: '읽기', write: '쓰기', apply: '적용', admin: '관리' };
const BASE: Readonly<Record<Role, readonly Scope[]>> = { auditor: ['read'], operator: ['read', 'write'], admin: ['read', 'write', 'apply', 'admin'] };

/**
 * 실효 범위를 한 줄로 — 「운영자」, 「운영자 · 적용 더함」, 「관리자 · 적용 없음」. 역할의 기본 범위와 다른 것만 덧붙인다.
 * 범위가 하나도 없으면(IdP 가 이 앱의 역할을 거둬 모두 deny) 「권한 없음」. 옛 서버(`scopes` 없음)는 역할 이름만.
 */
export function authorityLabel(a: Authority & { role: Role }): string {
  const role = ROLE_LABEL[a.role] ?? a.role;
  if (a.scopes === undefined) return role;
  if (a.scopes.length === 0) return '권한 없음';
  const base = BASE[a.role] ?? [];
  const added = a.scopes.filter((s) => !base.includes(s)).map((s) => `${SCOPE_LABEL[s]} 더함`);
  const removed = base.filter((s) => !a.scopes!.includes(s)).map((s) => `${SCOPE_LABEL[s]} 없음`);
  return [role, ...added, ...removed].join(' · ');
}

/** 실효 관리자인가 — 역할이 아니라 범위로 본다(IdP 가 admin 을 grant · deny 할 수 있다). 옛 서버는 역할로. */
export const isAdminOf = (a: Authority & { role: Role }): boolean => (a.scopes === undefined ? a.role === 'admin' : a.scopes.includes('admin'));
