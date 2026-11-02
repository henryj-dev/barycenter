/**
 * **읽기 요청은 잠깐 지나가는 실패를 다시 시도한다** (2026-11-02).
 *
 * 배포하면 `barycenterd` 가 1–2 초 다시 뜬다. 그 사이 화면의 읽기 요청이 502 · 503 · 504 를 받거나(앞단 nginx), 망 오류로
 * 던진다(직접 붙은 경우). 사람은 그것을 「화면이 고장 났다」 로 본다. 조금 기다렸다 다시 부르면 대개 성공한다.
 *
 * **GET · HEAD 만 한다.** 쓰기는 다시 보내면 두 번 일어날 수 있다 — 앞단이 502 를 냈어도 뒤가 받았는지 화면은 모른다.
 * 쓰기 실패는 그대로 보이고 사람이 다시 누른다. 우리가 끊은 요청(`AbortError`)도 다시 안 보낸다.
 */
import { isTransientStatus } from './reconnect.js';

export type RetryOptions = {
  /** 모두 몇 번 보내나. 기본 4 — 처음 한 번 + 다시 셋. */
  tries?: number;
  /** 시도 사이 대기. 기본 600ms — 넷이면 약 2 초를 덮는다(재기동 실측 1.5 초). */
  waitMs?: number;
  /** 시험이 시간을 안 쓰게 갈아 끼운다. */
  sleep?: (ms: number) => Promise<void>;
};

const methodOf = (input: string | URL | Request, init?: RequestInit): string =>
  (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();

export function retryingFetch(f: typeof fetch, opts: RetryOptions = {}): typeof fetch {
  const tries = Math.max(1, opts.tries ?? 4);
  const waitMs = opts.waitMs ?? 600;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const m = methodOf(input, init);
    if (m !== 'GET' && m !== 'HEAD') return f(input, init);
    for (let i = 1; ; i += 1) {
      try {
        const r = await f(input, init);
        if (i >= tries || !isTransientStatus(r.status)) return r;
      } catch (e) {
        if ((e as { name?: string }).name === 'AbortError' || init?.signal?.aborted === true || i >= tries) throw e;
      }
      await sleep(waitMs);
      if (init?.signal?.aborted === true) throw new DOMException('aborted', 'AbortError');
    }
  }) as typeof fetch;
}
