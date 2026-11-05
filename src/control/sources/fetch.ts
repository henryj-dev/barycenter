/**
 * 데이터 출처(백엔드 디스커버리 · 주소 집합)가 함께 쓰는 **바깥 읽기** (2026-11-05).
 *
 * 지키는 것 (어댑터 공통 규칙):
 *   · https 만 — 받은 것이 곧 「어디로 보낼까」 · 「누구를 믿을까」 다. 평문이면 길 위의 누구나 바꾼다
 *   · `redirect: 'error'` — 출처가 다른 곳으로 보내면 따라가지 않는다
 *   · 타임아웃 · 응답 크기 상한(세면서 읽는다 — `Content-Length` 는 주장일 뿐이다)
 *   · **던지지 않는다.** 실패는 결과 객체와 사유다 — 호출자는 「실패면 마지막 값을 지킨다」 만 하면 된다
 *
 * 실패의 뜻은 두 출처 계열이 같이 쓴다(`SourceFailure`).
 */
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';

/** 출처 실패의 뜻. 운영자가 원인을 가를 수 있게 나눈다. */
export type SourceFailure =
  /** 이 데몬에 그 출처가 설정되지 않았다(주소 · 토큰이 없다). */
  | 'unconfigured'
  /** 평문 주소다 — 보내지 않았다. */
  | 'insecure'
  /** 닿지 못했다 · 타임아웃 · 5xx · 그 밖의 상태. */
  | 'unavailable'
  /** 출처가 **우리** 자격(토큰)을 거절했다(401 · 403) — 배포 문제다. */
  | 'unauthorized'
  /** 묻는 이름이 출처에 없다(404 · NXDOMAIN · 파일 없음). */
  | 'not-found'
  /** 답이 상한을 넘는다. */
  | 'too-large'
  /** 답을 해석하지 못했거나 들어 있는 값이 주소가 아니다. */
  | 'invalid';

export type SourceError = { ok: false; reason: SourceFailure; detail: string };

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type GetOptions = {
  fetch?: FetchLike;
  headers?: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
};

/** https GET 하나 → 본문 글자. 200 만 성공이다. */
export async function httpsGetText(url: string, o: GetOptions): Promise<{ ok: true; text: string } | SourceError> {
  try {
    return await getText(url, o);
  } catch (e) {
    // 아래는 스스로 던지지 않게 썼다. 그래도 빠져나온 것은 닫는다.
    return { ok: false, reason: 'unavailable', detail: message(e) };
  }
}

async function getText(url: string, o: GetOptions): Promise<{ ok: true; text: string } | SourceError> {
  if (!url.startsWith('https://')) {
    return { ok: false, reason: 'insecure', detail: `https 가 아닌 주소에는 묻지 않는다 (${redact(url)})` };
  }
  let res: Response;
  try {
    res = await (o.fetch ?? fetch)(url, {
      method: 'GET',
      headers: { accept: 'application/json, text/plain;q=0.9', ...(o.headers ?? {}) },
      redirect: 'error',
      signal: AbortSignal.timeout(o.timeoutMs),
    });
  } catch (e) {
    return { ok: false, reason: 'unavailable', detail: `${redact(url)} 에 닿지 못했다: ${message(e)}` };
  }
  if (res.status !== 200) {
    void res.body?.cancel().catch(() => undefined);
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: 'unauthorized', detail: `${redact(url)} 가 ${res.status} 로 답했다 — 토큰 · 권한을 본다` };
    }
    if (res.status === 404) return { ok: false, reason: 'not-found', detail: `${redact(url)} 가 404 로 답했다` };
    return { ok: false, reason: 'unavailable', detail: `${redact(url)} 가 ${res.status} 로 답했다` };
  }
  try {
    return { ok: true, text: await readBounded(res, o.maxBytes) };
  } catch (e) {
    if (e instanceof TooLarge) return { ok: false, reason: 'too-large', detail: `${redact(url)} 의 답이 ${o.maxBytes}바이트를 넘는다` };
    return { ok: false, reason: 'unavailable', detail: `${redact(url)} 의 답을 읽지 못했다: ${message(e)}` };
  }
}

/** JSON 하나. 해석 실패는 `invalid`. */
export async function httpsGetJson(url: string, o: GetOptions): Promise<{ ok: true; json: unknown } | SourceError> {
  const r = await httpsGetText(url, o);
  if (!r.ok) return r;
  try {
    return { ok: true, json: JSON.parse(r.text) as unknown };
  } catch (e) {
    return { ok: false, reason: 'invalid', detail: `${redact(url)} 의 답이 JSON 이 아니다: ${message(e)}` };
  }
}

class TooLarge extends Error {}

/** 세면서 읽는다 — 선언이 넘으면 일찍 멈추고, 실제로도 넘는 순간 끊는다. */
async function readBounded(res: Response, limit: number): Promise<string> {
  const declared = res.headers.get('content-length');
  if (declared !== null && Number(declared) > limit) {
    void res.body?.cancel().catch(() => undefined);
    throw new TooLarge();
  }
  if (res.body === null) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      void reader.cancel().catch(() => undefined);
      throw new TooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * **신뢰 번들을 정한 fetch** — Kubernetes API 처럼 사설 CA 로 서명된 출처에 쓴다.
 *
 * 전역 `fetch` 는 CA 를 받지 않고, 받게 하려면 undici 를 의존성으로 들여야 한다. `node:https` 는 `ca` 를 받는다.
 * 그 위에 `FetchLike` 모양만 씌운다 — 위의 공통 규칙(상태 · 상한 · 타임아웃)은 `httpsGetText` 가 그대로 진다.
 * `node:https` 는 리다이렉트를 따라가지 않는다(3xx 는 그냥 상태다 — `unavailable`).
 */
export function fetchWithCa(ca: string): FetchLike {
  return (url, init) => new Promise<Response>((resolve, reject) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
    const req = httpsRequest(url, { method: init.method ?? 'GET', headers, ca }, (res) => {
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(', ') : v);
      }
      resolve(new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, { status: res.statusCode ?? 0, headers: h }));
    });
    const signal = init.signal;
    if (signal !== null && signal !== undefined) {
      if (signal.aborted) { req.destroy(new Error('시간이 지났다')); }
      signal.addEventListener('abort', () => req.destroy(new Error('시간이 지났다')), { once: true });
    }
    req.on('error', reject);
    req.end();
  });
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 로그 · 화면에 낼 주소 — 쿼리는 지운다(토큰을 쿼리로 받는 출처가 있다). */
export function redact(url: string): string {
  const q = url.indexOf('?');
  return q < 0 ? url : `${url.slice(0, q)}?…`;
}
