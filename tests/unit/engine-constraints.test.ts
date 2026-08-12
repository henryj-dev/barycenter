/**
 * E0 을 닫는 테스트 — 엔진 capability 로 모델을 제한한다 (§7.6, §9.2)
 *
 * `stream_realip` 이 없을 때 실측으로 확인한 것:
 *   · `$proxy_protocol_addr` 는 **쓸 수 있다** → 실 클라이언트 IP 로 해시가 가능하다
 *   · `$remote_addr` 는 앞단 LB 주소로 남는다
 *   · PROXY 체인(수신+송신)은 **LB 주소를 보낸다** → 실 클라이언트 IP 가 조용히 유실된다
 *
 * 마지막 항목이 위험하다. 저장은 되고 `nginx -t` 도 통과하는데 백엔드가 받는 주소만 틀린다.
 * "저장 후 안 되는 것보다 저장 자체를 막는 게 낫다" (§1 설계 원칙 8).
 */
import { describe, expect, it } from 'vitest';

import { checkEngineConstraints } from '../../src/validate/engine-constraints.js';
import type { EngineCapabilities } from '../../src/engine/capabilities.js';
import type { Model } from '../../src/model/provisional.js';

const caps = (streamRealip: boolean): EngineCapabilities => ({
  flavor: 'openresty',
  version: '1.31.1',
  modules: new Set<string>(),
  dynamicModules: new Set<string>(),
  supports: {
    stream: true,
    streamLua: true,
    streamRealip,
    sniPassthrough: true,
    http2: true,
    dnsResolve: true,
    runtimeMembership: { http: true, stream: true },
  },
});

/** 앞단 LB 가 PROXY 를 보내고, 우리도 백엔드로 PROXY 를 보내는 체인 구성. */
const chained: Model = {
  listeners: [
    { key: 'edge', protocol: 'tcp', bind: '0.0.0.0', port: 9000, enabled: true,
      defaultPool: 'app', acceptProxyProtocol: true },
  ],
  pools: [{ key: 'app', protocolClass: 'tcp', algorithm: 'round_robin', sendProxyProtocol: 'v1' }],
  backends: [{ key: 'a', pool: 'app', host: '10.0.0.1', port: 443, weight: 1 }],
  httpRoutes: [],
  passthroughRoutes: [],
};

/** 수신만 하고 해시로 세션을 고정하는 구성. */
const hashed: Model = {
  ...chained,
  pools: [{ key: 'app', protocolClass: 'tcp', algorithm: 'source_ip_hash' }],
};

describe('PROXY 체인 — stream_realip 이 없으면 막는다', () => {
  it('수신 + 송신 조합을 거부한다', () => {
    const issues = checkEngineConstraints(chained, caps(false));
    const blocked = issues.filter((i) => i.severity === 'error');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.code).toBe('proxy_protocol_chain_requires_stream_realip');
    expect(blocked[0]!.subjects).toEqual(['edge', 'app']);
  });

  it('모듈이 있으면 허용한다 — 같은 모델, 다른 엔진', () => {
    expect(checkEngineConstraints(chained, caps(true))).toEqual([]);
  });

  it('수신만 하면 막지 않는다', () => {
    const acceptOnly: Model = {
      ...chained,
      pools: [{ key: 'app', protocolClass: 'tcp', algorithm: 'round_robin' }],
    };
    expect(checkEngineConstraints(acceptOnly, caps(false))).toEqual([]);
  });

  it('송신만 하면 막지 않는다 — 앞단이 없으면 유실할 정보가 없다', () => {
    const sendOnly: Model = {
      ...chained,
      listeners: [
        { key: 'edge', protocol: 'tcp', bind: '0.0.0.0', port: 9000, enabled: true, defaultPool: 'app' },
      ],
    };
    expect(checkEngineConstraints(sendOnly, caps(false))).toEqual([]);
  });
});

describe('소스IP 해시 — 막지 않고 경고만 한다', () => {
  it('stream_realip 이 없으면 $proxy_protocol_addr 로 대체됨을 알린다', () => {
    const issues = checkEngineConstraints(hashed, caps(false));
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    const warn = issues.find((i) => i.code === 'source_ip_hash_uses_proxy_protocol_addr');
    expect(warn).toBeDefined();
    expect(warn!.severity).toBe('warning');
  });

  it('모듈이 있으면 경고도 없다', () => {
    expect(checkEngineConstraints(hashed, caps(true))).toEqual([]);
  });
});

describe('비활성 리스너는 검사하지 않는다', () => {
  it('enabled=false 면 제약 대상이 아니다', () => {
    const disabled: Model = {
      ...chained,
      listeners: chained.listeners.map((l) => ({ ...l, enabled: false })),
    };
    expect(checkEngineConstraints(disabled, caps(false))).toEqual([]);
  });
});
