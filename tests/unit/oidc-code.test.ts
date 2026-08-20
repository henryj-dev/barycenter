/**
 * Authorization Code RP · Kit 로그인 · ADR-SPOF.
 * 표면(`src/index.ts`)에 새 이름을 안 올린다.
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { hashToken, TokenAuth } from '../../src/api/auth.js';
import {
  authorizationRequest, exchangeAuthorizationCode, tokenRequestBody,
} from '../../src/api/oidc-code.js';
import { KIT_ROUTES, pageOf } from '../../src/web/page.js';
import * as surface from '../../src/index.js';

const SECRET = 'oidc-hs256-secret';
const ISS = 'https://idp.example';
const AUD = 'barycenter';
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

const b64url = (b: Buffer): string =>
  b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function idToken(over: Record<string, unknown>, secret = SECRET): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = b64url(Buffer.from(JSON.stringify({
    iss: ISS, aud: AUD, exp: 2_000_000_000, sub: 'alice', role: 'operator', ...over,
  })));
  const sig = b64url(createHmac('sha256', secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

const rp = {
  issuer: ISS,
  audience: AUD,
  key: SECRET,
  now: () => 1_700_000_000,
  authorizationEndpoint: 'https://idp.example/authorize',
  tokenEndpoint: 'https://idp.example/token',
  clientId: 'bary-gui',
  redirectUri: 'https://cp.example/login',
};

describe('Authorization Code', () => {
  it('요청은 response_type=code 와 openid 를 싣고 교환은 기존 ID Token 검증을 지난다', async () => {
    const url = authorizationRequest(rp, { state: 'st-1' });
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toMatch(/openid/);
    expect(url.searchParams.get('client_id')).toBe('bary-gui');
    expect(url.searchParams.get('redirect_uri')).toBe('https://cp.example/login');
    expect(url.searchParams.get('state')).toBe('st-1');

    const valid = idToken({ role: 'operator' });
    const ok = await exchangeAuthorizationCode(rp, 'good', async (input, init) => {
      expect(String(input)).toBe(rp.tokenEndpoint);
      expect(init?.method).toBe('POST');
      expect(String(init?.body)).toBe(tokenRequestBody(rp, 'good'));
      expect(String(init?.body)).toContain('grant_type=authorization_code');
      return new Response(JSON.stringify({ id_token: valid }), { status: 200 });
    });
    expect(ok?.principal.name).toBe('alice');
    expect(ok?.principal.role).toBe('operator');
    expect(ok?.id_token).toBe(valid);

    const missing = await exchangeAuthorizationCode(rp, 'nope', async () =>
      new Response(JSON.stringify({ access_token: 'x' }), { status: 200 }));
    expect(missing).toBeUndefined();

    const bad = await exchangeAuthorizationCode(rp, 'bad', async () =>
      new Response(JSON.stringify({ id_token: idToken({ iss: 'https://other' }) }), { status: 200 }));
    expect(bad).toBeUndefined();

    const hashed = new TokenAuth([
      { name: 'ci', hash: hashToken('api-token'), scopes: ['read', 'write', 'apply'] },
    ], rp);
    expect(hashed.authenticate('Bearer api-token')?.name).toBe('ci');
    expect(hashed.authenticate(`Bearer ${valid}`)?.role).toBe('operator');
  });
});

describe('Kit 로그인', () => {
  it('로그인 자리가 Kit 페이지고 폴링이 없다', () => {
    expect(pageOf('/login')).toBe('login');
    expect(KIT_ROUTES.some((r) => r.path === '/login' && r.place === 'login')).toBe(true);
    const page = readFileSync(join(root, 'gui/src/routes/login/+page.svelte'), 'utf8');
    expect(page).toContain('IdP로 로그인');
    expect(page).not.toMatch(/setInterval|setTimeout\(\s*\(\)\s*=>\s*fetch/);
    const layout = readFileSync(join(root, 'gui/src/routes/+layout.svelte'), 'utf8');
    expect(layout).not.toMatch(/setInterval|setTimeout\(\s*\(\)\s*=>\s*fetch/);
  });
});

describe('ADR-SPOF', () => {
  it('RTO/RPO 를 v1 운영 정책으로 확정하고 런북은 후보가 아니다', () => {
    const adr = readFileSync(join(root, 'docs/adr-spof.md'), 'utf8');
    expect(adr).toMatch(/운영 정책/);
    expect(adr).toMatch(/15분/);
    expect(adr).toMatch(/RPO/);
    expect(adr).toMatch(/수동/);
    expect(adr).not.toMatch(/목표 후보/);
    expect(adr).not.toMatch(/구속력이 없다/);
    const runbook = readFileSync(join(root, 'docs/runbook-spof.md'), 'utf8');
    expect(runbook).toContain('adr-spof');
    expect(runbook).toMatch(/운영 정책/);
    expect(runbook).toMatch(/15분/);
    expect(runbook).not.toMatch(/목표 후보/);
    expect(runbook).not.toMatch(/구속력이 없다/);
    expect(runbook).toMatch(/수동/);
  });
});

describe('표면', () => {
  it('OIDC 이름을 v0.1 표면에 안 올린다', () => {
    const names = Object.keys(surface).join(' ');
    expect(names).not.toContain('Oidc');
    expect(names).not.toContain('IdToken');
    expect(names).not.toContain('principalFromIdToken');
    expect(names).not.toContain('authorizationRequest');
  });
});
