/**
 * **데이터 공급의 모델** (2026-11-05) — 풀의 `discovery` · 주소 집합의 `source`(레지스트리 이름) + `sourceOptions`.
 *
 * 재는 것:
 *   · 옛 저장값 `source: 'cloudflare'` 가 **그대로** 읽히고 같은 모양으로 나온다(호환)
 *   · 출처마다 받는 옵션만 받는다 · url 은 https 만 · 옵션은 출처가 있을 때만
 *   · 풀의 출처 — 출처마다 query 의 모양, file 은 경로를 못 쓴다, 포트 · emptyMeans 범위
 *   · 칸이 없으면 렌더가 이 기능 전과 같은 바이트다
 */
import { describe, expect, it } from 'vitest';

import { render } from '../../src/conf/render.js';
import { decodeModel } from '../../src/model/decode.js';
import type { Model } from '../../src/model/provisional.js';
import { addressSourceFormOf, addressSourceOf } from '../../src/web/address-source.js';
import { discoveryFormOf, poolBodyWithDiscovery } from '../../src/web/discovery.js';

const base = (pool: Record<string, unknown> = {}, sets?: unknown[]): Record<string, unknown> => ({
  listeners: [{
    key: 'web', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true,
    http: { defaultAction: { pool: 'app' } },
  }],
  httpRoutes: [], passthroughRoutes: [],
  pools: [{ key: 'app', protocolClass: 'http', algorithm: 'round_robin', ...pool }],
  backends: [{ key: 'a', pool: 'app', host: '10.0.0.1', port: 8080, weight: 1 }],
  certificates: [], tlsPolicies: [], sniBindings: [],
  ...(sets === undefined ? {} : { addressSets: sets }),
});

const codes = (m: unknown): string[] => {
  const r = decodeModel(m);
  return r.ok ? [] : r.issues.map((i) => `${i.code} ${i.subjects.join(',')}`);
};

