/**
 * OpenID Connect Discovery 1.0 — `/.well-known/openid-configuration` 으로 authorization · token · jwks 주소를 채운다.
 *
 * **손으로 준 값이 이긴다**(`withDiscovered`). discovery 는 빈칸만 채운다 — 배포가 일부러 다른 주소(내부 프록시 등)를 준 것을
 * 문서가 덮지 않게.
 *
 * **issuer 가 다르면 거부한다.** 문서의 issuer 는 우리가 물은 그 issuer 여야 한다 — 아니면 discovery 주소의 열린 리다이렉트나
 * 잘못 놓인 프록시 하나가 그 뒤의 모든 검증(서명 키 · 토큰 주소)을 조용히 다른 곳으로 돌린다(heliopause `Provider.load` 와 같다).
 *
 * 외부 호출은 https 만 · `redirect: 'error'` · 타임아웃 · 응답 크기 상한(세면서 읽기). **던지지 않는다** — 결과 객체다.
 * 기동에서 한 번 읽는다. 닿지 못하면 기동을 거부하지 않고 크게 경고한다(IdP 장애가 컨트롤 플레인 장애가 되지 않게 —
 * JWKS 의 첫 갱신과 같은 태도). issuer 불일치 · 모양 틀림은 설정 문제라 기동 거부다(`barycenterd.ts`).
 */
import { readBounded } from './read-bounded.js';

/** discovery 문서는 수 KB 다. 이만큼이면 넉넉하고, 더 오면 읽지 않는다. */
export const MAX_DISCOVERY_BYTES = 256 * 1024;
const TIMEOUT_MS = 8_000;

export type Discovered = { issuer: string; authorizationEndpoint: string; tokenEndpoint: string; jwksUri: string };

export type DiscoveryFailure =
  /** 닿지 못했다 · 200 이 아니다 · 읽지 못했다 · 너무 크다 — IdP(또는 길)의 문제. 기동은 계속한다. */
  | 'unavailable'
  /** 문서의 issuer 가 설정한 issuer 와 다르다 — 거부한다. */
  | 'issuer-mismatch'
  /** 문서가 JSON 이 아니거나 필요한 주소가 없거나 https 가 아니다 · 물을 주소가 https 가 아니다. */
  | 'invalid';

export type DiscoveryResult = { ok: true; doc: Discovered } | { ok: false; reason: DiscoveryFailure; detail: string };

/** issuer → 표준 discovery 주소. */
export function discoveryUrlFor(issuer: string): string {
  return `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
}

export async function discoverOidc(url: string, issuer: string, o: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<DiscoveryResult> {
  try {
    return await ask(url, issuer, o);
  } catch (e) {
    // `ask` 는 스스로 던지지 않게 썼다. 그래도 빠져나온 것은 닫는다.
    return { ok: false, reason: 'unavailable', detail: e instanceof Error ? e.message : String(e) };
  }
}

async function ask(url: string, issuer: string, o: { fetch?: typeof fetch; timeoutMs?: number }): Promise<DiscoveryResult> {
  if (!url.startsWith('https://')) return { ok: false, reason: 'invalid', detail: `discovery 주소는 https 여야 한다 (${url})` };
  let res: Response;
  try {
    res = await (o.fetch ?? fetch)(url, {
      headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(o.timeoutMs ?? TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, reason: 'unavailable', detail: `IdP 에 닿지 못했다: ${e instanceof Error ? e.message : String(e)}` };
  }
  let text: string;
  try {
    text = await readBounded(res, MAX_DISCOVERY_BYTES);
  } catch (e) {
    return { ok: false, reason: 'unavailable', detail: `discovery 문서를 읽지 못했다: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (res.status !== 200) return { ok: false, reason: 'unavailable', detail: `discovery 가 ${res.status} 로 답했다` };
  let d: Record<string, unknown>;
  try {
    const v = JSON.parse(text) as unknown;
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('객체가 아니다');
    d = v as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'invalid', detail: 'discovery 문서가 JSON 객체가 아니다' };
  }
  if (d['issuer'] !== issuer) {
    return { ok: false, reason: 'issuer-mismatch', detail: `discovery 의 issuer(${String(d['issuer'])})가 설정한 issuer(${issuer})와 다르다` };
  }
  const out: Partial<Discovered> = { issuer };
  for (const [k, field] of [['authorization_endpoint', 'authorizationEndpoint'], ['token_endpoint', 'tokenEndpoint'], ['jwks_uri', 'jwksUri']] as const) {
    const v = d[k];
    if (typeof v !== 'string' || !v.startsWith('https://')) return { ok: false, reason: 'invalid', detail: `discovery 문서의 ${k} 가 없거나 https 가 아니다` };
    out[field] = v;
  }
  return { ok: true, doc: out as Discovered };
}

/** 손으로 준 값(빈 문자열 = 안 줌)이 이긴다. discovery 는 빈칸만 채운다. */
export function withDiscovered(
  manual: { authorizationEndpoint: string; tokenEndpoint: string; jwksUri: string }, doc: Discovered | undefined,
): { authorizationEndpoint: string; tokenEndpoint: string; jwksUri: string } {
  return {
    authorizationEndpoint: manual.authorizationEndpoint !== '' ? manual.authorizationEndpoint : doc?.authorizationEndpoint ?? '',
    tokenEndpoint: manual.tokenEndpoint !== '' ? manual.tokenEndpoint : doc?.tokenEndpoint ?? '',
    jwksUri: manual.jwksUri !== '' ? manual.jwksUri : doc?.jwksUri ?? '',
  };
}
