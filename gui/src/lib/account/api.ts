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
  mfa: { totp: boolean; recoveryCodesLeft: number };
  sessions: { createdAt: string; lastSeenAt: string; expiresAt: string; methods: string[]; ip: string | null; userAgent: string | null }[];
  identities: { issuer: string; subject: string; linkedAt: string; lastLoginAt: string | null }[];
  hasPassword: boolean;
};

export type SsoProvider = { issuer: string; jitEnabled: boolean; jitRole: string; roleClaim: string | null; roleMap: Record<string, Role> };
export type SsoProviders = { configured: string | null; providers: SsoProvider[] };

export type LinkPreview = {
  kind: 'invite' | 'bootstrap' | 'recovery'; role: Role; email: string | null; username?: string;
  needsTotp: boolean; totp?: { secret: string; uri: string };
};

export type UserRow = {
  id: string; username: string; displayName: string | null; email: string | null; role: Role;
  roleAuthority: string; status: 'active' | 'suspended'; createdAt: string; lockedUntil: string | null; totp: boolean;
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
    call<{ status: 'ok' | 'mfa_required' }>('POST', '/api/v1/session/login', { username, password }),
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
  invitations: () => call<InvitationRow[]>('GET', '/api/v1/invitations'),
  invite: (role: Role, email: string) =>
    call<{ id: string; token: string; expiresAt: string; mailed: boolean }>('POST', '/api/v1/invitations', { role, ...(email === '' ? {} : { email }) }),
  revokeInvitation: (id: string) => call<{ revoked: true }>('DELETE', `/api/v1/invitations/${encodeURIComponent(id)}`),
};

/** 링크는 이 화면의 출처로 만든다 — 토큰은 `#` 뒤라 서버 로그에 안 남는다. */
export const linkFor = (token: string): string => `${location.origin}/invite#${token}`;
