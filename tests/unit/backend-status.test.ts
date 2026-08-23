/**
 * 제안 #9 — **"왜 이 백엔드가 트래픽을 안 받나" 에 한 번에 답한다** (2026-08-23).
 *
 * 지금은 조각으로만 보인다: 헬스는 `GET /backends/{id}/status`, 드레인은
 * `GET /backends/{id}/drain-status`, 슬롯 소속은 **아무 데도 안 보인다.** 운영자는 셋을
 * 따로 물어 머리로 합쳐야 하고, 셋째 이유는 물을 창구조차 없다.
 *
 * ── 트래픽을 못 받는 이유는 정확히 셋이다
 *
 * `reduceMembership` 이 정하는 것은 둘 — `unhealthy` 이거나 드레인 중이면 뺀다.
 * 그런데 **셋째가 있다**: 풀이 어떤 리스너·라우트에도 안 걸리면 렌더에 upstream 이 안
 * 생기고, 그러면 슬롯 자체가 없다. 백엔드는 멀쩡하고 헬스도 초록인데 트래픽이 0 이다.
 * 이 상태는 지금 **어디에도 안 드러난다** — 모델을 손으로 훑어야 안다.
 *
 * ⚠️ **판정의 정본은 리듀서다.** 엔진에게 "지금 슬롯에 뭐가 있냐" 고 되묻지 않는다.
 * 슬롯을 정하는 것이 리듀서이므로 되묻는 것은 우리가 방금 쓴 값을 다시 읽는 것이고,
 * 그 사이 갱신이 실패했다면 그건 **다른 사건**이다(§6.7) — 여기서 섞으면 "왜 안 받나" 의
 * 답이 두 층으로 갈린다.
 */
import { describe, expect, it } from 'vitest';

import { apiRouteTable } from '../../src/api/server.js';
import { backendStatusRows } from '../../src/control/backend-status.js';
import type { Model } from '../../src/model/provisional.js';

const model: Model = {
  listeners: [{
    key: 'web', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true,
    http: { defaultAction: { pool: 'app' } },
  }],
  httpRoutes: [],
  passthroughRoutes: [],
  pools: [
    { key: 'app', protocolClass: 'http', algorithm: 'round_robin' },
    // **어디에도 안 걸린 풀.** 백엔드는 있는데 렌더에 upstream 이 안 생긴다.
    { key: 'orphan', protocolClass: 'http', algorithm: 'round_robin' },
  ],
  backends: [
    { key: 'a', pool: 'app', host: '10.0.0.1', port: 80, weight: 1 },
    { key: 'b', pool: 'app', host: '10.0.0.2', port: 80, weight: 1 },
    { key: 'c', pool: 'app', host: '10.0.0.3', port: 80, weight: 1 },
    { key: 'lonely', pool: 'orphan', host: '10.0.0.9', port: 80, weight: 1 },
  ],
  certificates: [], tlsPolicies: [], sniBindings: [],
};

const rowsOf = (opts: Parameters<typeof backendStatusRows>[0]) => {
  const out = new Map(backendStatusRows(opts).map((r) => [r.key, r]));
  return out;
};

