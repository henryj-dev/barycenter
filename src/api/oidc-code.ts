/**
 * OpenID Connect Core — Authorization Code RP.
 *
 * 인증 요청과 Token Endpoint 교환만 연다. 돌려받은 `id_token` 은 있는
 * `principalFromIdToken` 을 지난다. Discovery · UserInfo · refresh 는 여기 없다.
 *
 * ── PKCE 와 nonce 는 여기 있다 (검수 S-06 나머지)
 *
 * 전에는 `response_type=code` 와 `state` 만 실었다. 그래서 리다이렉트로 돌아오는
 * `code` 를 가로챈 자가 그대로 Token Endpoint 에 낼 수 있었다 — 브라우저 히스토리 ·
 * Referer · 로그 · 악성 확장, 경로가 여럿이다. 이 RP 는 브라우저에서 도는 SPA 라
 * `client_secret` 이 없는 배포가 정상이고, 그때 `code` 는 그 자체로 자격증명이다.
 *
 * **검증자는 API 세션이 들고 있는다.** 정적 GUI가 PKCE verifier·nonce를 브라우저 저장소에
 * 보관하지 않도록, API가 짧은 수명의 opaque 로그인 쿠키에 묶어 메모리에 보관한다. 이
 * 모듈은 순수한 요청·교환 규칙만 제공하고 저장 경계는 `browser-session.ts`가 진다.
 *
 * nonce 가 이 구조에서 무엇을 사는지는 분명히 해 둔다: 훔친 `id_token` 주입을 막는
 * 것이지 장악된 브라우저를 막는 것이 아니다. 가로챈 `code` 를 막는 것은 PKCE 쪽이다.
 */
import { createHash, randomBytes } from 'node:crypto';

import { principalFromIdToken, type OidcSettings, type Principal } from './auth.js';

const b64url = (b: Buffer): string =>
  b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * PKCE 검증자 (RFC 7636 §4.1). 43–128 자의 unreserved 문자.
 *
 * 32 바이트를 base64url 로 적으면 43 자다 — 하한에 딱 맞고 엔트로피는 256 비트다.
 */
export function pkceVerifier(): string {
  return b64url(randomBytes(32));
}

/**
 * `S256` 챌린지 (RFC 7636 §4.2).
 *
 * `plain` 은 RFC 가 남겨 뒀지만 가로챈 자가 챌린지를 그대로 검증자로 쓸 수 있어
 * 아무것도 안 막는다. **고를 수 있게 두지 않는다** — 고를 수 있는 약한 선택지는
 * 언젠가 골라진다.
 */
export function pkceChallenge(verifier: string): string {
  return b64url(createHash('sha256').update(verifier).digest());
}

export type OidcRpSettings = OidcSettings & {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  redirectUri: string;
  clientSecret?: string;
};

export type AuthorizationRequest = {
  state: string;
  scope?: string;
  /** `pkceChallenge(verifier)` 의 결과. 방식은 항상 `S256` 이다. */
  codeChallenge?: string;
  nonce?: string;
};

/** Authentication Request. `response_type=code`, `scope` 에 `openid`. */
export function authorizationRequest(rp: OidcRpSettings, req: AuthorizationRequest): URL {
  const url = new URL(rp.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', rp.clientId);
  url.searchParams.set('redirect_uri', rp.redirectUri);
  url.searchParams.set('scope', req.scope ?? 'openid');
  url.searchParams.set('state', req.state);
  // **없는 값을 빈 문자열로 보내지 않는다.** 빈 `nonce=` 를 IdP 가 "nonce 를 요구했다"
  // 로 읽으면 되돌아오는 토큰의 검증이 꼬인다.
  if (req.codeChallenge !== undefined) {
    url.searchParams.set('code_challenge', req.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  if (req.nonce !== undefined) url.searchParams.set('nonce', req.nonce);
  return url;
}

/** Token Request 본문. `grant_type=authorization_code`. */
export function tokenRequestBody(
  rp: OidcRpSettings, code: string, codeVerifier?: string,
): string {
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', code);
  body.set('redirect_uri', rp.redirectUri);
  body.set('client_id', rp.clientId);
  if (rp.clientSecret !== undefined) body.set('client_secret', rp.clientSecret);
  if (codeVerifier !== undefined) body.set('code_verifier', codeVerifier);
  return body.toString();
}

export type CodeExchange = {
  principal: Principal;
  id_token: string;
};

export type CodeExchangeOptions = {
  /** 시작 때 만든 검증자. API의 로그인 세션이 보관했다가 교환에 사용한다. */
  codeVerifier?: string;
  /** 시작 때 보낸 nonce. 주면 `id_token` 이 그것을 담고 있어야 한다. */
  nonce?: string;
};

/**
 * Token Endpoint 에 code 를 넘기고, 돌아온 `id_token` 을 기존 검증에 넣는다.
 * 없거나 거절되면 없음.
 */
export async function exchangeAuthorizationCode(
  rp: OidcRpSettings,
  code: string,
  fetchImpl: typeof fetch,
  opts: CodeExchangeOptions = {},
): Promise<CodeExchange | undefined> {
  const res = await fetchImpl(rp.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: tokenRequestBody(rp, code, opts.codeVerifier),
  });
  if (!res.ok) return undefined;
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return undefined;
  }
  if (payload === null || typeof payload !== 'object') return undefined;
  const idToken = (payload as Record<string, unknown>)['id_token'];
  if (typeof idToken !== 'string' || idToken === '') return undefined;
  // nonce 는 **검증기 안에서** 본다. 여기서 페이로드를 한 번 더 까면 서명 검증을 지나지
  // 않은 값을 읽는 자리가 하나 생기고, 그 자리는 언젠가 다른 판단에도 쓰인다.
  const principal = principalFromIdToken(
    idToken, opts.nonce === undefined ? rp : { ...rp, nonce: opts.nonce },
  );
  if (principal === undefined) return undefined;
  return { principal, id_token: idToken };
}
