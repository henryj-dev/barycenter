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
import type { Listener, Model, RawListener, RawModel, ProtocolClass } from '../model/provisional.js';

export type ModelIssueCode =
  | 'invalid_bind_address'
  | 'unknown_pool'
  | 'unknown_listener'
  | 'pool_has_no_backend'
  | 'socket_conflict'
  | 'route_compile_error'
  | 'invalid_hash_key'
  | 'mixed_proxy_protocol_pool'
  /** 라우트가 없는 리스너인데 기본 풀도 없다 — 트래픽이 갈 곳이 없다. */
  | 'listener_requires_default_pool'
  /** 라우트가 자기 프로토콜이 아닌 리스너를 가리킨다. */
  | 'route_protocol_mismatch'
  /** 리스너의 서브시스템과 풀의 프로토콜 계열이 다르다. */
  | 'pool_protocol_mismatch'
  /** 어떤 풀에도 속하지 않은 백엔드. */
  | 'orphan_backend'
  /** 이 프로토콜에서 의미가 없거나 엔진이 지원하지 않는 옵션. */
  | 'option_not_supported';

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

/**
 * 리스너가 어느 서브시스템의 어떤 프로토콜 계열로 프록시하는가.
 *
 * `tls_passthrough` 는 TLS 를 종단하지 않고 그대로 흘리므로 TCP 다.
 */
const classOfListener = (protocol: RawListener['protocol']): ProtocolClass =>
  protocol === 'http' ? 'http' : protocol === 'udp' ? 'udp' : 'tcp';

/** 라우트로 목적지를 가르는 리스너. 나머지는 기본 풀이 유일한 목적지다. */
const routesTraffic = (protocol: RawListener['protocol']): boolean =>
  protocol === 'http' || protocol === 'tls_passthrough';

/** 렌더 결과에 영향을 주는 엔진 capability 중, 검증이 알아야 하는 것. */
export type ValidationCapabilities = { streamRealip: boolean };

