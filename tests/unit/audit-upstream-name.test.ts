/**
 * upstream 이름은 **한 자리에서 정한다** — 검수 2026-08-24 D18
 *
 * ── 취지는 옳았고 방법이 틀렸다
 *
 * `upstreamNameIn` 의 주석이 이렇게 적어 뒀다:
 *
 * > 렌더러의 `upstreamName` 을 여기서 다시 구현하고 싶어지는데, 그러면 **이름을 정하는
 * > 자리가 둘**이 되고 단사성 보정(다이제스트 접미)이 붙는 순간 갈린다.
 * > 산출물에서 읽는 편이 한 자리를 유지한다.
 *
 * 그런데 읽는 방법이 `pool_<ident>(_<hex>)?` 정규식의 **첫 매치**였다. `ident` 는
 * 비영숫자를 `_` 로 바꾼 값이라 `a-b` 와 `a_b` 가 **같은 `ident`** 를 만든다.
 * 렌더러는 그 비단사성을 다이제스트 접미로 푸는데, 이 정규식은 접미를 **선택**으로
 * 두므로 둘을 서로의 upstream 에 매치시킬 수 있다.
 *
 * ── 무엇이 깨지나
 *
 * 멤버십이 **엉뚱한 슬롯**에 실리고, 제 슬롯이 빈 풀은 `balancer_by_lua` 가
 * `ngx.exit(ngx.ERROR)` 를 타 **그 풀의 모든 요청이 끊긴다**(§6.5-3). 그리고 슬롯은
 * 이름으로만 갈리므로 **어느 쪽이 어느 쪽을 먹었는지 밖에서 안 보인다.**
 *
 * 규칙을 두 번 구현하지 않는 방법은 산출물을 파싱하는 것이 아니라 **같은 함수를
 * 쓰는 것**이다.
 */
import { describe, expect, it } from 'vitest';

import { render, upstreamName } from '../../src/conf/render.js';
import { routedPools, slotsOf, upstreamNameIn } from '../../src/control/membership.js';
import type { Model } from '../../src/model/provisional.js';

/** Lua 가 있는 엔진 — 멤버십 평면이 켜진다. */
const CAPS = { streamRealip: false, httpLua: true, streamLua: true } as const;

/**
 * `ident` 가 겹치는 두 풀. `a-b` 와 `a_b` 는 둘 다 `pool_a_b` 로 접힌다 —
 * 렌더러는 손실이 있는 쪽에만 다이제스트를 붙여 단사로 만든다.
 */
const model: Model = {
  listeners: [
    { key: 'l1', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true,
      http: { defaultAction: { pool: 'a-b' } } },
    { key: 'l2', protocol: 'http', bind: '0.0.0.0', port: 81, enabled: true,
      http: { defaultAction: { pool: 'a_b' } } },
  ],
  httpRoutes: [],
  passthroughRoutes: [],
  pools: [
    { key: 'a-b', protocolClass: 'http', algorithm: 'round_robin' },
    { key: 'a_b', protocolClass: 'http', algorithm: 'round_robin' },
  ],
  backends: [
    { key: 'b1', pool: 'a-b', host: '10.0.0.1', port: 80, weight: 1 },
    { key: 'b2', pool: 'a_b', host: '10.0.0.2', port: 80, weight: 1 },
  ],
  certificates: [],
  tlsPolicies: [],
  sniBindings: [],
};

describe('이름이 겹치는 두 풀', () => {
  it('렌더러는 둘을 **다른 이름**으로 낸다 — 단사성 보정이 그 일을 한다', () => {
    expect(upstreamName('a-b')).not.toBe(upstreamName('a_b'));
    const conf = render(model, CAPS).conf;
    expect(conf).toContain(`upstream ${upstreamName('a-b')} {`);
    expect(conf).toContain(`upstream ${upstreamName('a_b')} {`);
  });

  it('**슬롯을 안 바꿔 쓴다** — 각 풀의 peer 가 자기 이름 아래 있다', () => {
    const slots = slotsOf(model, CAPS);
    expect(slots.http[upstreamName('a-b')]).toEqual(['10.0.0.1:80']);
    expect(slots.http[upstreamName('a_b')]).toEqual(['10.0.0.2:80']);
    // 슬롯이 둘이어야 한다. 하나로 접히면 한 풀이 통째로 사라진 것이다.
    expect(Object.keys(slots.http)).toHaveLength(2);
  });

  it('이름 조회가 렌더러와 같은 답을 한다', () => {
    const conf = render(model, CAPS).conf;
    expect(upstreamNameIn(conf, 'a-b')).toBe(upstreamName('a-b'));
    expect(upstreamNameIn(conf, 'a_b')).toBe(upstreamName('a_b'));
  });

  it('렌더에 안 쓰인 풀은 여전히 `undefined` — 그 판정이 안 깨졌다', () => {
    const withOrphan: Model = {
      ...model,
      pools: [...model.pools, { key: 'lonely', protocolClass: 'http', algorithm: 'round_robin' }],
      backends: [...model.backends,
        { key: 'b3', pool: 'lonely', host: '10.0.0.3', port: 80, weight: 1 }],
    };
    const conf = render(withOrphan, CAPS).conf;
    expect(upstreamNameIn(conf, 'lonely')).toBeUndefined();
    // `routedPools` 가 같은 판정을 쓴다 — 제안 #9 가 그것을 창구로 냈다.
    expect(routedPools(withOrphan, CAPS).has('lonely')).toBe(false);
    expect(routedPools(withOrphan, CAPS).has('a-b')).toBe(true);
  });
});
