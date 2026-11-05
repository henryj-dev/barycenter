/**
 * 바깥으로 나가는 HTTP 호출 한 번 — DNS-01 공급자 · 메일 전송 · 알림이 같은 규칙을 쓴다.
 *
 * 규칙:
 *   - https 만. 평문 주소면 보내지 않는다(자격증명이 실린 요청이다).
 *   - `redirect: 'error'` — 상대가 다른 곳으로 돌려도 따라가지 않는다(자격증명 헤더가 따라간다).
 *   - 타임아웃. 상대가 답하지 않으면 그 호출만 실패한다.
 *   - 응답 크기 상한. 세면서 읽는다 — 메모리를 상대가 정하지 않게.
 *
 * **던지지 않는다.** 실패는 결과 객체다. 상태코드의 뜻은 호출자(어댑터)가 정한다.
 */

export type HttpFailure =
  /** https 가 아닌 주소. 보내지 않았다. */
  | 'insecure'
  /** 닿지 못했다(연결 · DNS · TLS · 타임아웃 · 리다이렉트). */
  | 'unreachable'
  /** 응답이 상한을 넘었다. */
  | 'too-large';

export type HttpReply = { ok: true; status: number; headers: Headers; text: string };
export type HttpResult = HttpReply | { ok: false; reason: HttpFailure; detail: string };

export type HttpRequest = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** 응답 본문 상한(바이트). 기본 256 KiB. */
  maxBytes?: number;
};

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BYTES = 256 * 1024;

/** https 주소인가. 아니면 사람이 읽을 사유를 돌려준다. */
export function insecureReason(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return '주소가 URL 이 아니다';
  }
  if (u.protocol !== 'https:') return `https 가 아닌 주소로는 보내지 않는다 (${u.protocol}//${u.host})`;
  return undefined;
}

export async function httpRequest(r: HttpRequest): Promise<HttpResult> {
  const bad = insecureReason(r.url);
  if (bad !== undefined) return { ok: false, reason: 'insecure', detail: bad };
  let res: Response;
  try {
    res = await (r.fetch ?? fetch)(r.url, {
      method: r.method,
      ...(r.headers === undefined ? {} : { headers: r.headers }),
      ...(r.body === undefined ? {} : { body: r.body }),
      redirect: 'error',
      signal: AbortSignal.timeout(r.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, reason: 'unreachable', detail: `닿지 못했다: ${message(e)}` };
  }
  try {
    const text = await readBounded(res, r.maxBytes ?? DEFAULT_MAX_BYTES);
    return { ok: true, status: res.status, headers: res.headers, text };
  } catch (e) {
    if (e instanceof TooLarge) return { ok: false, reason: 'too-large', detail: e.message };
    return { ok: false, reason: 'unreachable', detail: `답을 읽지 못했다: ${message(e)}` };
  }
}

class TooLarge extends Error {}

/**
 * 세면서 읽는다 — `Content-Length` 는 주장일 뿐이라 선언이 넘으면 일찍 멈추고, 실제로도 넘는 순간 끊는다.
 * 넘으면 던진다(`httpRequest` 가 `too-large` 로 바꾼다).
 */
export async function readBounded(res: Response, limit: number): Promise<string> {
  const declared = res.headers.get('content-length');
  if (declared !== null && Number(declared) > limit) {
    void res.body?.cancel().catch(() => undefined);
    throw new TooLarge(`답이 ${limit}바이트를 넘는다`);
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
      throw new TooLarge(`답이 ${limit}바이트를 넘는다`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** JSON 이면 해석하고, 아니면 undefined. */
export function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** 사유에 실을 상대의 말 — 짧게 자른다(로그가 상대의 본문으로 차지 않게). */
export function excerpt(text: string, max = 200): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
