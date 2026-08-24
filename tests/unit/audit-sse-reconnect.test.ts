/**
 * SSE 재연결 — 검수 2026-08-24 G1
 *
 * ── 지금은 재연결이 **아예 없다**
 *
 * `desk.svelte.ts` 의 `connect()` 는 스트림이 끝나거나 던지면 `live = false` 만 하고
 * 끝난다. 망이 잠깐 끊기거나 데몬이 재기동하면 **화면이 그 자리에서 멈추고 다시는
 * 안 살아난다.** 운영자는 그것이 「아무 일도 안 일어나는 중」인지 「연결이 죽은 것」인지
 * 알 수 없다 — 그리고 이 화면은 트래픽을 바꾸는 데 쓰인다.
 *
 * ── 정책은 `src/web/reconnect.ts` 에 있다
 *
 * `Last-Event-ID` 를 안 쓴다. 스트림이 열릴 때 **언제나 전체 스냅샷**을 주므로
 * 재연결 = 새 스냅샷 = 일관된 상태이고, 이건 **구성상 옳다.** 버퍼를 두면 새 상태가
 * 생기고, 버퍼는 반드시 유한하므로 **간격이 크면 스냅샷으로 돌아가야** 한다 — 즉 그
 * 길은 두 경로를 다 구현하는 것이다. 덜 구현하면서 절대 안 틀리는 쪽을 고른다.
 */
import { describe, expect, it } from 'vitest';

import { backoffMs } from '../../src/web/reconnect.js';

/** 지터를 끈다 — 곡선 자체를 볼 때. */
const NO_JITTER = { jitter: 0, random: () => 0.5 };

describe('재연결 백오프', () => {
  it('지수로 늘어난다 — 즉시 다시 붙어 재기동을 방해하지 않는다', () => {
    expect(backoffMs(0, NO_JITTER)).toBe(500);
    expect(backoffMs(1, NO_JITTER)).toBe(1_000);
    expect(backoffMs(2, NO_JITTER)).toBe(2_000);
    expect(backoffMs(3, NO_JITTER)).toBe(4_000);
  });

  /**
   * **상한이 있다.** 없으면 오래 끊긴 뒤 화면이 영영 안 돌아온다 — 그건 재연결이
   * 있는 것이 아니다.
   */
  it('상한에서 멈춘다', () => {
    expect(backoffMs(20, NO_JITTER)).toBe(30_000);
    expect(backoffMs(1_000, NO_JITTER)).toBe(30_000);
  });

  /** `2 ** attempt` 가 폭발해도 `Infinity`·`NaN` 이 안 나온다. */
  it('큰 `attempt` 에서도 유한하다 — `setTimeout` 이 즉시 재시도로 안 바뀐다', () => {
    for (const n of [50, 500, 5_000, Number.MAX_SAFE_INTEGER]) {
      const ms = backoffMs(n, NO_JITTER);
      expect(Number.isFinite(ms), `attempt=${n} → ${ms}`).toBe(true);
      expect(ms).toBeLessThanOrEqual(30_000);
      expect(ms).toBeGreaterThanOrEqual(0);
    }
  });

  /**
   * **지터를 양쪽으로 준다.** 화면이 여럿이면 전부 같은 순간에 다시 붙고, 그게
   * 재기동 직후의 데몬에 제일 나쁜 순간이다. 한쪽으로만 주면 평균이 밀린다.
   */
  it('지터가 양쪽으로 퍼진다', () => {
    const low = backoffMs(2, { jitter: 0.25, random: () => 0 });
    const mid = backoffMs(2, { jitter: 0.25, random: () => 0.5 });
    const high = backoffMs(2, { jitter: 0.25, random: () => 1 });
    expect(low).toBe(1_500);      // 2000 - 25%
    expect(mid).toBe(2_000);
    expect(high).toBe(2_500);     // 2000 + 25%
  });

  it('지터가 있어도 음수가 안 된다 — 즉시 재시도가 되면 안 된다', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(backoffMs(i % 12, { jitter: 1 })).toBeGreaterThanOrEqual(0);
    }
  });

  /** **되는 것을 못 쓰게 만들지 않는다.** 기본값이 사람이 기다릴 만해야 한다. */
  it('첫 재시도가 빠르다 — 잠깐 끊긴 것이 오래 안 보인다', () => {
    expect(backoffMs(0)).toBeLessThanOrEqual(700);
  });
});
