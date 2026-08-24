import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { hashToken, TokenAuth } from '../../src/api/auth.js';
import { BrowserSessions, cookieValue, SESSION_COOKIE, sessionCookie } from '../../src/api/browser-session.js';
import { createApi } from '../../src/api/server.js';
import type { ConfigStore } from '../../src/store/config-store.js';
import type { ControlPlane } from '../../src/control/plane.js';
import type { Db } from '../../src/store/pg.js';
import type { LeaderElection } from '../../src/control/leader.js';

const secret = 'browser-session-secret';
const b64 = (b: Buffer): string => b.toString('base64url');
const idToken = (nonce: string): string => {
  const head = b64(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64(Buffer.from(JSON.stringify({
    iss: 'https://idp.example', aud: 'bary-gui', exp: 2_000_000_000,
    sub: 'alice', role: 'operator', nonce,
  })));
  return `${head}.${body}.${b64(createHmac('sha256', secret).update(`${head}.${body}`).digest())}`;
};

class CapturingSessions extends BrowserSessions {
  lastLogin?: { state: string; nonce: string; codeVerifier: string };

  override beginLogin(input: { state: string; codeVerifier: string; nonce: string }): string {
    this.lastLogin = input;
    return super.beginLogin(input);
  }
}

describe('브라우저 인증 세션', () => {
  it('GUI 소스가 토큰·PKCE 자료를 브라우저 저장소에 보관하지 않는다', () => {
    const desk = readFileSync(new URL('../../gui/src/lib/desk.svelte.ts', import.meta.url), 'utf8');
    const login = readFileSync(new URL('../../gui/src/routes/login/+page.svelte', import.meta.url), 'utf8');
    expect(`${desk}\n${login}`).not.toContain('sessionStorage');
    expect(login).not.toContain('id_token');
    expect(login).not.toContain('code_verifier');
  });

  it('PKCE 자료는 서버에 두고, opaque 세션만 쿠키로 내보낸다', () => {
    const sessions = new BrowserSessions();
    const login = sessions.beginLogin({ state: 's', codeVerifier: 'v', nonce: 'n' }, 0);
    expect(sessions.takeLogin(login, 'wrong', 1)).toBeUndefined();
    const second = sessions.beginLogin({ state: 's', codeVerifier: 'v', nonce: 'n' }, 0);
    expect(sessions.takeLogin(second, 's', 1)).toEqual({ codeVerifier: 'v', nonce: 'n' });
    expect(sessions.takeLogin(second, 's', 2)).toBeUndefined();
    const session = sessions.create({ name: 'alice', scopes: new Set(['read']) }, 0);
    expect(sessions.get(session, 1)?.name).toBe('alice');
    sessions.clear(session);
    expect(sessions.get(session, 1)).toBeUndefined();
  });

  it('쿠키 속성이 HttpOnly·SameSite=Lax·HTTPS에서는 Secure다', () => {
    const value = sessionCookie(SESSION_COOKIE, 'opaque', true, 60);
    expect(value).toContain('HttpOnly');
    expect(value).toContain('SameSite=Lax');
    expect(value).toContain('Secure');
    expect(cookieValue(`${value}; other=x`, SESSION_COOKIE)).toBe('opaque');
  });
});

describe('OIDC 교환의 HttpOnly 세션 경계', () => {
  let server: Server | undefined;

  afterEach(async () => {
    server?.closeAllConnections?.();
    if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it('ID Token을 응답 본문에 내보내지 않고 세션 쿠키로 인증한다', async () => {
    const sessions = new CapturingSessions();
    server = createApi({
      db: {} as Db,
      store: { head: async () => ({ revision: '1', etag: 'e1' }) } as unknown as ConfigStore,
      control: {} as ControlPlane,
      auth: new TokenAuth([], {
        issuer: 'https://idp.example', audience: 'bary-gui', key: secret,
      }),
      election: {} as LeaderElection,
      sessions,
      oidcRp: {
        issuer: 'https://idp.example', audience: 'bary-gui', key: secret,
        authorizationEndpoint: 'https://idp.example/authorize',
        tokenEndpoint: 'https://idp.example/token', clientId: 'bary-gui',
        redirectUri: 'https://bary.example/login',
      },
      oidcFetch: async () => new Response(JSON.stringify({ id_token: idToken(sessions.lastLogin!.nonce) }), { status: 200 }),
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const start = await fetch(`${base}/api/v1/oidc/authorization-request`);
    const startBody = await start.json() as { state: string };
    const loginCookie = start.headers.get('set-cookie')!.split(';', 1)[0]!;
    const exchange = await fetch(`${base}/api/v1/oidc/token`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: loginCookie },
      body: JSON.stringify({ code: 'good', state: startBody.state }),
    });
    expect(exchange.status).toBe(200);
    expect(await exchange.json()).toEqual({ authenticated: true });
    const sessionCookie = exchange.headers.get('set-cookie')!.split(';', 1)[0]!;
    expect(sessionCookie).toContain(`${SESSION_COOKIE}=`);
    expect(exchange.headers.get('set-cookie')).toContain('HttpOnly');

    const secured = await fetch(`${base}/api/v1/config/head`, { headers: { cookie: sessionCookie } });
    expect(secured.status).toBe(200);
  });
});
