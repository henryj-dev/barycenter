/**
 * 사람 계정 API (공통 회원정책 1차 · 계획 A).
 *
 * **모든 호출이 같은 모양을 돌려준다** — `{ ok: true, data } | { ok: false, status, message }`.
 * 화면은 status 로 갈래를 고르고 message 를 그대로 보인다(서버가 사람에게 쓴 문장이다).
 * 세션은 HttpOnly 쿠키라 여기서 자격증명을 들고 다니지 않는다.
 */
import { needsStepUp, stepUp } from './step-up.svelte';

export type Result<T> = { ok: true; data: T } | { ok: false; status: number; code?: string; message: string };

export type Role = 'auditor' | 'operator' | 'admin';

export type Me = {
  id: string; username: string; displayName: string | null; email: string | null;
  role: Role; roleAuthority: string; createdAt: string;
  /**
   * `method` — 로그인 · step-up 이 받는 코드. 'idp' 면 `idp`(IdP 호스트)의 인증 앱 코드다(IdP OTP — 로컬 인증 앱은 필수가 아니다).
   * IdP OTP 를 모르는 옛 서버는 보내지 않는다 — 없으면 'totp' 로 읽는다.
   */
  mfa: { totp: boolean; recoveryCodesLeft: number; method?: 'totp' | 'idp'; idp?: string };
  sessions: { createdAt: string; lastSeenAt: string; expiresAt: string; methods: string[]; ip: string | null; userAgent: string | null }[];
  identities: { issuer: string; subject: string; linkedAt: string; lastLoginAt: string | null }[];
  hasPassword: boolean;
};

/** 둘째 인증이 있는가 — 로컬 인증 앱 또는 IdP OTP. 민감 작업(step-up)을 할 수 있다. */
export const hasMfa = (me: Me): boolean => me.mfa.totp || me.mfa.method === 'idp';

/** 둘째 인증 단계의 답 — IdP OTP 대상이면 `method: 'idp'` 와 IdP 호스트가 붙는다. */
export type MfaRequired = { status: 'mfa_required'; method?: 'idp'; idp?: string };

export type SsoProvider = { issuer: string; jitEnabled: boolean; jitRole: string; roleClaim: string | null; roleMap: Record<string, Role> };
export type SsoProviders = { configured: string | null; providers: SsoProvider[] };

export type LinkPreview = {
  kind: 'invite' | 'bootstrap' | 'recovery'; role: Role; email: string | null; username?: string;
  needsTotp: boolean; totp?: { secret: string; uri: string };
};

export type UserRow = {
  id: string; username: string; displayName: string | null; email: string | null; role: Role;
  roleAuthority: string; status: 'active' | 'suspended'; createdAt: string; lockedUntil: string | null; totp: boolean;
  /** 마지막으로 쓸 수 있는 세션이 생긴 시각(MFA 까지 끝난 로그인). 한 번도 없으면 null. */
  lastLoginAt: string | null;
  /** 철회되지 않고 만료되지 않은 개인 API 토큰 수. */
  tokens: number;
};

/** 개인 API 토큰 한 줄 — **값은 없다**(발급 응답에 한 번만 나온다). `prefix` 는 비밀이 아닌 앞부분이다. */
export type ApiToken = {
  id: string; name: string; role: Role; prefix: string;
  createdAt: string; expiresAt: string; lastUsedAt: string | null;
};

export type InvitationRow = {
  id: string; kind: string; email: string | null; role: Role; invitedBy: string;
  createdAt: string; expiresAt: string; usedAt: string | null; revokedAt: string | null;
};

