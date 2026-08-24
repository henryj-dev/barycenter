import { randomBytes } from 'node:crypto';

import type { Principal } from './auth.js';

export const SESSION_COOKIE = 'bary_session';
export const LOGIN_COOKIE = 'bary_login';

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 1024;

type Session = { principal: Principal; expiresAt: number };
type Login = { state: string; codeVerifier: string; nonce: string; expiresAt: number };

const opaque = (): string => randomBytes(32).toString('base64url');

/**
 * 정적 GUI의 OIDC 교환과 API 인증 사이를 잇는 데몬 내부 세션.
 *
 * 토큰·PKCE 검증자를 브라우저 저장소에 돌려주지 않는다. 세션은 인스턴스 메모리에만
 * 있고 재시작하면 사라진다. 다중 인스턴스 공유가 필요해지는 배포는 이 경계를 외부
 * 세션 저장소로 명시적으로 확장해야 한다 — 쿠키를 서명만 해 두고 ID Token을 다시
 * 브라우저로 내보내는 식의 가짜 HttpOnly는 하지 않는다.
 */
export class BrowserSessions {
  readonly #sessions = new Map<string, Session>();
  readonly #logins = new Map<string, Login>();

  beginLogin(input: { state: string; codeVerifier: string; nonce: string }, now = Date.now()): string {
    this.prune(now);
    const id = opaque();
    this.#logins.set(id, { ...input, expiresAt: now + LOGIN_TTL_MS });
    this.cap(this.#logins);
    return id;
  }

  takeLogin(id: string | undefined, state: string, now = Date.now()):
    { codeVerifier: string; nonce: string } | undefined {
    if (id === undefined) return undefined;
    this.prune(now);
    const login = this.#logins.get(id);
    this.#logins.delete(id);
    if (login === undefined || login.expiresAt <= now || login.state !== state) return undefined;
    return { codeVerifier: login.codeVerifier, nonce: login.nonce };
  }

  create(principal: Principal, now = Date.now()): string {
    this.prune(now);
    const id = opaque();
    this.#sessions.set(id, { principal, expiresAt: now + SESSION_TTL_MS });
    this.cap(this.#sessions);
    return id;
  }

  get(id: string | undefined, now = Date.now()): Principal | undefined {
    if (id === undefined) return undefined;
    this.prune(now);
    const session = this.#sessions.get(id);
    if (session === undefined || session.expiresAt <= now) return undefined;
    return session.principal;
  }

  clear(id: string | undefined): void {
    if (id !== undefined) this.#sessions.delete(id);
  }

  private prune(now: number): void {
    for (const [id, session] of this.#sessions) {
      if (session.expiresAt <= now) this.#sessions.delete(id);
    }
    for (const [id, login] of this.#logins) {
      if (login.expiresAt <= now) this.#logins.delete(id);
    }
  }

  private cap<T>(map: Map<string, T>): void {
    while (map.size > MAX_ENTRIES) {
      const oldest = map.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      map.delete(oldest);
    }
  }
}

export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (key === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

export function sessionCookie(name: string, value: string, secure: boolean, maxAge: number): string {
  return `${name}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function expiredCookie(name: string, secure: boolean): string {
  return sessionCookie(name, '', secure, 0);
}
