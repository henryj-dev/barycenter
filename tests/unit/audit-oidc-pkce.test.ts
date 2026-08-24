/**
 * 검수 2026-08-22 · S-06 나머지 — **Authorization Code 에 PKCE 도 nonce 도 없었다**
 *
 * `authorizationRequest` 가 `response_type=code` · `state` 만 싣는다. 그래서 둘이 빈다.
 *
 * ── PKCE (RFC 7636 · BCP 는 RFC 9700)
 *
 * 리다이렉트로 돌아오는 `code` 를 가로챈 자가 그대로 Token Endpoint 에 낼 수 있다.
 * 브라우저 히스토리 · Referer · 로그 · 악성 확장 · 같은 기기의 다른 앱 — 경로가 여럿이다.
 * `client_secret` 이 있으면 낫지만, **이 RP 는 브라우저에서 도는 SPA 라 secret 이 없는
 * 배포가 정상**이고 그때 `code` 는 그 자체로 자격증명이다. 지금 BCP 는 secret 이 있는
 * 클라이언트에도 PKCE 를 요구한다.
 *
 * ── nonce (OIDC Core 3.1.2.1)
 *
 * `id_token` 을 이 로그인 시도에 묶는 값이다. 없으면 다른 데서 얻은 멀쩡한 `id_token`
 * 하나가 어느 세션에나 들어맞는다.
 *
 * ── 왜 검증자를 API 세션이 들고 있나
 *
 * 정적 GUI가 토큰과 검증자를 브라우저 저장소에 보관하지 않도록, 데몬의 짧은 수명
 * 로그인 세션이 state·verifier·nonce를 보관한다. 세션은 인스턴스 메모리이므로 재시작과
 * 다중 인스턴스 사이에는 공유되지 않는다 — 그 한계를 설계에 명시한다.
 *
 * 따라서 브라우저가 장악돼도 토큰·검증자 자체가 storage에서 직접 읽히지는 않는다.
 * 훔친 `id_token` 주입을 막는 것은 nonce이고, 가로챈 `code`를 막는 것은 **PKCE**다.
 */
import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  authorizationRequest, exchangeAuthorizationCode, pkceChallenge, pkceVerifier,
  tokenRequestBody, type OidcRpSettings,
} from '../../src/api/oidc-code.js';
import { principalFromIdToken, type OidcSettings } from '../../src/api/auth.js';

const SECRET = 'hs256-shared-secret';
const NOW = 1_700_000_000;

const b64url = (b: Buffer): string =>
  b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** HS256 으로 진짜 서명한다. 검증을 흉내로 대신하면 이 테스트가 뜻을 잃는다. */
function hs256(payload: Record<string, unknown>): string {
  const head = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = createHmac('sha256', SECRET).update(`${head}.${body}`).digest();
  return `${head}.${body}.${b64url(sig)}`;
}

const claims = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  iss: 'https://idp.example', aud: 'bary-gui', exp: NOW + 600, sub: 'u1', role: 'operator',
  ...over,
});

const settings = (over: Partial<OidcSettings> = {}): OidcSettings => ({
  issuer: 'https://idp.example', audience: 'bary-gui', key: SECRET, now: () => NOW, ...over,
});

const rp = (): OidcRpSettings => ({
  ...settings(),
  authorizationEndpoint: 'https://idp.example/authorize',
  tokenEndpoint: 'https://idp.example/token',
  clientId: 'bary-gui',
  redirectUri: 'https://bary.example/login',
});

