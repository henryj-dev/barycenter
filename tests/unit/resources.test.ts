/**
 * GUI 리소스 표 (경로 분리 #124) — 상세 주소 · 연결된 리소스 · 트래픽 경로 · 설정 펼치기 · 기록 비교.
 *
 * 상세 화면은 리소스마다 따로 짜지 않고 이 함수들로 그린다. 그래서 여기가 틀리면 아홉 화면이
 * 같이 틀린다. 특히 「연결된 리소스」 는 빼기 전에 보는 화면이라, 참조를 하나 놓치면 「빼도
 * 된다」 고 거짓말을 한다.
 */
import { describe, expect, it } from 'vitest';

import {
  RESOURCES, RESOURCE_KINDS, detailPattern, diffFields, edgesOf, flattenFields, relationsOf,
  resourcePath, summaryOf, trafficOf, type ModelLike,
} from '../../src/web/resources.js';
import { isDynamicGuiPath } from '../../src/web/page.js';
import { HISTORY_COLLECTIONS } from '../../src/store/config-store.js';

const model: ModelLike = {
  listeners: [
    {
      key: 'edge', protocol: 'https', bind: '0.0.0.0', port: 443, enabled: true,
      sourceAllow: ['@cloudflare', '10.0.0.0/8'],
      tls: { policy: 'modern', defaultCertificate: 'cf-origin' },
      http: { defaultAction: { pool: 'web' } },
    },
    { key: 'db', protocol: 'tcp', bind: '0.0.0.0', port: 5432, enabled: true, defaultPool: 'pg' },
    { key: 'sni', protocol: 'tls_passthrough', bind: '0.0.0.0', port: 8443, enabled: true, onNoSni: { pool: 'pg' } },
  ],
  httpRoutes: [
    { key: 'api', listener: 'edge', hosts: ['api.example.com'], priority: 10, action: { kind: 'proxy', pool: 'api', websocket: false } },
    { key: 'old', listener: 'edge', hosts: ['old.example.com'], priority: 20, action: { kind: 'redirect', to: 'https://new.example.com', status: 308 } },
    { key: 'ghost', listener: 'edge', hosts: ['x.example.com'], priority: 0, action: { kind: 'proxy', pool: 'gone', websocket: false } },
  ],
  passthroughRoutes: [
    { key: 'pt', listener: 'sni', snis: ['db.example.com'], priority: 0, action: { kind: 'reject' } },
  ],
  pools: [
    { key: 'web', protocolClass: 'http', algorithm: 'round_robin' },
    { key: 'api', protocolClass: 'http', algorithm: 'least_conn', upstreamTls: { enabled: true, verify: true, caBundle: 'internal-ca' } },
    { key: 'pg', protocolClass: 'tcp', algorithm: 'round_robin' },
  ],
  backends: [
    { key: 'web-1', pool: 'web', host: '10.0.0.1', port: 8080, weight: 1 },
    { key: 'web-2', pool: 'web', host: '10.0.0.2', port: 8080, weight: 3 },
    { key: 'api-1', pool: 'api', host: '10.0.1.1', port: 9000, weight: 1 },
  ],
  certificates: [{ key: 'cf-origin' }, { key: 'internal-ca' }],
  tlsPolicies: [{ key: 'modern', minVersion: '1.3' }],
  sniBindings: [{ key: 'api-sni', listener: 'edge', hosts: ['api.example.com'], certificate: 'cf-origin' }],
  addressSets: [{ key: 'cloudflare', cidrs: ['173.245.48.0/20'], source: 'cloudflare' }],
};

const health = (b: string): string => (b === 'web-2' ? 'unhealthy' : 'healthy');

