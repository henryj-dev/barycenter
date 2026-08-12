/**
 * 모델 검증 — 렌더러는 검증된 모델만 받는다.
 *
 * 4차 검수 Critical: v3 까지 `render()` 는 잘못된 입력을 **의미를 바꿔서** 흡수했다.
 *
 *   `bind: '127.0.0.1x'` → `normalizeBind` 실패 → `listen 8080;`
 *
 * 오타 하나가 루프백 의도를 전 인터페이스 노출로 바꿨다. 참조가 깨진 라우트·풀도 산출물에서
 * 조용히 사라져, "저장은 됐는데 동작하지 않는" 상태를 만들었다.
 *
 * 여기서는 오류를 **모아서** 반환한다 (`plan` 이 한 번에 보여줘야 하므로). 렌더러는 하나라도
 * 있으면 던진다 — fail closed.
 */
import { findSocketConflicts, normalizeBind, type SocketReservation } from './sockets.js';
import { compileHostRoutes, type RouteInput } from '../route/compile.js';
import { parseHashKey } from './strings.js';
import { poolsReachedBy } from './engine-constraints.js';
import type { Model } from '../model/provisional.js';

export type ModelIssueCode =
  | 'invalid_bind_address'
  | 'unknown_pool'
  | 'unknown_listener'
  | 'pool_has_no_backend'
  | 'socket_conflict'
  | 'route_compile_error'
  | 'invalid_hash_key'
  | 'mixed_proxy_protocol_pool';

export type ModelIssue = {
  code: ModelIssueCode;
  /** 관련 리소스 key */
  subjects: string[];
  message: string;
};

export class ModelValidationError extends Error {
  constructor(readonly issues: ModelIssue[]) {
    super(
      `모델이 유효하지 않다 (${issues.length}건):\n` +
        issues.map((i) => `  · [${i.code}] ${i.message}`).join('\n'),
    );
    this.name = 'ModelValidationError';
  }
}

/** 렌더 결과에 영향을 주는 엔진 capability 중, 검증이 알아야 하는 것. */
export type ValidationCapabilities = { streamRealip: boolean };

