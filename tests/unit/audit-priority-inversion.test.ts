/**
 * 우선순위 역전 경고는 **겨루는 쌍에만** — 검수 2026-08-24 D13
 *
 * ── 무엇이 문제였나
 *
 * `analyze()` 의 첫 루프는 **모든 쌍**을 훑으며 매치 클래스 순위와 priority 만 비교했다.
 * 두 호스트가 같은 호스트를 매치할 수 있는지는 **안 봤다.** 그래서 `a.example.com`
 * (priority 1)과 `*.other.net`(priority 5)처럼 영영 겨루지 않는 쌍에도
 * *"먼저 매칭된다"* 가 붙었다.
 *
 * 같은 파일의 `planStrictPriority` 는 정확히 이 판정을 위해 `patternsConflict` 를 갖고
 * 있는데 `analyze` 는 그것을 안 썼다 — **자리가 둘이면 언젠가 갈린다** 의 한 판이다.
 *
 * ── 왜 이것이 결함인가
 *
 * 경고는 O(n²) 로 늘고 그대로 `plan.impact.routeOrderChanges.warnings` 에 실린다.
 * `config-store.ts` 가 `affectedListeners` 에 대해 적어 둔 말이 그대로 적용된다:
 *
 * > 이름이 `affectedListeners` 인데 영향과 무관하게 목록을 내면, 백엔드 하나를 옮긴
 * > plan 이 "리스너 열두 개가 영향받는다" 고 말한다. 그러면 사람이 그 줄을 안 읽게
 * > 되고, 정말로 열두 개가 걸리는 날에도 안 읽는다.
 *
 * 그래서 아래 단언의 절반은 **안 붙는다** 쪽이다.
 */
import { describe, expect, it } from 'vitest';

import { compileHostRoutes, type RouteInput } from '../../src/route/compile.js';

const inversions = (routes: RouteInput[]): string[][] =>
  compileHostRoutes(routes).warnings
    .filter((w) => w.kind === 'priority_inversion')
    .map((w) => [...w.routes].sort());

describe('우선순위 역전 — 겨루는 쌍에만', () => {
  it('**안 겨루면 경고가 없다** — 도메인이 다르면 순서를 다툴 일이 없다', () => {
    // exact `a.example.com`(1) 과 wildcard `*.other.net`(5).
    // 클래스로는 앞이 이기고 priority 로는 뒤가 높지만, **같은 호스트를 못 잡는다.**
    expect(inversions([
      { key: 'r-exact', host: 'a.example.com', priority: 1 },
      { key: 'r-wild', host: '*.other.net', priority: 5 },
    ])).toEqual([]);
  });

  it('겨루면 경고가 붙는다 — 와일드카드가 그 정확일치를 덮는다', () => {
    expect(inversions([
      { key: 'r-exact', host: 'a.example.com', priority: 1 },
      { key: 'r-wild', host: '*.example.com', priority: 5 },
    ])).toEqual([['r-exact', 'r-wild']]);
  });

  it('**한 라벨만 덮는다** — `*.example.com` 은 `deep.a.example.com` 과 안 겨룬다', () => {
    // 렌더가 앵커 정규식(`~^[^.]+\.suffix$`)으로 내므로 다중 라벨을 안 삼킨다.
    // `patternsConflict` 가 그 계약과 같은 판정을 한다 — 여기서 넓게 잡으면
    // 경고가 계약보다 넓어진다.
    expect(inversions([
      { key: 'r-deep', host: 'deep.a.example.com', priority: 1 },
      { key: 'r-wild', host: '*.example.com', priority: 5 },
    ])).toEqual([]);
  });

  it('겨루는 것만 고른다 — 무관한 것이 섞여 있어도 쌍이 하나다', () => {
    expect(inversions([
      { key: 'r-exact', host: 'a.example.com', priority: 1 },
      { key: 'r-wild', host: '*.example.com', priority: 5 },
      { key: 'r-far1', host: 'x.other.net', priority: 9 },
      { key: 'r-far2', host: '*.nowhere.test', priority: 9 },
    ])).toEqual([['r-exact', 'r-wild']]);
  });

  it('역전이 아니면 경고가 없다 — 클래스와 priority 가 같은 방향이다', () => {
    expect(inversions([
      { key: 'r-exact', host: 'a.example.com', priority: 5 },
      { key: 'r-wild', host: '*.example.com', priority: 1 },
    ])).toEqual([]);
  });
});
