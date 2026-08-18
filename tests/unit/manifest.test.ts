/**
 * §5.5 — 같은 매니페스트를 두 번 import 해도 결과가 같다.
 */
import { describe, expect, it } from 'vitest';

import type { Model } from '../../src/model/provisional.js';
import {
  canon,
  exportManifest,
  importPatch,
  parseManifest,
} from '../../src/store/manifest.js';

const empty: Model = {
  listeners: [], httpRoutes: [], passthroughRoutes: [],
  pools: [], backends: [], certificates: [], tlsPolicies: [], sniBindings: [],
};

const hello: Model = {
  ...empty,
  pools: [{ key: 'app', protocolClass: 'http', algorithm: 'round_robin' }],
  backends: [{ key: 'a-11', pool: 'app', host: 'demo-backend', port: 11, weight: 1 }],
  listeners: [{
    key: 'front', protocol: 'http', bind: '0.0.0.0', port: 999, enabled: true,
    http: { defaultAction: { pool: 'app' } },
  }],
};

describe('export', () => {
  it('spec 만 나간다 — key 는 옆자리, id/revision 은 없다', () => {
    const m = exportManifest(hello);
    expect(m.schemaVersion).toBe('1');
    expect(m.resources.map((r) => r.kind)).toEqual(['pool', 'backend', 'listener']);
    expect(m.resources[0]).toEqual({
      kind: 'pool', key: 'app',
      spec: { protocolClass: 'http', algorithm: 'round_robin' },
    });
    expect(JSON.stringify(m)).not.toContain('"revision"');
    expect(JSON.stringify(m)).not.toContain('"id"');
  });
});

describe('import 멱등', () => {
  it('같은 매니페스트를 두 번 펼치면 두 번째는 빈 patch 다', () => {
    const m = exportManifest(hello);
    expect(importPatch(empty, m, 'merge')).toHaveLength(3);
    expect(importPatch(hello, m, 'merge')).toEqual([]);
    expect(importPatch(hello, parseManifest(JSON.parse(JSON.stringify(m))), 'merge')).toEqual([]);
  });

  it('필드 순서만 달라도 같다', () => {
    const m = parseManifest({
      schemaVersion: '1',
      resources: [{
        kind: 'pool', key: 'app',
        spec: { algorithm: 'round_robin', protocolClass: 'http' },
      }],
    });
    const cur: Model = {
      ...empty,
      pools: [{ algorithm: 'round_robin', protocolClass: 'http', key: 'app' }],
    };
    expect(importPatch(cur, m, 'merge')).toEqual([]);
    expect(canon({ b: 1, a: 2 })).toBe(canon({ a: 2, b: 1 }));
  });

  it('merge 는 매니페스트에 없는 현재 자원을 안 지운다', () => {
    const m = exportManifest({ ...empty, pools: hello.pools });
    const ops = importPatch(hello, m, 'merge');
    expect(ops.some((o) => o.op === 'delete')).toBe(false);
  });

  it('replace 는 매니페스트에 없는 현재 자원을 지운다', () => {
    const m = exportManifest({ ...empty, pools: hello.pools });
    const ops = importPatch(hello, m, 'replace');
    expect(ops).toContainEqual({ op: 'delete', kind: 'backend', key: 'a-11' });
    expect(ops).toContainEqual({ op: 'delete', kind: 'listener', key: 'front' });
  });
});

describe('해독', () => {
  it('모르는 필드와 깨진 schemaVersion 을 거절한다', () => {
    expect(() => parseManifest({ schemaVersion: '1', resources: [], extra: true }))
      .toThrow(/모르는 필드/);
    expect(() => parseManifest({ schemaVersion: '2', resources: [] }))
      .toThrow(/schemaVersion/);
    expect(() => parseManifest({
      schemaVersion: '1',
      resources: [{ kind: 'pool', key: 'p', spec: { key: 'p' } }],
    })).toThrow(/spec 에 key/);
  });
});
