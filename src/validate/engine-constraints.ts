/**
 * 엔진 capability 로 모델을 제한한다 — DESIGN.md §7.6, §1 설계 원칙 8
 *
 * `stream_realip_module` 이 없는 엔진에서 실측한 것 (tests/engine):
 *
 *   · `$proxy_protocol_addr` 는 **쓸 수 있다.** 실 클라이언트 IP 를 읽는 데 문제없다.
 *   · `$remote_addr` 는 앞단 LB 주소로 남는다.
 *   · PROXY 수신 + 송신을 함께 켜면 백엔드는 **LB 주소를 받는다.**
 *     클라이언트가 `203.0.113.9` 를 보내도 백엔드에는 `127.0.0.1` 이 도착했다.
 *
 * 마지막 항목이 위험한 이유는 조용하기 때문이다. 저장도 되고 `nginx -t` 도 통과하는데
 * 백엔드가 받는 주소만 틀린다. 그래서 저장 자체를 막는다 — "저장 후 안 되는 것보다 낫다".
 *
 * 반면 소스IP 해시는 막을 필요가 없다. 렌더러가 `$proxy_protocol_addr` 로 바꿔 주면
 * 의도한 대로 동작한다. 다만 무엇이 일어났는지는 알려야 하므로 경고로 남긴다.
 */
import type { EngineCapabilities } from '../engine/capabilities.js';
import type { Pool, RawListener, RawModel } from '../model/provisional.js';

export type EngineIssueCode =
  | 'proxy_protocol_chain_requires_stream_realip'
  | 'source_ip_hash_uses_proxy_protocol_addr';

export type EngineIssue = {
  severity: 'error' | 'warning';
  code: EngineIssueCode;
  /** 관련 리소스 key — [리스너, 풀] 순서 */
  subjects: string[];
  message: string;
};

/** PROXY 헤더를 받을 수 있는 것은 TCP 계열 리스너뿐이다. UDP 는 엔진이 지원하지 않는다. */
const acceptsProxyProtocol = (l: RawListener): boolean =>
  l.enabled && l.protocol !== 'udp' && l.acceptProxyProtocol !== undefined;

export function checkEngineConstraints(model: RawModel, caps: EngineCapabilities): EngineIssue[] {
  if (caps.supports.streamRealip) return [];

  const pools = new Map<string, Pool>(model.pools.map((p) => [p.key, p]));
  const issues: EngineIssue[] = [];

  for (const listener of model.listeners) {
    if (!acceptsProxyProtocol(listener)) continue;

    for (const poolKey of poolsReachedBy(listener, model)) {
      const pool = pools.get(poolKey);
      if (pool === undefined) continue;

      if (pool.sendProxyProtocol !== undefined) {
        issues.push({
          severity: 'error',
          code: 'proxy_protocol_chain_requires_stream_realip',
          subjects: [listener.key, pool.key],
          message:
            `리스너 '${listener.key}' 가 PROXY 헤더를 받고 풀 '${pool.key}' 이 다시 PROXY 로 보내는데, ` +
            `이 엔진에는 stream_realip 모듈이 없다. 백엔드는 실 클라이언트 IP 대신 이 프록시의 ` +
            `주소를 받게 된다. stream_realip 이 포함된 엔진을 쓰거나 둘 중 하나를 끈다.`,
        });
      } else if (pool.algorithm === 'source_ip_hash') {
        issues.push({
          severity: 'warning',
          code: 'source_ip_hash_uses_proxy_protocol_addr',
          subjects: [listener.key, pool.key],
          message:
            `풀 '${pool.key}' 의 소스IP 해시는 stream_realip 이 없어 $remote_addr 대신 ` +
            `$proxy_protocol_addr 로 계산된다. 결과는 의도대로지만 로그의 $remote_addr 는 ` +
            `여전히 앞단 프록시 주소다.`,
        });
      }
    }
  }

  return issues;
}

/** 이 리스너를 통해 트래픽이 닿는 풀들. */
export function poolsReachedBy(listener: RawListener, model: RawModel): string[] {
  const out = new Set<string>();
  if (listener.defaultPool !== undefined) out.add(listener.defaultPool);

  if (listener.protocol === 'tls_passthrough') {
    for (const r of model.passthroughRoutes) {
      if (r.listener === listener.key && r.action.kind === 'proxy') out.add(r.action.pool);
    }
    const outcome = listener.onUnmatchedSni;
    if (outcome !== undefined && outcome !== 'reject') out.add(outcome.pool);
  }
  if (listener.protocol === 'http') {
    for (const r of model.httpRoutes) {
      if (r.listener === listener.key && r.action.kind === 'proxy') out.add(r.action.pool);
    }
  }
  return [...out].sort();
}
