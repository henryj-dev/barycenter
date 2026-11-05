/**
 * OIDC discovery — 문서로 authorization · token · jwks 를 채운다.
 *
 * 재는 것: 정상 · **손으로 준 값이 이긴다** · **issuer 불일치 거부** · http 거절(보내지 않음) · 문서 안 주소가 https 아님 ·
 * 200 아님 · 닿지 못함 · JSON 아님 · 응답 크기 상한 · `redirect: 'error'` · 던지지 않음.
 */
import { describe, expect, it } from 'vitest';

import { discoverOidc, discoveryUrlFor, MAX_DISCOVERY_BYTES, withDiscovered } from '../../src/api/oidc-discovery.js';

const ISS = 'https://idp.test';
const URL_ = `${ISS}/.well-known/openid-configuration`;
const DOC = {
  issuer: ISS, authorization_endpoint: `${ISS}/oidc/authorize`, token_endpoint: `${ISS}/oidc/token`, jwks_uri: `${ISS}/oidc/jwks`,
};
type Call = { url: string; init: RequestInit };
function fake(respond: () => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), init: init ?? {} }); return respond(); }) as typeof fetch,
  };
}
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });

describe('OIDC discovery', () => {
  it('정상 — 세 주소를 읽는다. 요청은 GET · redirect: error · 타임아웃', async () => {
    const f = fake(() => json(200, DOC));
    expect(await discoverOidc(URL_, ISS, { fetch: f.fetch })).toEqual({
      ok: true, doc: { issuer: ISS, authorizationEndpoint: DOC.authorization_endpoint, tokenEndpoint: DOC.token_endpoint, jwksUri: DOC.jwks_uri },
    });
    expect(f.calls[0]!.url).toBe(URL_);
    expect(f.calls[0]!.init.redirect).toBe('error');
    expect(f.calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('**손으로 준 값이 이긴다** — discovery 는 빈칸만 채운다', () => {
    const doc = { issuer: ISS, authorizationEndpoint: 'https://a.d', tokenEndpoint: 'https://t.d', jwksUri: 'https://j.d' };
    expect(withDiscovered({ authorizationEndpoint: 'https://a.manual', tokenEndpoint: '', jwksUri: '' }, doc))
      .toEqual({ authorizationEndpoint: 'https://a.manual', tokenEndpoint: 'https://t.d', jwksUri: 'https://j.d' });
    expect(withDiscovered({ authorizationEndpoint: '', tokenEndpoint: '', jwksUri: 'https://j.manual' }, undefined))
      .toEqual({ authorizationEndpoint: '', tokenEndpoint: '', jwksUri: 'https://j.manual' });
  });

  it('**issuer 가 다르면 거부** — 리다이렉트 · 프록시가 검증을 다른 곳으로 돌리지 못하게', async () => {
    const f = fake(() => json(200, { ...DOC, issuer: 'https://evil.test' }));
    expect(await discoverOidc(URL_, ISS, { fetch: f.fetch })).toMatchObject({ ok: false, reason: 'issuer-mismatch' });
    // 끝의 / 하나도 다른 issuer 다(OIDC 는 문자 그대로 비교한다)
    expect(await discoverOidc(URL_, ISS, { fetch: fake(() => json(200, { ...DOC, issuer: `${ISS}/` })).fetch })).toMatchObject({ ok: false, reason: 'issuer-mismatch' });
  });

  it('http 주소는 묻지 않는다 · 문서 안 주소가 https 가 아니면 invalid', async () => {
    const f = fake(() => json(200, DOC));
    expect(await discoverOidc('http://idp.test/.well-known/openid-configuration', ISS, { fetch: f.fetch })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(f.calls).toHaveLength(0);
    expect(await discoverOidc(URL_, ISS, { fetch: fake(() => json(200, { ...DOC, token_endpoint: 'http://idp.test/token' })).fetch }))
      .toMatchObject({ ok: false, reason: 'invalid' });
    expect(await discoverOidc(URL_, ISS, { fetch: fake(() => json(200, { ...DOC, jwks_uri: undefined })).fetch }))
      .toMatchObject({ ok: false, reason: 'invalid' });
    expect(await discoverOidc(URL_, ISS, { fetch: fake(() => new Response('<html>', { status: 200 })).fetch }))
      .toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('닿지 못함 · 200 아님 · 너무 큼은 unavailable — **던지지 않는다**', async () => {
    expect(await discoverOidc(URL_, ISS, { fetch: fake(() => { throw new TypeError('fetch failed'); }).fetch })).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(await discoverOidc(URL_, ISS, { fetch: fake(() => json(503, {})).fetch })).toMatchObject({ ok: false, reason: 'unavailable' });
    const big = new Response('x'.repeat(MAX_DISCOVERY_BYTES + 1), { status: 200 });
    expect(await discoverOidc(URL_, ISS, { fetch: fake(() => big).fetch })).toMatchObject({ ok: false, reason: 'unavailable' });
    const declared = new Response('{}', { status: 200, headers: { 'content-length': String(MAX_DISCOVERY_BYTES + 1) } });
    expect(await discoverOidc(URL_, ISS, { fetch: fake(() => declared).fetch })).toMatchObject({ ok: false, reason: 'unavailable' });
  });

  it('issuer → 표준 주소', () => {
    expect(discoveryUrlFor('https://idp.test/')).toBe(URL_);
    expect(discoveryUrlFor('https://idp.test/realms/x')).toBe('https://idp.test/realms/x/.well-known/openid-configuration');
  });
});
