/**
 * CLI 계정 명령 (2026-11-21) — `bary me` · `bary token …` · `bary user …` · `bary invite …`.
 *
 * **권한을 느슨하게 하지 않는다.** 서버가 정한 대로 간다:
 *  - 민감 작업(토큰 만들기·폐기, 역할·상태 바꾸기, 삭제, 세션 끊기, 복구 링크, 초대)은 사람 세션에서 인증 앱을 다시 확인해야 한다.
 *    개인 API 토큰은 403 `token_not_allowed` 를 받는다. 서버의 파일 토큰(비상 출입구, admin 범위)만 명령줄에서 할 수 있다.
 *  - 내 토큰(`/account/tokens`)은 사람 계정에 붙는다. 파일 토큰에는 주인이 없다.
 * 그래서 실패하면 **왜 안 되는지와 어디서 하는지**를 말한다(`explainAuth`).
 *
 * 한 번만 나오는 값(새 토큰, 초대·복구 링크)은 표준 출력에 한 번 쓴다. 다시 볼 수 없다.
 */
import { CliRequestError, unwrap, type Http } from './flow.js';

export const ROLES = ['auditor', 'operator', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export function roleOf(word: string): Role {
  if ((ROLES as readonly string[]).includes(word)) return word as Role;
  throw new Error(`역할을 모른다: ${JSON.stringify(word)} — ${ROLES.join(' · ')}`);
}

/** 권한 실패에 **이유와 갈 곳**을 덧붙인다. 다른 실패는 그대로 둔다. */
export function explainAuth(e: unknown): string {
  const base = e instanceof Error ? e.message : String(e);
  if (!(e instanceof CliRequestError)) return base;
  const code = (e.body as { code?: string } | null)?.code;
  if (code === 'token_not_allowed') {
    return `${base}\n  개인 API 토큰으로는 이 작업을 못 한다 — 인증 앱 확인이 필요한 일이다. GUI 에서 하거나, 서버의 admin 파일 토큰을 쓴다.`;
  }
  if (code === 'mfa_step_up_required') {
    return `${base}\n  사람 세션의 인증 앱 확인이 오래됐다. GUI 에서 다시 확인한 뒤 한다.`;
  }
  if (code === 'forbidden') {
    return `${base}\n  이 토큰의 범위가 모자란다. 계정 관리는 admin 범위가 필요하다.`;
  }
  if (e.status === 401) return `${base}\n  BARY_TOKEN 이 없거나 틀렸다.`;
  return base;
}

export const me = async (http: Http): Promise<unknown> => unwrap(await http('GET', '/api/v1/me'), 'me');

// ---- 내 API 토큰 ----

export const tokenList = async (http: Http): Promise<unknown> =>
  unwrap(await http('GET', '/api/v1/account/tokens'), 'token list');

export type TokenInput = { name: string; role: Role; expiresInDays?: number };

export async function tokenCreate(http: Http, t: TokenInput): Promise<unknown> {
  if (t.name.trim() === '') throw new Error('--name 이 비었다');
  if (t.expiresInDays !== undefined && !(Number.isInteger(t.expiresInDays) && t.expiresInDays >= 1 && t.expiresInDays <= 365)) {
    throw new Error('--days 는 1–365 사이의 정수다');
  }
  return unwrap(await http('POST', '/api/v1/account/tokens', {
    name: t.name.trim(), role: t.role, ...(t.expiresInDays === undefined ? {} : { expiresInDays: t.expiresInDays }),
  }), 'token create');
}

export const tokenRevoke = async (http: Http, id: string): Promise<unknown> =>
  unwrap(await http('DELETE', `/api/v1/account/tokens/${encodeURIComponent(id)}`), 'token revoke');

// ---- 사용자 (admin) ----

type UserRow = { id: string; username: string };

export const userList = async (http: Http): Promise<unknown> => unwrap(await http('GET', '/api/v1/users'), 'user list');

/** 사용자 이름(또는 id) → id. 사람은 이름으로 말한다 — API 는 id 를 받는다. */
export async function userIdOf(http: Http, who: string): Promise<string> {
  const rows = (await userList(http)) as UserRow[];
  const hit = rows.find((u) => u.username === who) ?? rows.find((u) => u.id === who);
  if (hit === undefined) throw new Error(`사용자가 없다: ${JSON.stringify(who)}`);
  return hit.id;
}

const userPath = (id: string, rest = ''): string => `/api/v1/users/${encodeURIComponent(id)}${rest}`;

export async function userRole(http: Http, who: string, role: Role): Promise<unknown> {
  return unwrap(await http('PATCH', userPath(await userIdOf(http, who)), { role }), 'user role');
}

/** 활성화 · 비활성화. 비활성 사용자는 로그인하지 못하고 세션이 끊긴다. */
export async function userStatus(http: Http, who: string, status: 'active' | 'suspended'): Promise<unknown> {
  return unwrap(await http('PATCH', userPath(await userIdOf(http, who)), { status }), `user ${status === 'active' ? 'activate' : 'deactivate'}`);
}

/** 역할을 누가 정하나 — `local`(이 화면 · CLI) 또는 `idp`(IdP 가 매 로그인 때). */
export async function userAuthority(http: Http, who: string, authority: 'local' | 'idp'): Promise<unknown> {
  return unwrap(await http('PATCH', userPath(await userIdOf(http, who)), { roleAuthority: authority }), 'user authority');
}

export async function userDelete(http: Http, who: string): Promise<unknown> {
  return unwrap(await http('DELETE', userPath(await userIdOf(http, who))), 'user delete');
}

export async function userRevokeSessions(http: Http, who: string): Promise<unknown> {
  return unwrap(await http('POST', userPath(await userIdOf(http, who), '/revoke-sessions')), 'user revoke-sessions');
}

/** 복구 링크 — 대상의 인증 앱을 초기화하고 세션을 끊는다. 링크 토큰은 이 응답에만 한 번 나온다. */
export async function userRecoveryLink(http: Http, who: string): Promise<unknown> {
  return unwrap(await http('POST', userPath(await userIdOf(http, who), '/recovery-link')), 'user recovery-link');
}

export async function userTokens(http: Http, who: string): Promise<unknown> {
  return unwrap(await http('GET', userPath(await userIdOf(http, who), '/tokens')), 'user tokens');
}

export async function userTokenRevoke(http: Http, who: string, tokenId: string): Promise<unknown> {
  return unwrap(await http('DELETE', userPath(await userIdOf(http, who), `/tokens/${encodeURIComponent(tokenId)}`)), 'user token revoke');
}

// ---- 초대 (admin) ----

export const inviteList = async (http: Http): Promise<unknown> => unwrap(await http('GET', '/api/v1/invitations'), 'invite list');

/** 초대 — 메일이 켜져 있고 주소를 주면 메일로 간다. 아니면 링크가 이 응답에만 한 번 나온다. */
export async function inviteCreate(http: Http, role: Role, email?: string): Promise<unknown> {
  return unwrap(await http('POST', '/api/v1/invitations', { role, ...(email === undefined || email === '' ? {} : { email }) }), 'invite create');
}

export const inviteResend = async (http: Http, id: string): Promise<unknown> =>
  unwrap(await http('POST', `/api/v1/invitations/${encodeURIComponent(id)}/resend`), 'invite resend');

export const inviteRevoke = async (http: Http, id: string): Promise<unknown> =>
  unwrap(await http('DELETE', `/api/v1/invitations/${encodeURIComponent(id)}`), 'invite revoke');
