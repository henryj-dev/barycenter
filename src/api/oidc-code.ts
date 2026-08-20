/**
 * OpenID Connect Core — Authorization Code RP.
 *
 * 인증 요청과 Token Endpoint 교환만 연다. 돌려받은 `id_token` 은 있는
 * `principalFromIdToken` 을 지난다. Discovery · UserInfo · PKCE 제품 ·
 * refresh 는 여기 없다.
 */
import { principalFromIdToken, type OidcSettings, type Principal } from './auth.js';

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
};

/** Authentication Request. `response_type=code`, `scope` 에 `openid`. */
export function authorizationRequest(rp: OidcRpSettings, req: AuthorizationRequest): URL {
  const url = new URL(rp.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', rp.clientId);
  url.searchParams.set('redirect_uri', rp.redirectUri);
  url.searchParams.set('scope', req.scope ?? 'openid');
  url.searchParams.set('state', req.state);
  return url;
}

/** Token Request 본문. `grant_type=authorization_code`. */
export function tokenRequestBody(rp: OidcRpSettings, code: string): string {
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', code);
  body.set('redirect_uri', rp.redirectUri);
  body.set('client_id', rp.clientId);
  if (rp.clientSecret !== undefined) body.set('client_secret', rp.clientSecret);
  return body.toString();
}

export type CodeExchange = {
  principal: Principal;
  id_token: string;
};

/**
 * Token Endpoint 에 code 를 넘기고, 돌아온 `id_token` 을 기존 검증에 넣는다.
 * 없거나 거절되면 없음.
 */
export async function exchangeAuthorizationCode(
  rp: OidcRpSettings,
  code: string,
  fetchImpl: typeof fetch,
): Promise<CodeExchange | undefined> {
  const res = await fetchImpl(rp.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: tokenRequestBody(rp, code),
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
  const principal = principalFromIdToken(idToken, rp);
  if (principal === undefined) return undefined;
  return { principal, id_token: idToken };
}