describe('리소스 표와 주소', () => {
  it('기록 API 의 kind 가 리소스 표와 같다 — 한쪽만 늘면 기록 탭이 400 이다', () => {
    expect(Object.keys(HISTORY_COLLECTIONS).sort()).toEqual([...RESOURCE_KINDS].sort());
    for (const k of RESOURCE_KINDS) expect(HISTORY_COLLECTIONS[k]).toBe(RESOURCES[k].collection);
  });

  it('상세 주소는 key 를 인코딩하고, 패턴은 표의 탭만 받는다', () => {
    expect(resourcePath('listener', 'edge-443')).toBe('/traffic/listener/edge-443');
    expect(resourcePath('httpRoute', 'a b', 'history')).toBe('/traffic/route/http/a%20b/history');
    const p = detailPattern(RESOURCES.pool);
    for (const ok of ['/traffic/pool/web', '/traffic/pool/web/settings', '/traffic/pool/web/traffic']) expect(p.test(ok), ok).toBe(true);
    // 시안에 없는 탭·수정 화면은 셸을 안 낸다 — 수정은 설정 탭이다.
    for (const no of ['/traffic/pool/web/edit', '/traffic/pool/web/backends', '/traffic/pool/new', '/traffic/pool/web/x/y', '/traffic/pool/']) {
      expect(p.test(no), no).toBe(false);
    }
    // 트래픽 경로는 리스너·라우트·풀만(시안의 두 묶음).
    expect(isDynamicGuiPath('/traffic/backend/b/traffic')).toBe(false);
    expect(isDynamicGuiPath('/tls/sni/s/resources')).toBe(true);
    expect(isDynamicGuiPath('/traffic/route/http/api/traffic/')).toBe(true);
    expect(isDynamicGuiPath('/traffic/route/http/api/rebuild')).toBe(true);
    expect(isDynamicGuiPath('/traffic/route/passthrough/pt/rebuild')).toBe(false);
    expect(isDynamicGuiPath('/traffic/route/api')).toBe(false);
    expect(isDynamicGuiPath('/ops/cluster/web-01')).toBe(true);
    // 리스너 만들기 둘째 단계는 미리 만든 파일이다 — 셸이 아니다.
    expect(isDynamicGuiPath('/traffic/listener/new/https')).toBe(false);
  });
});

describe('연결된 리소스', () => {
  it('참조를 다 잡는다 — 정책·인증서·주소 집합·라우트·백엔드·SNI·업스트림 CA', () => {
    const edges = edgesOf(model).map((e) => `${e.from.kind}:${e.from.key} -${e.via}-> ${e.to.kind}:${e.to.key}`);
    expect(edges).toEqual(expect.arrayContaining([
      'listener:edge -기본 동작-> pool:web',
      'listener:edge -TLS 정책-> tlsPolicy:modern',
      'listener:edge -기본 인증서-> certificate:cf-origin',
      'listener:edge -출발지 제한-> addressSet:cloudflare',
      'listener:db -기본 풀-> pool:pg',
      'listener:sni -SNI 없음-> pool:pg',
      'httpRoute:api -리스너-> listener:edge',
      'httpRoute:api -프록시-> pool:api',
      'passthroughRoute:pt -리스너-> listener:sni',
      'backend:web-1 -풀-> pool:web',
      'pool:api -업스트림 CA-> certificate:internal-ca',
      'sniBinding:api-sni -인증서-> certificate:cf-origin',
    ]));
    // 대역(CIDR)은 참조가 아니다.
    expect(edges.some((e) => e.includes('10.0.0.0/8'))).toBe(false);
    // redirect·reject 라우트는 풀을 안 쓴다.
    expect(edges.some((e) => e.startsWith('httpRoute:old') && e.includes('pool'))).toBe(false);
  });

  it('쓰는 쪽과 쓰이는 쪽을 가르고, 없는 대상을 표시한다', () => {
    const cert = relationsOf(model, { kind: 'certificate', key: 'cf-origin' });
    expect(cert.uses).toEqual([]);
    expect(cert.usedBy.map((e) => `${e.from.kind}:${e.from.key}`).sort()).toEqual(['listener:edge', 'sniBinding:api-sni']);
    const ghost = relationsOf(model, { kind: 'httpRoute', key: 'ghost' });
    expect(ghost.uses.find((e) => e.to.kind === 'pool')).toMatchObject({ to: { key: 'gone' }, missing: true });
    expect(ghost.uses.find((e) => e.to.kind === 'listener')).toMatchObject({ missing: false });
  });
});

