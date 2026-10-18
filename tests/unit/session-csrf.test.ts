/**
 * **쿠키로 들어온 쓰기는 같은 출처에서만** (2026-10-18).
 *
 * 세션 쿠키는 `SameSite=Lax` 인데, Lax 는 **형제 서브도메인**을 못 막는다 — 사이트는
 * 등록 가능 도메인 단위라 `evil.example.com` 과 `bary.example.com` 은 같은 사이트다.
 * 그 쿠키가 write·apply 까지 인증하므로, 지역 대시보드를 공개 도메인 아래 열면 옆
 * 서브도메인의 폼 하나가 설정 변경이 된다. 여기서는 그 문이 닫혔는지를 실제 서버로 잰다.
 */
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hashToken, TokenAuth } from '../../src/api/auth.js';
import { BrowserSessions, SESSION_COOKIE } from '../../src/api/browser-session.js';
import { createApi, sameOriginWrite } from '../../src/api/server.js';
import type { ConfigStore } from '../../src/store/config-store.js';
import type { ControlPlane } from '../../src/control/plane.js';
import type { Db } from '../../src/store/pg.js';
import type { LeaderElection } from '../../src/control/leader.js';

const req = (method: string, headers: Record<string, string>): IncomingMessage =>
  ({ method, headers }) as unknown as IncomingMessage;

describe('sameOriginWrite', () => {
  it('GET·HEAD 는 출처를 안 본다', () => {
    expect(sameOriginWrite(req('GET', { host: 'bary.example', origin: 'https://evil.example' }))).toBe(true);
    expect(sameOriginWrite(req('HEAD', {}))).toBe(true);
  });

  it('**형제 서브도메인의 Origin 은 거절한다**', () => {
    expect(sameOriginWrite(req('POST', {
      host: 'dev-icn.bary.example.com', origin: 'https://evil.example.com',
    }))).toBe(false);
  });

  it('같은 host 면 스킴이 달라도 받는다 (앞단 TLS 종단)', () => {
    expect(sameOriginWrite(req('POST', { host: 'bary.example:8443', origin: 'https://bary.example:8443' }))).toBe(true);
    expect(sameOriginWrite(req('POST', { host: 'bary.example', origin: 'http://bary.example' }))).toBe(true);
  });

  it('포트가 다르면 다른 출처다', () => {
    expect(sameOriginWrite(req('POST', { host: 'bary.example:8443', origin: 'https://bary.example' }))).toBe(false);
  });

  it('Origin 이 없으면 Sec-Fetch-Site: same-origin 일 때만 받는다', () => {
    expect(sameOriginWrite(req('POST', { host: 'bary.example', 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(sameOriginWrite(req('POST', { host: 'bary.example', 'sec-fetch-site': 'same-site' }))).toBe(false);
    expect(sameOriginWrite(req('POST', { host: 'bary.example' }))).toBe(false);
  });

  it('`Origin: null` 과 깨진 값은 거절한다', () => {
    expect(sameOriginWrite(req('POST', { host: 'bary.example', origin: 'null' }))).toBe(false);
    expect(sameOriginWrite(req('POST', { host: 'bary.example', origin: '::' }))).toBe(false);
  });
});

describe('세션 쿠키 쓰기의 출처 검사 — 실제 서버', () => {
  const TOKEN = 'plain-bearer-token';
  let server: Server | undefined;
  let base = '';
  let cookie = '';
  let imports = 0;

  beforeEach(async () => {
    imports = 0;
    const sessions = new BrowserSessions();
    cookie = `${SESSION_COOKIE}=${sessions.create({ name: 'alice', scopes: new Set(['read', 'write']), role: 'operator' })}`;
    server = createApi({
      db: {} as Db,
      store: {
        head: async () => ({ revision: '1', etag: 'e1' }),
        importFromManifest: async () => { imports++; return { revision: '2', unchanged: false }; },
      } as unknown as ConfigStore,
      control: {} as ControlPlane,
      auth: new TokenAuth([{ name: 'ci', scopes: ['read', 'write'], hash: hashToken(TOKEN) }]),
      election: { state: { isLeader: true } } as unknown as LeaderElection,
      sessions,
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server?.closeAllConnections?.();
    if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  const post = (headers: Record<string, string>): Promise<Response> =>
    fetch(`${base}/api/v1/config/import`, {
      method: 'POST', headers: { 'content-type': 'text/plain', ...headers }, body: '{"manifest":{}}',
    });

  it('**다른 출처에서 쿠키로 온 쓰기는 403 이고 저장소에 닿지 않는다**', async () => {
    const r = await post({ cookie, origin: 'https://evil.example.com' });
    expect(r.status).toBe(403);
    expect((await r.json() as { code: string }).code).toBe('cross_site');
    expect(imports).toBe(0);
  });

  it('출처 표시가 없는 쿠키 쓰기도 403 이다', async () => {
    expect((await post({ cookie })).status).toBe(403);
    expect(imports).toBe(0);
  });

  it('같은 출처면 통과한다', async () => {
    expect((await post({ cookie, origin: base })).status).toBe(200);
    expect(imports).toBe(1);
  });

  it('Bearer 는 Origin 없이도 그대로다 (CLI·CI·수집기)', async () => {
    expect((await post({ authorization: `Bearer ${TOKEN}` })).status).toBe(200);
    expect(imports).toBe(1);
  });

  it('쿠키 GET 은 출처를 안 본다', async () => {
    const r = await fetch(`${base}/api/v1/config/head`, { headers: { cookie, origin: 'https://evil.example.com' } });
    expect(r.status).toBe(200);
  });

  it('로그아웃·로그인 교환도 같은 문을 지난다', async () => {
    const out = await fetch(`${base}/api/v1/session/logout`, {
      method: 'POST', headers: { origin: 'https://evil.example.com' },
    });
    expect(out.status).toBe(403);
    const tok = await fetch(`${base}/api/v1/oidc/token`, {
      method: 'POST', headers: { origin: 'https://evil.example.com' }, body: '{}',
    });
    expect(tok.status).toBe(403);
  });
});
