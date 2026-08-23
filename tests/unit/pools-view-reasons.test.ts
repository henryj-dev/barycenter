/**
 * 풀 화면이 **왜 트래픽을 안 받는지** 보여준다 — 제안 #9 의 GUI 쪽 (2026-08-23).
 *
 * `GET /backends/status` 를 냈지만 화면이 안 읽고 있었다. 그러면 운영자는 CLI 로만
 * 그 답을 얻고, §12.1 이 *"GUI 는 맨 뒤로 미루지 않는다 — 제품 명제가 GUI 이므로"*
 * 라고 적어 둔 것이 다시 반쪽이 된다.
 *
 * ── 헬스 표시와 이유는 다른 것이다
 *
 * 화면에는 이미 `살아 있다`/`빠진다`/`아직 못 쟀다` 가 있다. 그런데 **헬스가 초록인데
 * 트래픽이 0 인 경우**가 정확히 이 API 가 답하려던 것이다(풀이 어디에도 안 걸림 ·
 * 드레인 중). 헬스 칸을 덮어쓰면 그 구분이 사라진다 — 따로 싣는다.
 *
 * ── 관측이 없으면 안 짓는다
 *
 * 상태 API 가 아직 안 왔거나 그 백엔드 줄이 없으면 **아무 말도 안 한다.** 빈 배열을
 * "이유 없음 = 받는 중" 으로 읽으면, 못 읽은 것이 초록으로 보인다.
 */
import { describe, expect, it } from 'vitest';

import { reasonLabels, trafficMarkOf } from '../../src/web/pools-view.js';

describe('백엔드가 왜 트래픽을 안 받나 (제안 #9 · GUI)', () => {
  it('이유를 사람 말로 바꾼다', () => {
    expect(reasonLabels(['unhealthy'])).toEqual(['프로버가 죽었다고 봤다']);
    expect(reasonLabels(['draining'])).toEqual(['드레인 중이다']);
    expect(reasonLabels(['pool_not_routed'])).toEqual(['이 풀을 가리키는 리스너·라우트가 없다']);
    expect(reasonLabels(['pool_missing'])).toEqual(['풀이 없다']);
  });

  it('여러 이유를 **전부** 싣는다 — 하나만 고치면 여전히 안 받는다', () => {
    const out = reasonLabels(['draining', 'pool_not_routed']);
    expect(out).toHaveLength(2);
  });

  it('모르는 이유는 코드 그대로 낸다 — 조용히 지우지 않는다', () => {
    // 서버가 새 이유를 더하면 화면이 그것을 감추면 안 된다. 못 읽는 것보다 낫다.
    expect(reasonLabels(['brand_new'])).toEqual(['brand_new']);
  });

  it('**관측이 없으면 아무 말도 안 한다**', () => {
    expect(trafficMarkOf(undefined)).toBeUndefined();
  });

  it('받는 중이면 표시를 안 낸다 — 매번 나오는 줄은 안 읽게 된다', () => {
    expect(trafficMarkOf({ receivingTraffic: true, reasons: [] })).toBeUndefined();
  });

  it('안 받으면 이유와 함께 낸다', () => {
    const m = trafficMarkOf({ receivingTraffic: false, reasons: ['pool_not_routed'] });
    expect(m?.reasons).toEqual(['이 풀을 가리키는 리스너·라우트가 없다']);
  });

  it('**헬스가 초록인데 안 받는 경우가 요점이다**', () => {
    /**
     * 이 API 가 답하려던 것이 정확히 이것이다. 헬스 칸만 보면 영영 못 찾는다 —
     * 그래서 헬스 표시를 덮어쓰지 않고 따로 싣는다.
     */
    const m = trafficMarkOf({ receivingTraffic: false, reasons: ['pool_not_routed'] });
    expect(m).toBeDefined();
    expect(m?.reasons).not.toContain('프로버가 죽었다고 봤다');
  });

  it('이유가 비어 있는데 안 받는다면 그대로 말한다', () => {
    // 서버가 이유를 못 냈다. 화면이 "받는 중" 으로 바꿔 읽으면 안 된다.
    const m = trafficMarkOf({ receivingTraffic: false, reasons: [] });
    expect(m).toBeDefined();
    expect(m?.reasons).toEqual([]);
  });
});