describe('트래픽 경로', () => {
  it('리스너 — 라우트를 우선순위 순서로, 그다음 기본 동작', () => {
    const lines = trafficOf(model, { kind: 'listener', key: 'edge' }, health);
    expect(lines.map((l) => l.route?.key ?? l.match)).toEqual(['old', 'api', 'ghost', '기본 동작 (맞는 라우트 없음)']);
    expect(lines[0]!.target).toEqual({ kind: 'redirect', to: 'https://new.example.com', status: 308 });
    expect(lines[2]!.target).toMatchObject({ kind: 'pool', pool: 'gone', missing: true, backends: [] });
    const fallback = lines[3]!.target;
    expect(fallback.kind === 'pool' && fallback.backends).toEqual([
      { key: 'web-1', target: '10.0.0.1:8080', weight: 1, health: 'healthy' },
      { key: 'web-2', target: '10.0.0.2:8080', weight: 3, health: 'unhealthy' },
    ]);
  });

  it('tcp 는 모든 연결이 기본 풀, 패스스루는 SNI 결과 둘 — 없으면 거절', () => {
    expect(trafficOf(model, { kind: 'listener', key: 'db' }, health).map((l) => l.match)).toEqual(['모든 연결']);
    const pt = trafficOf(model, { kind: 'listener', key: 'sni' }, health);
    expect(pt.map((l) => [l.route?.key ?? l.match, l.target.kind])).toEqual([
      ['pt', 'reject'], ['SNI 매칭 없음', 'reject'], ['SNI 없음', 'pool'],
    ]);
  });

  it('풀은 「어디서 이 풀로 오나」 — 리스너 이름을 붙인 줄', () => {
    expect(trafficOf(model, { kind: 'pool', key: 'web' }, health).map((l) => [l.listener, l.match]))
      .toEqual([['edge', 'edge · 기본 동작 (맞는 라우트 없음)']]);
    expect(trafficOf(model, { kind: 'pool', key: 'pg' }, health).map((l) => l.match))
      .toEqual(['db · 모든 연결', 'sni · SNI 없음']);
  });

  it('라우트는 자기 한 줄, 다른 리소스는 경로가 없다', () => {
    expect(trafficOf(model, { kind: 'httpRoute', key: 'api' }, health)).toHaveLength(1);
    expect(trafficOf(model, { kind: 'backend', key: 'web-1' }, health)).toEqual([]);
    expect(trafficOf(model, { kind: 'listener', key: 'nope' }, health)).toEqual([]);
  });
});

describe('설정 펼치기와 기록 비교', () => {
  it('모든 칸을 경로로 편다 — key 는 뺀다', () => {
    expect(flattenFields(model.listeners![0]!)).toEqual([
      { path: 'protocol', value: 'https' },
      { path: 'bind', value: '0.0.0.0' },
      { path: 'port', value: '443' },
      { path: 'enabled', value: 'true' },
      { path: 'sourceAllow', value: '@cloudflare, 10.0.0.0/8' },
      { path: 'tls.policy', value: 'modern' },
      { path: 'tls.defaultCertificate', value: 'cf-origin' },
      { path: 'http.defaultAction.pool', value: 'web' },
    ]);
    expect(flattenFields({ key: 'k', rules: [{ a: 1 }, { a: 2 }], empty: [], o: {} })).toEqual([
      { path: 'rules[0].a', value: '1' }, { path: 'rules[1].a', value: '2' },
      { path: 'empty', value: '[]' }, { path: 'o', value: '{}' },
    ]);
  });

  it('바뀐 칸만 — 생긴 칸·사라진 칸·바뀐 칸', () => {
    expect(diffFields({ key: 'e', port: 80, enabled: true, sourceAllow: ['a'] }, { key: 'e', port: 8080, enabled: true, http2: true }))
      .toEqual([
        { path: 'http2', after: 'true' },
        { path: 'port', before: '80', after: '8080' },
        { path: 'sourceAllow', before: 'a' },
      ]);
    expect(diffFields(null, { key: 'e', port: 1 })).toEqual([{ path: 'port', after: '1' }]);
  });

  it('개요는 리소스마다 먼저 보는 칸', () => {
    expect(summaryOf('httpRoute', model.httpRoutes![1]!)).toContainEqual({ label: '동작', value: 'redirect 308 → https://new.example.com' });
    expect(summaryOf('backend', model.backends![0]!)).toContainEqual({ label: '주소', value: '10.0.0.1:8080' });
    expect(summaryOf('pool', model.pools![1]!)).toContainEqual({ label: '업스트림 TLS', value: '켜짐' });
  });
});