export function validateModel(
  model: RawModel,
  caps: ValidationCapabilities = { streamRealip: false },
): ModelIssue[] {
  const issues: ModelIssue[] = [];
  const poolKeys = new Set(model.pools.map((p) => p.key));
  const listenerKeys = new Set(model.listeners.map((l) => l.key));
  const poolsWithBackends = new Set(model.backends.map((b) => b.pool));

  const poolByKey = new Map(model.pools.map((p) => [p.key, p]));

  /**
   * 참조 검사. `expect` 를 주면 풀의 프로토콜 계열까지 본다.
   *
   * 계열이 어긋나면 렌더러가 **다른 서브시스템의 upstream 을 가리키는** 설정을 낸다.
   * http 블록에서 stream 풀을 `proxy_pass` 하면 이름이 안 잡혀 조용히 502 가 된다.
   */
  const needPool = (subject: string, poolKey: string, expect?: ProtocolClass): void => {
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
    const cls = poolByKey.get(poolKey)?.protocolClass;
    if (expect !== undefined && cls !== undefined && cls !== expect) {
      issues.push({
        code: 'pool_protocol_mismatch',
        subjects: [subject, poolKey],
        message:
          `'${subject}' 는 ${expect} 인데 풀 '${poolKey}' 는 ${cls} 다. ` +
          `서브시스템이 다르면 렌더된 upstream 이름이 잡히지 않는다`,
      });
    }
  };

  // ── 백엔드 ──
  // 어떤 풀에도 속하지 않은 백엔드는 렌더에서 그냥 사라진다. 사라지는 것을 막는다.
  for (const b of model.backends) {
    if (!poolKeys.has(b.pool)) {
      issues.push({
        code: 'orphan_backend',
        subjects: [b.key, b.pool],
        message: `백엔드 '${b.key}' 가 존재하지 않는 풀 '${b.pool}' 에 속해 있다`,
      });
    }
  }

  // ── 풀 ──
  for (const pool of model.pools) {
    // §4.7 — http 에는 PROXY 송신 디렉티브 자체가 없고, udp 는 엔진이 지원하지 않는다.
    // 켜 두면 렌더러가 조용히 무시한다. 무시할 바에는 저장을 막는다.
    if (pool.sendProxyProtocol !== undefined && pool.protocolClass !== 'tcp') {
      issues.push({
        code: 'option_not_supported',
        subjects: [pool.key],
        message:
          `풀 '${pool.key}' 는 ${pool.protocolClass} 인데 sendProxyProtocol 이 켜져 있다. ` +
          `PROXY 송신은 tcp 에만 있다 (§4.7)`,
      });
    }
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

    const cls = classOfListener(l.protocol);

    // 라우트가 없는 리스너는 기본 풀이 유일한 목적지다. 없으면 렌더에서 **통째로 빠진다** —
    // 저장도 되고 `nginx -t` 도 통과하는데 그 포트만 열리지 않는다.
    // 비활성 리스너도 검사한다. 켜는 순간 구멍이 되는 것을 저장 시점에 막아야 한다.
    if (!routesTraffic(l.protocol) && l.defaultPool === undefined) {
      issues.push({
        code: 'listener_requires_default_pool',
        subjects: [l.key],
        message:
          `${l.protocol} 리스너 '${l.key}' 에는 라우트 매칭이 없다. 기본 풀이 없으면 ` +
          `트래픽이 갈 곳이 없고 렌더 결과에서 조용히 빠진다`,
      });
    }
    // 반대로 라우트로 가르는 리스너의 기본 풀은 **어느 쪽이 이기는지 모른다.**
    if (routesTraffic(l.protocol) && l.defaultPool !== undefined) {
      issues.push({
        code: 'option_not_supported',
        subjects: [l.key],
        message:
          `${l.protocol} 리스너 '${l.key}' 는 라우트로 목적지를 가른다. 기본 풀과 라우트가 ` +
          `함께 있으면 어느 쪽이 이기는지 모델만 보고 알 수 없다`,
      });
    }

    // 프로토콜에 없는 옵션은 렌더러가 조용히 버린다. 표현 가능하면 언젠가 들어온다.
    const notHere = (field: string, when: boolean): void => {
      if (!when) return;
      issues.push({
        code: 'option_not_supported',
        subjects: [l.key],
        message: `${l.protocol} 리스너 '${l.key}' 에 '${field}' 는 의미가 없다`,
      });
    };
    notHere('acceptProxyProtocol', l.protocol === 'udp' && l.acceptProxyProtocol !== undefined);
    notHere('http', l.protocol !== 'http' && l.http !== undefined);
    notHere('udp', l.protocol !== 'udp' && l.udp !== undefined);
    notHere('onUnmatchedSni', l.protocol !== 'tls_passthrough' && l.onUnmatchedSni !== undefined);
    notHere('prereadTimeoutS', l.protocol !== 'tls_passthrough' && l.prereadTimeoutS !== undefined);

    if (l.defaultPool !== undefined) needPool(l.key, l.defaultPool, cls);
    if (l.protocol === 'tls_passthrough') {
      const o = l.onUnmatchedSni;
      if (o !== undefined && o !== 'reject') needPool(l.key, o.pool, 'tcp');
    }
    if (l.protocol === 'http' && l.http?.defaultAction !== undefined) {
      const a = l.http.defaultAction;
      if (a !== 'reject') needPool(l.key, a.pool, 'http');
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
  const listenerByKey = new Map(model.listeners.map((l) => [l.key, l]));

  /**
   * 라우트가 자기 프로토콜의 리스너를 가리키는지 본다.
   *
   * HTTP 라우트를 TCP 리스너에 붙이면 렌더러는 그 라우트를 **어디에도 넣지 않는다.**
   * stream 서버 블록에는 `server_name` 이 없기 때문이다. 저장은 되고 라우트만 사라진다.
   */
  const wantProtocol = (routeKey: string, listenerKey: string, want: RawListener['protocol']): boolean => {
    const l = listenerByKey.get(listenerKey);
    if (l === undefined || l.protocol === want) return true;
    issues.push({
      code: 'route_protocol_mismatch',
      subjects: [routeKey, listenerKey],
      message:
        `라우트 '${routeKey}' 는 ${want} 용인데 리스너 '${listenerKey}' 는 ${l.protocol} 다. ` +
        `렌더 결과에서 이 라우트는 사라진다`,
    });
    return false;
  };

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
    if (r.action.kind === 'proxy') needPool(r.key, r.action.pool, 'http');
    if (!wantProtocol(r.key, r.listener, 'http')) continue;
    r.hosts.forEach((h, i) => addRoute(r.listener, `${r.key}#${i}`, h, r.priority, r.pathPrefix));
  }
  for (const r of model.passthroughRoutes) {
    if (r.action.kind === 'proxy') needPool(r.key, r.action.pool, 'tcp');
    if (!wantProtocol(r.key, r.listener, 'tls_passthrough')) continue;
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
