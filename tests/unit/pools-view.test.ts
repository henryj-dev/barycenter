/**
 * Pools 화면의 값 — 브라우저 없이 계약을 지킨다. 드레인은 없다.
 */
import { describe, expect, it } from 'vitest';

import { pageOf } from '../../src/web/page.js';
import {
  applyHealthFlip, upsertHealth, viewOfPools,
} from '../../src/web/pools-view.js';

const pools = [
  { key: 'web', protocolClass: 'http', algorithm: 'round_robin' },
  { key: 'dns', protocolClass: 'udp', algorithm: 'round_robin' },
];
const backends = [
  { key: 'a', pool: 'web', host: '10.0.0.1', port: 8080 },
  { key: 'b', pool: 'web', host: '10.0.0.2', port: 8080 },
  { key: 'ns', pool: 'dns', host: '10.0.0.9', port: 53 },
];

describe('풀 목록', () => {
  it('관측이 없으면 unknown 이다 — 죽은 것과 섞지 않는다', () => {
    const view = viewOfPools(pools, backends, [
      { backendKey: 'a', state: 'healthy' },
    ]);
    const web = view.rows.find((p) => p.key === 'web');
    expect(web?.healthy).toBe(1);
    expect(web?.unknown).toBe(1);
    expect(web?.unhealthy).toBe(0);
    expect(web?.backends.map((b) => [b.key, b.state])).toEqual([
      ['a', 'healthy'],
      ['b', 'unknown'],
    ]);
  });

  it('health 델타 한 줄로 판정을 옮긴다 — 목록을 다시 치지 않는다', () => {
    const before = viewOfPools(pools, backends, [
      { backendKey: 'a', state: 'healthy' },
      { backendKey: 'b', state: 'healthy' },
    ]);
    const after = applyHealthFlip(before, { backendKey: 'b', state: 'unhealthy' });
    expect(after.rows.find((p) => p.key === 'web')?.unhealthy).toBe(1);
    expect(after.rows.find((p) => p.key === 'web')?.healthy).toBe(1);
    expect(after.rows.find((p) => p.key === 'dns')?.backends[0]?.state).toBe('unknown');
  });

  it('같은 백엔드의 다음 판정이 덮는다', () => {
    const rows = upsertHealth(
      [{ backendKey: 'a', state: 'unknown' }],
      { backendKey: 'a', state: 'healthy' },
    );
    expect(rows).toEqual([{ backendKey: 'a', state: 'healthy' }]);
  });
});

describe('화면 자리', () => {
  it('/pools 가 풀 화면이다 — Kit 이 아니다', () => {
    expect(pageOf('/pools')).toBe('pools');
    expect(pageOf('/pools/web')).toBe('pools');
    expect(pageOf('/listeners')).toBe('listeners');
    expect(pageOf('/')).toBe('impact');
  });
});
