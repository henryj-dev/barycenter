/**
 * **읽기 요청은 잠깐 지나가는 실패를 다시 시도한다** (2026-11-02). 배포하면 데몬이 1–2 초 다시 뜨고, 화면의 읽기가 502 를 받았다.
 */
import { describe, expect, it } from 'vitest';

import { retryingFetch } from '../../src/web/retry.js';
import { RECONNECT_GRACE_MS, isTransientStatus } from '../../src/web/reconnect.js';

/** 차례대로 이 응답(또는 던짐)을 내는 가짜 fetch. 부른 횟수를 센다. */
function fake(seq: (number | 'throw')[]): { f: typeof fetch; calls: () => number } {
  let n = 0;
  const f = (async () => {
    const x = seq[Math.min(n, seq.length - 1)]!;
    n += 1;
    if (x === 'throw') throw new TypeError('fetch failed');
    return new Response(null, { status: x });
  }) as unknown as typeof fetch;
  return { f, calls: () => n };
}
const noSleep = { sleep: async () => {} };

describe('retryingFetch', () => {
  it('**GET 이 502 · 망 오류를 받으면 다시 부르고, 성공하면 그 응답을 낸다**', async () => {
    const a = fake([502, 'throw', 200]);
    const r = await retryingFetch(a.f, noSleep)('/api/v1/status');
    expect(r.status).toBe(200);
    expect(a.calls()).toBe(3);
  });

  it('횟수를 넘기면 마지막 실패를 그대로 낸다', async () => {
    const a = fake([503]);
    expect((await retryingFetch(a.f, { ...noSleep, tries: 3 })('/x')).status).toBe(503);
    expect(a.calls()).toBe(3);
    const b = fake(['throw']);
    await expect(retryingFetch(b.f, { ...noSleep, tries: 2 })('/x')).rejects.toThrow(/fetch failed/);
  });

  it('**쓰기는 다시 보내지 않는다** — 두 번 일어날 수 있다', async () => {
    const a = fake([502, 200]);
    const r = await retryingFetch(a.f, noSleep)('/api/v1/apply', { method: 'POST' });
    expect(r.status).toBe(502);
    expect(a.calls()).toBe(1);
  });

  it('잠깐 지나가는 실패가 아니면(404 · 401 · 500) 바로 낸다', async () => {
    for (const s of [404, 401, 500]) {
      const a = fake([s, 200]);
      expect((await retryingFetch(a.f, noSleep)('/x')).status).toBe(s);
      expect(a.calls()).toBe(1);
    }
  });

  it('우리가 끊은 요청은 다시 안 보낸다', async () => {
    const ac = new AbortController();
    ac.abort();
    const f = (async () => { throw new DOMException('aborted', 'AbortError'); }) as unknown as typeof fetch;
    await expect(retryingFetch(f, noSleep)('/x', { signal: ac.signal })).rejects.toThrow(/aborted/);
  });
});

describe('재연결 유예', () => {
  it('502 · 503 · 504 만 잠깐 지나가는 실패다 · 유예는 재기동(실측 1.5 초)보다 길다', () => {
    expect([502, 503, 504].every(isTransientStatus)).toBe(true);
    expect([401, 404, 500].some(isTransientStatus)).toBe(false);
    expect(RECONNECT_GRACE_MS).toBeGreaterThanOrEqual(3000);
  });
});