describe('PKCE (검수 S-06 나머지)', () => {
  it('검증자는 매번 다르고 RFC 7636 길이 안에 든다', () => {
    const a = pkceVerifier();
    const b = pkceVerifier();
    expect(a).not.toBe(b);
    // 43–128 자, unreserved 문자만.
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(a.length).toBeLessThanOrEqual(128);
    expect(a).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it('챌린지는 S256 이다 — 검증자를 그대로 싣지 않는다', () => {
    /**
     * `plain` 은 RFC 가 남겨 뒀지만 가로챈 자가 챌린지를 그대로 검증자로 쓸 수 있어
     * 아무것도 안 막는다. 고를 수 있게 두지 않는다.
     */
    const v = pkceVerifier();
    const want = createHash('sha256').update(v).digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(pkceChallenge(v)).toBe(want);
    expect(pkceChallenge(v)).not.toBe(v);
  });

  it('인증 요청이 챌린지와 방식을 싣는다', () => {
    const url = authorizationRequest(rp(), { state: 's', codeChallenge: 'abc', nonce: 'n' });
    expect(url.searchParams.get('code_challenge')).toBe('abc');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('nonce')).toBe('n');
  });

  it('안 주면 안 싣는다 — 없는 값을 빈 문자열로 보내지 않는다', () => {
    // 빈 `nonce=` 를 보내면 IdP 에 따라 "nonce 를 요구했다" 로 읽혀 검증이 꼬인다.
    const url = authorizationRequest(rp(), { state: 's' });
    expect(url.searchParams.has('code_challenge')).toBe(false);
    expect(url.searchParams.has('code_challenge_method')).toBe(false);
    expect(url.searchParams.has('nonce')).toBe(false);
  });

  it('토큰 요청이 검증자를 싣는다', () => {
    const body = new URLSearchParams(tokenRequestBody(rp(), 'c0de', 'ver-1'));
    expect(body.get('code_verifier')).toBe('ver-1');
    expect(body.get('code')).toBe('c0de');
  });
});

describe('nonce 를 실제로 검사한다 (검수 S-06 나머지)', () => {
  it('기대하는 nonce 가 있으면 다른 토큰은 거절한다', () => {
    const t = hs256(claims({ nonce: 'other' }));
    expect(principalFromIdToken(t, settings({ nonce: 'mine' }))).toBeUndefined();
  });

  it('기대하는데 토큰에 없으면 거절한다', () => {
    // 여기가 핵심이다. IdP 가 nonce 를 되돌려 주지 않으면 묶음이 성립하지 않는다.
    const t = hs256(claims());
    expect(principalFromIdToken(t, settings({ nonce: 'mine' }))).toBeUndefined();
  });

  it('맞으면 지난다', () => {
    const t = hs256(claims({ nonce: 'mine' }));
    expect(principalFromIdToken(t, settings({ nonce: 'mine' }))?.name).toBe('u1');
  });

  it('안 기대하면 토큰의 nonce 는 안 따진다', () => {
    // nonce 를 안 보낸 배포를 막으면 안 된다 — 켜는 것은 시작 쪽의 선택이다.
    const t = hs256(claims({ nonce: 'whatever' }));
    expect(principalFromIdToken(t, settings())?.name).toBe('u1');
  });
});

describe('교환이 검증자와 nonce 를 실제로 쓴다 (검수 S-06 나머지)', () => {
  it('검증자를 Token Endpoint 로 보내고 nonce 를 확인한다', async () => {
    let sent = '';
    const fake: typeof fetch = async (_u, init) => {
      sent = String(init?.body ?? '');
      return new Response(JSON.stringify({ id_token: hs256(claims({ nonce: 'n1' })) }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    };
    const out = await exchangeAuthorizationCode(rp(), 'c0de', fake, {
      codeVerifier: 'v1', nonce: 'n1',
    });
    expect(new URLSearchParams(sent).get('code_verifier')).toBe('v1');
    expect(out?.principal.name).toBe('u1');
  });

  it('nonce 가 안 맞으면 교환이 실패한다', async () => {
    const fake: typeof fetch = async () => new Response(
      JSON.stringify({ id_token: hs256(claims({ nonce: 'attacker' })) }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
    const out = await exchangeAuthorizationCode(rp(), 'c0de', fake, {
      codeVerifier: 'v1', nonce: 'n1',
    });
    expect(out).toBeUndefined();
  });
});
