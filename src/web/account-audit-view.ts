/**
 * 관리 › 계정 감사 (2026-11-21) — `account_audit` 의 동작 이름을 사람이 읽는 말로.
 *
 * 동작 이름은 `src/accounts/service.ts` 의 `#audit(...)` 이 정본이다. 테스트가 그 파일에서 이름을 모아 여기 표와
 * 맞춘다 — 새 동작을 넣고 이 표를 잊으면 깨진다.
 */

export type AuditGroup = 'session' | 'invite' | 'mfa' | 'token' | 'sso' | 'user' | 'mail' | 'global';
export type AuditTone = 'ok' | 'warn' | 'danger' | 'neutral' | 'info';

export const AUDIT_GROUPS: readonly { key: AuditGroup; label: string }[] = [
  { key: 'session', label: '로그인 · 세션' },
  { key: 'invite', label: '초대 · 첫 관리자 · 복구' },
  { key: 'mfa', label: '비밀번호 · 인증 앱' },
  { key: 'token', label: 'API 토큰' },
  { key: 'sso', label: 'SSO · IdP' },
  { key: 'user', label: '사용자 관리' },
  { key: 'mail', label: '메일 링크' },
  { key: 'global', label: '전역 조회' },
];

export const AUDIT_ACTIONS: Readonly<Record<string, { label: string; group: AuditGroup; tone: AuditTone }>> = {
  'session.login': { label: '로그인', group: 'session', tone: 'ok' },
  'session.logout': { label: '로그아웃', group: 'session', tone: 'neutral' },
  'session.logout_all': { label: '모든 기기에서 로그아웃', group: 'session', tone: 'neutral' },
  'session.step_up': { label: 'MFA 다시 확인', group: 'session', tone: 'neutral' },
  'account.locked': { label: '로그인 실패로 잠김', group: 'session', tone: 'danger' },

  'account.invite': { label: '초대', group: 'invite', tone: 'ok' },
  'account.invite_resend': { label: '초대 다시 보내기', group: 'invite', tone: 'neutral' },
  'account.invite_revoke': { label: '초대 취소', group: 'invite', tone: 'warn' },
  'account.bootstrap_link': { label: '첫 관리자 링크 만들기', group: 'invite', tone: 'warn' },
  'account.recovery_link': { label: '복구 링크 만들기', group: 'invite', tone: 'warn' },

  'account.password_change': { label: '비밀번호 변경', group: 'mfa', tone: 'neutral' },
  'account.reset_request': { label: '비밀번호 재설정 요청', group: 'mfa', tone: 'neutral' },
  'account.reset_confirm': { label: '비밀번호 재설정', group: 'mfa', tone: 'warn' },
  'account.totp_enable': { label: '인증 앱 등록', group: 'mfa', tone: 'ok' },
  'account.totp_disable': { label: '인증 앱 해제', group: 'mfa', tone: 'warn' },
  'account.recovery_codes': { label: '복구 코드 새로 만들기', group: 'mfa', tone: 'neutral' },

  'account.token_issue': { label: 'API 토큰 만들기', group: 'token', tone: 'ok' },
  'account.token_revoke': { label: 'API 토큰 폐기', group: 'token', tone: 'warn' },
  'account.token_revoke_all': { label: 'API 토큰 모두 폐기', group: 'token', tone: 'warn' },

  'account.sso_link': { label: 'SSO 계정 연결', group: 'sso', tone: 'ok' },
  'account.sso_unlink': { label: 'SSO 계정 연결 끊기', group: 'sso', tone: 'warn' },
  'account.jit_create': { label: 'SSO 로 계정 자동 생성', group: 'sso', tone: 'ok' },
  'account.sso_roles': { label: 'SSO 역할 매핑 변경', group: 'sso', tone: 'warn' },
  'account.sso_authority': { label: 'IdP 가 역할을 정하는지 변경', group: 'sso', tone: 'warn' },
  'account.sso_jit': { label: 'SSO 자동 생성 켜기 · 끄기', group: 'sso', tone: 'warn' },
  'account.idp_role_change': { label: 'IdP 가 역할을 바꿈', group: 'sso', tone: 'warn' },
  'account.idp_role_sync': { label: 'IdP 역할을 맞춤', group: 'sso', tone: 'neutral' },
  'account.idp_role_change_ignored': { label: 'IdP 역할 변경을 무시함', group: 'sso', tone: 'neutral' },
  'account.idp_role_refused': { label: 'IdP 역할 변경을 거절함', group: 'sso', tone: 'danger' },

  'account.update': { label: '사용자 변경(역할 · 상태)', group: 'user', tone: 'warn' },
  'account.delete': { label: '사용자 삭제', group: 'user', tone: 'danger' },

  'account.email_change_request': { label: '이메일 변경 요청', group: 'mail', tone: 'neutral' },
  'account.email_change_confirm': { label: '이메일 변경 확인', group: 'mail', tone: 'ok' },

  'global.view': { label: '전역 화면에서 지역 조회', group: 'global', tone: 'info' },
  'global.events_open': { label: '전역 화면에서 실시간 연결', group: 'global', tone: 'info' },
};

/** 표에 없는 동작도 보인다 — 이름 그대로, 묶음 없이. */
export function auditAction(action: string): { label: string; group?: AuditGroup; tone: AuditTone } {
  return AUDIT_ACTIONS[action] ?? { label: action, tone: 'neutral' };
}

/**
 * `detail` 을 한 줄로. 값이 길면 자른다. 이미 화면의 다른 칸에 있는 것(대상 · IP)은 서버가 따로 준다.
 * 비밀은 서버가 처음부터 기록에 넣지 않는다 — 여기서 거르지 않는다.
 */
export function auditDetailText(detail: Record<string, unknown> | undefined): string {
  if (detail === undefined) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(detail)) {
    if (v === null || v === undefined) continue;
    const text = typeof v === 'string' ? v : JSON.stringify(v);
    parts.push(`${k}: ${text.length > 80 ? `${text.slice(0, 77)}…` : text}`);
  }
  return parts.join(' · ');
}
