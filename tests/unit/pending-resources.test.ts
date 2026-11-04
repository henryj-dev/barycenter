/**
 * 적용 대기 리소스의 비교 (#126 후속) — 활성 모델과 head 모델을 (kind, key) 하나씩.
 *
 * 재는 것: 더함 · 바뀜 · 지움을 리소스 하나씩 말한다. 키 순서만 다른 것은 바뀜이 아니다. 활성화된 적이 없으면
 * head 의 모든 리소스가 더함이다.
 */
import { describe, expect, it } from 'vitest';

import type { Model } from '../../src/model/provisional.js';
import { diffResources } from '../../src/store/pending-resources.js';

function model(over: Partial<Model> = {}): Model {
  return {
    listeners: [], httpRoutes: [], passthroughRoutes: [], pools: [], backends: [],
    certificates: [], tlsPolicies: [], sniBindings: [], ...over,
  };
}

type PoolItem = Model['pools'][number];
const pool = (key: string, algorithm = 'round_robin'): PoolItem =>
  ({ key, protocolClass: 'http', algorithm }) as unknown as PoolItem;

describe('diffResources — 적용 대기 리소스', () => {
  it('같으면 빈 목록', () => {
    const m = model({ pools: [pool('web')] });
    expect(diffResources(m, structuredClone(m))).toEqual([]);
  });

  it('더함 · 바뀜 · 지움을 리소스 하나씩 말한다', () => {
    const active = model({ pools: [pool('web'), pool('old')], addressSets: [{ key: 'cf', cidrs: ['10.0.0.0/8'] }] });
    const head = model({ pools: [pool('web', 'least_conn'), pool('new')], addressSets: [{ key: 'cf', cidrs: ['10.0.0.0/8'] }] });
    expect(diffResources(active, head)).toEqual([
      { kind: 'pool', key: 'new', change: 'added' },
      { kind: 'pool', key: 'old', change: 'removed' },
      { kind: 'pool', key: 'web', change: 'changed' },
    ]);
  });

  it('키 순서만 다른 것은 바뀜이 아니다', () => {
    const a = { key: 'web', protocolClass: 'http', algorithm: 'round_robin', healthCheck: { path: '/h', interval: 5 } };
    const b = { healthCheck: { interval: 5, path: '/h' }, algorithm: 'round_robin', key: 'web', protocolClass: 'http' };
    expect(diffResources(
      model({ pools: [a as unknown as PoolItem] }),
      model({ pools: [b as unknown as PoolItem] }),
    )).toEqual([]);
  });

  it('배열 안의 순서는 의미가 있다 — 바뀜이다', () => {
    expect(diffResources(
      model({ addressSets: [{ key: 'cf', cidrs: ['10.0.0.0/8', '192.168.0.0/16'] }] }),
      model({ addressSets: [{ key: 'cf', cidrs: ['192.168.0.0/16', '10.0.0.0/8'] }] }),
    )).toEqual([{ kind: 'addressSet', key: 'cf', change: 'changed' }]);
  });

  it('활성화된 적이 없으면 head 의 모든 리소스가 더함이다', () => {
    const head = model({ pools: [pool('web')], addressSets: [{ key: 'cf', cidrs: ['10.0.0.0/8'] }] });
    expect(diffResources(undefined, head)).toEqual([
      { kind: 'pool', key: 'web', change: 'added' },
      { kind: 'addressSet', key: 'cf', change: 'added' },
    ]);
  });

  it('addressSets 가 없는 옛 모델과 빈 목록은 같다', () => {
    expect(diffResources(model(), model({ addressSets: [] }))).toEqual([]);
  });
});