describe('주소 집합 출처 — 호환', () => {
  it('옛 저장값 cloudflare 가 그대로 읽히고 같은 모양으로 나온다', () => {
    const old = { key: 'cf', cidrs: ['173.245.48.0/20', '2400:cb00::/32'], source: 'cloudflare' };
    const r = decodeModel(base({}, [old]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.model.addressSets).toEqual([old]);
    // 옵션 칸이 생기지 않는다 — 옛 리비전 스냅샷과 같은 바이트로 다시 쓰인다.
    expect(Object.keys(r.model.addressSets![0]!)).toEqual(['key', 'cidrs', 'source']);
  });

  it('출처 없는 집합도 그대로다', () => {
    const r = decodeModel(base({}, [{ key: 'x', cidrs: ['10.0.0.0/8'] }]));
    expect(r.ok && r.model.addressSets).toEqual([{ key: 'x', cidrs: ['10.0.0.0/8'] }]);
  });

  it('모르는 출처 이름은 거절한다', () => {
    expect(codes(base({}, [{ key: 'x', cidrs: ['10.0.0.0/8'], source: 'akamai' }]))).toEqual([
      'invalid_enum addressSets[0].source',
    ]);
  });
});

describe('주소 집합 출처 — 옵션', () => {
  it('출처마다 받는 옵션만 받는다', () => {
    expect(codes(base({}, [{
      key: 'aws', cidrs: ['13.32.0.0/15'], source: 'aws',
      sourceOptions: { services: ['CLOUDFRONT'], regions: ['GLOBAL'], family: 'ipv4' },
    }]))).toEqual([]);
    expect(codes(base({}, [{ key: 'cf', cidrs: ['1.1.1.0/24'], source: 'cloudflare', sourceOptions: { services: ['X'] } }])))
      .toEqual(['option_not_supported addressSets[0].sourceOptions.services']);
  });

  it('url 출처는 https 주소가 있어야 한다', () => {
    expect(codes(base({}, [{ key: 'u', cidrs: ['1.1.1.0/24'], source: 'url' }])))
      .toEqual(['invalid_value addressSets[0].sourceOptions.url']);
    expect(codes(base({}, [{ key: 'u', cidrs: ['1.1.1.0/24'], source: 'url', sourceOptions: { url: 'http://x.example/ips' } }])))
      .toContain('invalid_value addressSets[0].sourceOptions.url');
    expect(codes(base({}, [{
      key: 'u', cidrs: ['1.1.1.0/24'], source: 'url', sourceOptions: { url: 'https://x.example/ips.json', jsonPath: 'prefixes.cidr' },
    }]))).toEqual([]);
  });

  it('출처 없이 옵션만 있으면 거절한다', () => {
    expect(codes(base({}, [{ key: 'x', cidrs: ['10.0.0.0/8'], sourceOptions: { family: 'ipv4' } }])))
      .toEqual(['invalid_value addressSets[0].sourceOptions']);
  });

  it('폼 → 모델 → 폼이 같다', () => {
    const f = addressSourceFormOf({ source: 'aws', sourceOptions: { services: ['CLOUDFRONT', 'S3'], family: 'ipv6' } });
    expect(f).toMatchObject({ source: 'aws', services: 'CLOUDFRONT, S3', family: 'ipv6' });
    expect(addressSourceOf(f)).toEqual({ source: 'aws', sourceOptions: { family: 'ipv6', services: ['CLOUDFRONT', 'S3'] } });
    expect(addressSourceOf({ ...f, source: 'manual' })).toEqual({});
  });
});

describe('풀의 백엔드 출처', () => {
  it('출처마다 query 의 모양을 본다', () => {
    expect(codes(base({ discovery: { source: 'dns-srv', query: '_http._tcp.api.internal' } }))).toEqual([]);
    expect(codes(base({ discovery: { source: 'consul', query: 'api', port: 9000, emptyMeans: 'empty' } }))).toEqual([]);
    expect(codes(base({ discovery: { source: 'kubernetes', query: 'prod/api' } }))).toEqual([]);
    expect(codes(base({ discovery: { source: 'kubernetes', query: 'api' } }))).toEqual(['invalid_value pools[0].discovery.query']);
  });

  it('file 출처는 디렉터리를 벗어나지 못한다', () => {
    expect(codes(base({ discovery: { source: 'file', query: 'api.json' } }))).toEqual([]);
    for (const q of ['../etc/passwd', '/etc/passwd', 'a/b.json', '.hidden']) {
      expect(codes(base({ discovery: { source: 'file', query: q } }))).toEqual(['invalid_value pools[0].discovery.query']);
    }
  });

  it('모르는 출처 · 포트 범위 · emptyMeans 를 거절한다', () => {
    expect(codes(base({ discovery: { source: 'eureka', query: 'api' } }))).toEqual(['invalid_enum pools[0].discovery.source']);
    expect(codes(base({ discovery: { source: 'consul', query: 'api', port: 0 } }))).toEqual(['out_of_range pools[0].discovery.port']);
    expect(codes(base({ discovery: { source: 'consul', query: 'api', emptyMeans: 'drop' } })))
      .toEqual(['invalid_enum pools[0].discovery.emptyMeans']);
  });

  it('칸이 있어도 없어도 렌더는 같은 바이트다 — 출처는 멤버십에서만 움직인다', () => {
    const plain = decodeModel(base());
    const disc = decodeModel(base({ discovery: { source: 'consul', query: 'api' } }));
    expect(plain.ok && disc.ok).toBe(true);
    if (!plain.ok || !disc.ok) return;
    expect(render(disc.model as Model).conf).toBe(render(plain.model as Model).conf);
  });

  it('설정 폼은 discovery 만 바꾸고 다른 칸을 남긴다', () => {
    const pool = { key: 'app', protocolClass: 'http', algorithm: 'least_conn', healthCheck: { path: '/healthz' } };
    expect(poolBodyWithDiscovery(pool, { source: 'kubernetes', query: ' prod/api ', port: '8080', emptyMeans: 'keep' })).toEqual({
      protocolClass: 'http', algorithm: 'least_conn', healthCheck: { path: '/healthz' },
      discovery: { source: 'kubernetes', query: 'prod/api', port: 8080 },
    });
    const withDisc = { ...pool, discovery: { source: 'consul', query: 'api' } };
    expect(discoveryFormOf(withDisc)).toEqual({ source: 'consul', query: 'api', port: '', emptyMeans: 'keep' });
    expect(poolBodyWithDiscovery(withDisc, discoveryFormOf(undefined))).not.toHaveProperty('discovery');
  });
});
