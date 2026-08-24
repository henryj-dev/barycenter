/**
 * 멤버십 평면에서도 가중치가 걸린다 — 검수 2026-08-24 D2
 *
 * ── 필드는 있는데 아무도 안 읽었다
 *
 * 정적 `server` 줄 경로는 가중치를 낸다:
 *
 *   if (b.weight !== 1) args.push(lit(`weight=${b.weight}`))
 *
 * 그런데 Lua 가 있는 엔진(= **이 제품의 기본 배포**)에서는 upstream 이
 * `balancer_by_lua_block` 이 되고 슬롯은 `slotsOf` 가 만든 `host:port` 목록이다.
 * `src/control/membership.ts` 에는 `weight` 라는 낱말이 **한 번도 안 나왔다.**
 *
 * 즉 **같은 모델이 엔진에 따라 다르게 밸런싱됐다.** 사용자는 저장에 성공하고 GUI 와
 * CLI 는 값을 되돌려 주고 plan 도 아무 말을 안 한다. `render.ts` 가 `source_ip_hash`
 * 에서 정확히 같은 함정을 이미 한 번 잡았다 — *"필드는 있는데 아무도 안 지키는
 * 상태였다. 이 저장소가 반복해서 잡아 온 바로 그 부류다."*
 *
 * ── 결정은 DESIGN §7.3.1 에 있다
 *
 * 슬롯 목록을 가중치만큼 **반복**한다. 와이어가 안 바뀌는 것이 그 안을 고른 이유다 —
 * peer 문자열은 슬롯에만 사는 것이 아니라 `in:<peer>` 카운터와
 * `/membership/inflight` 의 질의 키이기도 하다.
 *
 * ── 이 파일이 재는 것
 *
 * `slotsOf` 의 산출물이다. **실물 nginx 가 아니다** — 고르는 규칙이 그 목록의 함수라
 * (골든 `least-conn` 이 그 규칙을 이미 실물로 잰다) 여기서는 **목록이 맞는가**만
 * 보면 된다. 그리고 목록은 순수 함수라 실물로 재면 느려지기만 한다.
 */
import { describe, expect, it } from 'vitest';

import { slotsOf } from '../../src/control/membership.js';
import type { Model } from '../../src/model/provisional.js';

/** 멤버십 평면이 켜진 엔진 — 이 경로가 Lua 밸런서다. */
const ON = { httpLua: true, streamLua: true, streamRealip: false, sslConfCommand: true };

const model = (weights: readonly number[]): Model => ({
  listeners: [{
    key: 'web', protocol: 'http', bind: '0.0.0.0', port: 8080, enabled: true,
    http: { defaultAction: { pool: 'app' } },
  }],
  httpRoutes: [], passthroughRoutes: [],
  pools: [{ key: 'app', protocolClass: 'http', algorithm: 'round_robin' } as Model['pools'][number]],
  backends: weights.map((weight, i) => ({
    key: `b${i}`, pool: 'app', host: '10.0.0.' + String(i + 1), port: 80, weight,
  })),
  certificates: [], tlsPolicies: [], sniBindings: [],
});

/** 그 풀의 슬롯 목록. upstream 이름은 렌더가 정한다. */
const slots = (weights: readonly number[]): string[] => {
  const out = slotsOf(model(weights), ON).http;
  const names = Object.keys(out);
  expect(names, `풀이 하나여야 한다: ${JSON.stringify(names)}`).toHaveLength(1);
  return out[names[0]!]!;
};

/** peer 별 칸 수. */
const counts = (list: readonly string[]): Record<string, number> => {
  const m: Record<string, number> = {};
  for (const p of list) m[p] = (m[p] ?? 0) + 1;
  return m;
};

/** 같은 peer 가 연속으로 몇 번까지 나오는가. **버스트를 잰다.** */
const maxRun = (list: readonly string[]): number => {
  let best = 0;
  let run = 0;
  let prev = '';
  for (const p of list) {
    run = p === prev ? run + 1 : 1;
    prev = p;
    if (run > best) best = run;
  }
  return best;
};

describe('가중치가 슬롯에 걸린다', () => {
  it('가중치가 슬롯 칸 수로 나온다', () => {
    expect(counts(slots([1, 3]))).toEqual({ '10.0.0.1:80': 1, '10.0.0.2:80': 3 });
  });

  /**
   * **최대공약수로 나눈다.** `2:4` 와 `1:2` 는 같은 뜻이고, 안 나누면 dict 를 두 배로
   * 먹는다 — 그 자원이 D4 의 절벽과 같은 자원이다.
   */
  it('최대공약수로 줄인다 — 같은 비율이면 같은 칸 수다', () => {
    expect(slots([2, 4])).toEqual(slots([1, 2]));
    expect(counts(slots([10, 20, 30]))).toEqual({
      '10.0.0.1:80': 1, '10.0.0.2:80': 2, '10.0.0.3:80': 3,
    });
  });

  /**
   * **가중치가 전부 1 이면 지금과 글자 그대로 같다.**
   *
   * 안 쓰는 배포의 거동이 안 바뀐다는 뜻이고, 그게 이 수정이 안전한 이유다.
   */
  it('전부 1 이면 정렬된 목록 그대로다 — 안 쓰는 배포가 안 바뀐다', () => {
    expect(slots([1, 1, 1])).toEqual(['10.0.0.1:80', '10.0.0.2:80', '10.0.0.3:80']);
  });

  /**
   * **상한이 있다.** 해독기가 `weight` 를 1..1,000,000 으로 받는다 — 그 범위를
   * 안 좁히는 이유는 `modelAt` 이 옛 리비전을 같은 해독기로 읽기 때문이다(D7).
   * 그러니 막을 자리는 여기다.
   */
  it('큰 가중치가 dict 를 못 먹는다 — 확장에 상한이 있다', () => {
    const list = slots([1, 1_000_000]);
    expect(list.length, `칸 ${list.length} 개`).toBeLessThanOrEqual(256);
    // **그래도 비율은 산다** — 무거운 쪽이 압도적으로 많다.
    const c = counts(list);
    expect(c['10.0.0.2:80']!).toBeGreaterThan(c['10.0.0.1:80']!);
  });

  /**
   * **줄이다가 백엔드를 빼면 안 된다.** 그건 밸런싱이 아니라 장애다.
   */
  it('줄여도 모든 백엔드가 최소 한 칸을 갖는다', () => {
    const c = counts(slots([1, 1_000_000]));
    expect(c['10.0.0.1:80'], '가벼운 쪽이 사라졌다').toBeGreaterThanOrEqual(1);
  });

  /**
   * **사본을 고르게 섞는다.** 뭉쳐 두면 `round_robin` 이
   * `idx = (c % n) + 1` 로 순차 순회하므로 무거운 peer 에게 **연속으로** 몰아준다.
   * 비율은 맞고 버스트가 생긴다.
   */
  it('사본이 뭉쳐 있지 않다 — 무거운 peer 가 연속으로 안 받는다', () => {
    const list = slots([1, 4]);
    expect(list).toHaveLength(5);
    // 뭉쳐 있으면 4 연속이 나온다.
    expect(maxRun(list), `목록 ${JSON.stringify(list)}`).toBeLessThanOrEqual(2);
  });

  /** **결정적이어야 한다.** 슬롯은 `payloadDigest` 로 들어간다. */
  it('같은 모델이면 같은 목록이다 — digest 가 흔들리면 안 된다', () => {
    expect(slots([3, 1, 2])).toEqual(slots([3, 1, 2]));
  });
});