export function validateModel(
  model: Model,
  caps: ValidationCapabilities = { streamRealip: false },
): ModelIssue[] {
  const issues: ModelIssue[] = [];
  const poolKeys = new Set(model.pools.map((p) => p.key));
  const listenerKeys = new Set(model.listeners.map((l) => l.key));
  const poolsWithBackends = new Set(model.backends.map((b) => b.pool));

  const needPool = (subject: string, poolKey: string): void => {
    if (!poolKeys.has(poolKey)) {
      issues.push({
        code: 'unknown_pool',
        subjects: [subject],
        message: `'${subject}' 가 존재하지 않는 풀 '${poolKey}' 를 참조한다`,
      });
      return;
    }
    if (!poolsWithBackends.has(poolKey)) {
      issues.push({
        code: 'pool_has_no_backend',
        subjects: [subject, poolKey],
        message:
          `풀 '${poolKey}' 에 백엔드가 없다. 렌더에서 조용히 사라지는 대신 저장을 막는다`,
      });
    }
  };

  // ── 풀 ──
  for (const pool of model.pools) {
    if (pool.algorithm !== 'hash') continue;
    const parsed = parseHashKey(pool.protocolClass, pool.hashKey ?? 'remote_addr');
    if (!parsed.ok) {
      issues.push({ code: 'invalid_hash_key', subjects: [pool.key], message: parsed.message });
    }
  }

  // ── 리스너 ──
  const reservations: SocketReservation[] = [];
  for (const l of model.listeners) {
    const bind = normalizeBind(l.bind);
    if (!bind.ok) {
      issues.push({
        code: 'invalid_bind_address',
        subjects: [l.key],
        message: `리스너 '${l.key}' 의 bind 가 IP 주소가 아니다: ${JSON.stringify(l.bind)}`,
      });
    } else if (l.enabled) {
      reservations.push({ key: l.key, protocol: l.protocol, bind: l.bind, port: l.port });
    }

    if (l.defaultPool !== undefined) needPool(l.key, l.defaultPool);
    if (l.protocol === 'tls_passthrough') {
      const o = l.onUnmatchedSni;
      if (o !== undefined && o !== 'reject') needPool(l.key, o.pool);
    }
    if (l.protocol === 'http' && l.http?.defaultAction !== undefined) {
      const a = l.http.defaultAction;
      if (a !== 'reject') needPool(l.key, a.pool);
    }
  }

  for (const c of findSocketConflicts(reservations)) {
    issues.push({ code: 'socket_conflict', subjects: [c.a, c.b], message: c.reason });
  }

  // ── PROXY 수신 리스너와 일반 리스너가 같은 풀을 공유하는가 ──
  //
  // stream_realip 이 없으면 소스IP 해시가 $proxy_protocol_addr 로 렌더된다(§7.6). 그런데
  // 같은 풀을 PROXY 를 받지 않는 리스너도 쓰면, 그쪽에서는 그 변수가 **비어 있어**
  // 모든 클라이언트가 한 peer 로 몰린다. 조용히 망가지므로 저장에서 막는다 (4차 검수).
  if (!caps.streamRealip) {
    const hashPools = new Set(
      model.pools.filter((p) => p.algorithm === 'source_ip_hash' || p.algorithm === 'hash').map((p) => p.key),
    );
    const viaProxy = new Set<string>();
    const viaDirect = new Set<string>();
    for (const l of model.listeners) {
      if (!l.enabled) continue;
      const target = l.acceptProxyProtocol === true && l.protocol !== 'udp' ? viaProxy : viaDirect;
      for (const pk of poolsReachedBy(l, model)) target.add(pk);
    }
    for (const pk of hashPools) {
      if (viaProxy.has(pk) && viaDirect.has(pk)) {
        issues.push({
          code: 'mixed_proxy_protocol_pool',
          subjects: [pk],
          message:
            `풀 '${pk}' 를 PROXY 수신 리스너와 일반 리스너가 함께 쓴다. stream_realip 이 없어 ` +
            `해시가 $proxy_protocol_addr 로 계산되는데, 일반 리스너에서는 그 값이 비어 모든 ` +
            `클라이언트가 한 peer 로 몰린다. 풀을 분리하거나 stream_realip 이 있는 엔진을 쓴다.`,
        });
      }
    }
  }

  // ── 라우트 ──
  const byListener = new Map<string, RouteInput[]>();
  const addRoute = (listener: string, key: string, host: string, priority: number, path?: string) => {
    if (!listenerKeys.has(listener)) {
      issues.push({
        code: 'unknown_listener',
        subjects: [key],
        message: `라우트 '${key}' 가 존재하지 않는 리스너 '${listener}' 를 참조한다`,
      });
      return;
    }
    const list = byListener.get(listener) ?? [];
    list.push(path === undefined ? { key, host, priority } : { key, host, priority, pathPrefix: path });
    byListener.set(listener, list);
  };

  for (const r of model.httpRoutes) {
    if (r.action.kind === 'proxy') needPool(r.key, r.action.pool);
    r.hosts.forEach((h, i) => addRoute(r.listener, `${r.key}#${i}`, h, r.priority, r.pathPrefix));
  }
  for (const r of model.passthroughRoutes) {
    if (r.action.kind === 'proxy') needPool(r.key, r.action.pool);
    r.snis.forEach((h, i) => addRoute(r.listener, `${r.key}#${i}`, h, r.priority));
  }

  for (const [listener, inputs] of byListener) {
    for (const e of compileHostRoutes(inputs).errors) {
      issues.push({
        code: 'route_compile_error',
        subjects: [listener, e.route],
        message: `리스너 '${listener}': ${e.message}`,
      });
    }
  }

  return issues;
}