describe('백엔드 운영 상태 — 왜 트래픽을 안 받나 (제안 #9)', () => {
  it('건강하고 안 드레인이고 라우트된 백엔드는 받는다', () => {
    const r = rowsOf({ model, health: new Map([['a', 'healthy']]), draining: new Set(), routedPools: new Set(['app']) });
    expect(r.get('a')?.receivingTraffic).toBe(true);
    expect(r.get('a')?.reasons).toEqual([]);
  });

  it('`unhealthy` 는 이유를 말한다', () => {
    const r = rowsOf({ model, health: new Map([['a', 'unhealthy']]), draining: new Set(), routedPools: new Set(['app']) });
    expect(r.get('a')?.receivingTraffic).toBe(false);
    expect(r.get('a')?.reasons).toContain('unhealthy');
  });

  it('`unknown` 은 빼지 않는다 — 아직 못 잰 것과 죽은 것은 다르다', () => {
    // 기동 직후 전부 `unknown` 일 때 다 빼면 멤버십이 통째로 빈다 (§6.6).
    const r = rowsOf({ model, health: new Map(), draining: new Set(), routedPools: new Set(['app']) });
    expect(r.get('a')?.health.state).toBe('unknown');
    expect(r.get('a')?.receivingTraffic).toBe(true);
  });

  it('드레인 중이면 이유를 말한다', () => {
    const r = rowsOf({ model, health: new Map([['a', 'healthy']]), draining: new Set(['a']), routedPools: new Set(['app']) });
    expect(r.get('a')?.receivingTraffic).toBe(false);
    expect(r.get('a')?.reasons).toContain('draining');
    expect(r.get('a')?.draining).toBe(true);
  });

  it('**아무 데도 안 걸린 풀의 백엔드** — 이게 지금 안 보이던 셋째다', () => {
    const r = rowsOf({ model, health: new Map([['lonely', 'healthy']]), draining: new Set(), routedPools: new Set(['app']) });
    const lonely = r.get('lonely');
    expect(lonely?.receivingTraffic).toBe(false);
    expect(lonely?.reasons).toContain('pool_not_routed');
    // 헬스는 멀쩡하다 — 그래서 헬스만 보면 영영 못 찾는다.
    expect(lonely?.health.state).toBe('healthy');
  });

  it('이유가 여럿이면 **전부** 싣는다 — 하나만 고치면 여전히 안 받는다', () => {
    const r = rowsOf({
      model, health: new Map([['lonely', 'unhealthy']]),
      draining: new Set(['lonely']), routedPools: new Set(['app']),
    });
    expect(r.get('lonely')?.reasons.sort()).toEqual(['draining', 'pool_not_routed', 'unhealthy']);
  });

  it('풀이 없는 백엔드는 `pool_missing` — 검증기가 막지만 판정은 정직해야 한다', () => {
    const broken: Model = {
      ...model,
      backends: [{ key: 'x', pool: 'nope', host: '10.0.0.8', port: 80, weight: 1 }],
    };
    const r = rowsOf({ model: broken, health: new Map(), draining: new Set(), routedPools: new Set() });
    expect(r.get('x')?.reasons).toContain('pool_missing');
    expect(r.get('x')?.receivingTraffic).toBe(false);
  });

  it('평면을 싣는다 — http 와 stream 은 서로 다른 zone 이다 (E14)', () => {
    const r = rowsOf({ model, health: new Map(), draining: new Set(), routedPools: new Set(['app']) });
    expect(r.get('a')?.plane).toBe('http');
  });

  it('백엔드 순서가 안정적이다 — 목록을 눈으로 비교할 수 있어야 한다', () => {
    const keys = backendStatusRows({
      model, health: new Map(), draining: new Set(), routedPools: new Set(['app']),
    }).map((x) => x.key);
    expect(keys).toEqual([...keys].sort());
  });

  it('목록 라우트가 한 줄 라우트를 가리지 않는다 — 그림자는 조용히 생긴다', () => {
    /**
     * `/backends/status` 와 `/backends/{id}/status` 는 **다른 경로**여야 한다.
     * 하나가 다른 하나를 가리면 `bary get backends/status` 가 조용히 엉뚱한 핸들러로
     * 가고, 그 증상은 "빈 응답" 이라 원인을 안 가리킨다.
     */
    const table = apiRouteTable().filter((r) => r.path.includes('/backends'));
    const list = table.find((r) => r.path === '/api/v1/backends/status');
    const one = table.find((r) => r.path === '/api/v1/backends/:id/status');
    expect(list, '목록 라우트가 없다').toBeDefined();
    expect(one, '한 줄 라우트가 사라졌다').toBeDefined();
    expect(list?.scope).toBe('read');

    // 실제 정규식으로 판정한다 — 경로 문자열 비교는 그림자를 못 잡는다.
    const re = (path: string) =>
      new RegExp('^' + path.replace(/:([a-zA-Z]+)/g, '([^/]+)') + '$');
    expect(re('/api/v1/backends/:id/status').test('/api/v1/backends/status')).toBe(false);
    expect(re('/api/v1/backends/status').test('/api/v1/backends/abc/status')).toBe(false);
  });
});
