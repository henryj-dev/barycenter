/**
 * 헬스 프로브가 인증서 이름을 IP 로 검증하게 되는 풀을 미리 알린다 (2026-11-08, `idp.tinyuniver.se`).
 *
 * 풀이 `upstreamTls: { enabled: true }`(sni 없음) + `healthCheck: { protocol: 'http' }` 였고 백엔드는 IP 였다. 공인 인증서
 * `CN=idp.tinyuniver.se` 를 냈으므로 프로브가 `ERR_TLS_CERT_ALTNAME_INVALID` 로 늘 `unhealthy` 였다 — 풀이 비어 500.
 * 판정은 `probePlanOf` 그대로다. 노드는 servername 이 없으면 Host 헤더 → 찌르는 host 의 **이름**을 쓴다(IP 는 안 쓴다).
 */
import { describe, expect, it } from 'vitest';

import { probeTlsNameGaps } from '../../src/control/health.js';
import type { Backend, Model, Pool } from '../../src/model/provisional.js';

const model = (pool: Partial<Pool>, hosts: string[] = ['10.112.224.13']): Model => ({
  listeners: [], httpRoutes: [], passthroughRoutes: [],
  pools: [{ key: 'idp', protocolClass: 'http', algorithm: 'round_robin', ...pool } as Pool],
  backends: hosts.map((host, i) => ({ key: `idp-${i + 1}`, pool: 'idp', host, port: 443, weight: 1 } as Backend)),
  certificates: [], tlsPolicies: [], sniBindings: [],
});

const INCIDENT: Partial<Pool> = {
  upstreamTls: { enabled: true },
  healthCheck: { protocol: 'http', path: '/api/health' },
};

describe('probeTlsNameGaps — 프로브가 인증서 이름을 IP 로 검증하는 풀', () => {
  it('**운영 장애 조합을 짚는다** — TLS 켬 · sni 없음 · http 프로브 · IP 백엔드', () => {
    expect(probeTlsNameGaps(model(INCIDENT))).toEqual([{ pool: 'idp', backends: ['idp-1'] }]);
  });

  it('IP 백엔드만 짚는다 — 이름 백엔드는 노드가 그 이름을 SNI 로 쓴다', () => {
    expect(probeTlsNameGaps(model(INCIDENT, ['10.0.0.1', 'idp.example.test', '::1'])))
      .toEqual([{ pool: 'idp', backends: ['idp-1', 'idp-3'] }]);
  });

  it('sni 가 있으면 알리지 않는다', () => {
    expect(probeTlsNameGaps(model({ ...INCIDENT, upstreamTls: { enabled: true, sni: 'idp.example.test' } }))).toEqual([]);
  });

  it('healthCheck.hostHeader 가 이름이면 알리지 않는다 — 노드가 Host 의 이름을 SNI 로 쓴다', () => {
    expect(probeTlsNameGaps(model({ ...INCIDENT, healthCheck: { protocol: 'http', hostHeader: 'idp.example.test:443' } })))
      .toEqual([]);
    // Host 가 IP 면 여전히 IP 로 검증한다.
    expect(probeTlsNameGaps(model({ ...INCIDENT, healthCheck: { protocol: 'http', hostHeader: '10.0.0.1' } })))
      .toHaveLength(1);
  });

  it('verify 없는 TLS 풀의 기본(tcp_connect)은 알리지 않는다 — 인증서를 안 본다', () => {
    expect(probeTlsNameGaps(model({ upstreamTls: { enabled: true } }))).toEqual([]);
  });

  it('verify 를 켠 풀은 기본이 http 프로브라 알린다', () => {
    expect(probeTlsNameGaps(model({ upstreamTls: { enabled: true, verify: true, caBundle: 'ca' } })))
      .toEqual([{ pool: 'idp', backends: ['idp-1'] }]);
  });

  it('별도 헬스 port · 사이드카 hostOverride 는 평문이라 알리지 않는다', () => {
    expect(probeTlsNameGaps(model({ ...INCIDENT, healthCheck: { protocol: 'http', port: 8081 } }))).toEqual([]);
    expect(probeTlsNameGaps(model({ ...INCIDENT, healthCheck: { protocol: 'http', hostOverride: '10.0.0.9' } }))).toEqual([]);
  });

  it('프로브를 안 하는 풀 · TLS 를 안 쓰는 풀은 알리지 않는다', () => {
    expect(probeTlsNameGaps(model({ ...INCIDENT, healthCheck: { mode: 'none', protocol: 'http' } }))).toEqual([]);
    expect(probeTlsNameGaps(model({ healthCheck: { protocol: 'http' } }))).toEqual([]);
    expect(probeTlsNameGaps(model({ upstreamTls: { enabled: false }, healthCheck: { protocol: 'http' } }))).toEqual([]);
  });
});