async function call<T>(method: string, path: string, body?: unknown, retried = false): Promise<Result<T>> {
  let r: Response;
  try {
    r = await fetch(path, {
      method,
      credentials: 'same-origin',
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch (e) {
    return { ok: false, status: 0, message: e instanceof Error ? e.message : String(e) };
  }
  const text = await r.text();
  let parsed: unknown = undefined;
  try { parsed = text === '' ? undefined : JSON.parse(text); } catch { /* 본문이 JSON 이 아니다 */ }
  if (!r.ok) {
    const { message, code } = (parsed ?? {}) as { message?: unknown; code?: unknown };
    // 민감 작업 — 코드를 한 번 받고 **한 번만** 다시 보낸다. 두 번째도 막히면 그대로 돌려준다.
    if (!retried && needsStepUp(r.status, code) && await stepUp.request()) return call<T>(method, path, body, true);
    return {
      ok: false, status: r.status, ...(typeof code === 'string' ? { code } : {}),
      message: typeof message === 'string' ? message : `${method} ${path} → ${r.status}`,
    };
  }
  return { ok: true, data: parsed as T };
}

export const accountApi = {
  login: (username: string, password: string) =>
    call<{ status: 'ok' } | MfaRequired>('POST', '/api/v1/session/login', { username, password }),
  mfa: (code: string) => call<{ status: 'ok' }>('POST', '/api/v1/session/mfa', { code }),
  logout: () => call<undefined>('POST', '/api/v1/session/logout', {}),
  features: () => call<{ accounts: boolean; mail: boolean; sso: boolean }>('GET', '/api/v1/account/features'),
  linkSso: (password: string) => call<{ url: string; state: string }>('POST', '/api/v1/me/identities/link', { password }),
  unlinkSso: (issuer: string, subject: string, password: string) =>
    call<{ unlinked: true }>('POST', '/api/v1/me/identities/unlink', { issuer, subject, password }),
  ssoProviders: () => call<SsoProviders>('GET', '/api/v1/sso-providers'),
  setJit: (issuer: string, jitEnabled: boolean) => call<{ updated: true }>('POST', '/api/v1/sso-providers', { issuer, jitEnabled }),
  setRoles: (issuer: string, roleClaim: string | null, roleMap: Record<string, string>) =>
    call<{ updated: true }>('POST', '/api/v1/sso-providers', { issuer, roleClaim, roleMap }),
  stepUp: (code: string) => call<{ stepUp: true }>('POST', '/api/v1/session/step-up', { code }, true),
  requestReset: (email: string) => call<{ accepted: true }>('POST', '/api/v1/account/password-reset', { email }),
  confirmReset: (token: string, password: string) => call<{ reset: true }>('POST', '/api/v1/account/password-reset/confirm', { token, password }),
  changeEmail: (email: string, password: string) => call<{ sent: true }>('POST', '/api/v1/me/email', { email, password }),
  confirmEmail: (token: string) => call<{ changed: true }>('POST', '/api/v1/account/email/confirm', { token }),
  logoutAll: () => call<{ revoked: number }>('POST', '/api/v1/session/logout-all', {}),
  me: () => call<Me>('GET', '/api/v1/me'),
  changePassword: (current: string, next: string) => call<{ changed: true }>('POST', '/api/v1/me/password', { current, next }),
  beginTotp: () => call<{ secret: string; uri: string }>('POST', '/api/v1/me/mfa/totp', {}),
  confirmTotp: (code: string) => call<{ recoveryCodes: string[] }>('POST', '/api/v1/me/mfa/totp/confirm', { code }),
  removeTotp: (password: string) => call<{ removed: true }>('POST', '/api/v1/me/mfa/totp/remove', { password }),
  recoveryCodes: (password: string) => call<{ recoveryCodes: string[] }>('POST', '/api/v1/me/mfa/recovery-codes', { password }),
  previewLink: (token: string) => call<LinkPreview>('POST', '/api/v1/invitations/preview', { token }),
  acceptLink: (input: { token: string; username?: string; password: string; totp?: { secret: string; code: string } }) =>
    call<{ userId: string; recoveryCodes?: string[] }>('POST', '/api/v1/invitations/accept', input),
  users: () => call<UserRow[]>('GET', '/api/v1/users'),
  updateUser: (id: string, patch: { role?: Role; status?: 'active' | 'suspended'; roleAuthority?: 'local' | 'idp' }) =>
    call<{ updated: true }>('PATCH', `/api/v1/users/${encodeURIComponent(id)}`, patch),
  deleteUser: (id: string) => call<{ deleted: true }>('DELETE', `/api/v1/users/${encodeURIComponent(id)}`),
  revokeSessions: (id: string) => call<{ revoked: number }>('POST', `/api/v1/users/${encodeURIComponent(id)}/revoke-sessions`, {}),
  recoveryLink: (id: string) => call<{ token: string }>('POST', `/api/v1/users/${encodeURIComponent(id)}/recovery-link`, {}),
  tokens: () => call<ApiToken[]>('GET', '/api/v1/account/tokens'),
  createToken: (name: string, role: Role, expiresInDays: number) =>
    call<ApiToken & { token: string }>('POST', '/api/v1/account/tokens', { name, role, expiresInDays }),
  revokeToken: (id: string) => call<{ revoked: true }>('DELETE', `/api/v1/account/tokens/${encodeURIComponent(id)}`),
  userTokens: (userId: string) => call<ApiToken[]>('GET', `/api/v1/users/${encodeURIComponent(userId)}/tokens`),
  revokeUserToken: (userId: string, id: string) =>
    call<{ revoked: true }>('DELETE', `/api/v1/users/${encodeURIComponent(userId)}/tokens/${encodeURIComponent(id)}`),
  invitations: () => call<InvitationRow[]>('GET', '/api/v1/invitations'),
  invite: (role: Role, email: string) =>
    call<{ id: string; token: string; expiresAt: string; mailed: boolean }>('POST', '/api/v1/invitations', { role, ...(email === '' ? {} : { email }) }),
  resendInvitation: (id: string) =>
    call<{ id: string; token: string; expiresAt: string; mailed: boolean }>('POST', `/api/v1/invitations/${encodeURIComponent(id)}/resend`),
  revokeInvitation: (id: string) => call<{ revoked: true }>('DELETE', `/api/v1/invitations/${encodeURIComponent(id)}`),
};

/** 링크는 이 화면의 출처로 만든다 — 토큰은 `#` 뒤라 서버 로그에 안 남는다. */
export const linkFor = (token: string): string => `${location.origin}/invite#${token}`;
