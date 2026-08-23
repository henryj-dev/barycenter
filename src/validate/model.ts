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
import { ACME_PREFIX } from '../conf/render.js';
import { coversHost, parseHashKey, parseHostPattern, validatePathPrefix } from './strings.js';
import type {
  RawListener, RawModel, ProtocolClass, SniCertificateBinding,
} from '../model/provisional.js';

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
  | 'option_not_supported'
  /** https 리스너가 존재하지 않는 TLS 정책·인증서를 참조한다. */
  | 'unknown_tls_reference'
  /** SNI 바인딩이 https 가 아닌 리스너에 붙었다. */
  | 'sni_binding_protocol_mismatch'
  /** https 리스너의 라우트 호스트를 덮는 SNI 바인딩이 없다 — 제시할 인증서가 없다. */
  | 'sni_binding_missing'
  /** 같은 리스너에서 한 호스트가 두 인증서에 묶였다. */
  | 'sni_binding_conflict'
  /** SNI 바인딩 호스트가 exact 도 1라벨 와일드카드도 아니다. */
  | 'invalid_sni_host'
  /** 사용자 라우트가 ACME http-01 예약 경로를 가로챈다 (§8.2). */
  | 'acme_path_reserved'
  /** 자료 없는 인증서를 바인딩했다 — ACME 발급 전이다. */
  | 'certificate_has_no_material'
  /** ACME 의도가 자기 도메인을 안 덮거나 모양이 틀렸다. */
  | 'invalid_acme_intent'
  /** HSTS preload 요구조건을 안 지켰다 (§4.6). */
  | 'invalid_hsts'
  // ── 아래는 런타임 해독기(`src/model/decode.ts`)가 낸다 ──
  /** 타입이 다르다. 강제 변환하지 않는다. */
  | 'invalid_type'
  /** 아는 enum 값이 아니다. */
  | 'invalid_enum'
  /** 필수 필드가 없다. */
  | 'missing_field'
  /** 모르는 필드다 — 조용히 무시하면 오타가 설정을 날린다. */
  | 'unknown_field'
  /** 숫자가 허용 범위 밖이다. */
  | 'out_of_range';

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
  protocol === 'http' || protocol === 'https' ? 'http' : protocol === 'udp' ? 'udp' : 'tcp';

/** 라우트로 목적지를 가르는 리스너. 나머지는 기본 풀이 유일한 목적지다. */
const routesTraffic = (protocol: RawListener['protocol']): boolean =>
  protocol === 'http' || protocol === 'https' || protocol === 'tls_passthrough';

/** 렌더 결과에 영향을 주는 엔진 capability 중, 검증이 알아야 하는 것. */
export type ValidationCapabilities = { streamRealip: boolean; http2?: boolean };

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
    /**
     * **HTTP 헬스체크는 http 풀에만** (검수 B-07). stream 에는 요청 개념이 없어 프로버가
     * 연결만 보므로, 여기 적힌 경로·상태·본문은 **아무도 안 읽는다** — 표현 가능하면
     * 언젠가 들어오고, 들어오면 조용히 무시된다.
     */
    if (pool.healthCheck !== undefined && pool.protocolClass !== 'http') {
      issues.push({
        code: 'option_not_supported',
        subjects: [pool.key],
        message:
          `풀 '${pool.key}' 는 ${pool.protocolClass} 인데 healthCheck 가 있다. ` +
          `HTTP 헬스체크는 http 풀에만 있다 — stream 프로버는 연결만 본다`,
      });
    }
    // 경로는 `location` 이 아니라 요청 경로지만, 같은 문법으로 좁힌다 — 절대 경로여야 한다.
    const probePath = pool.healthCheck?.path;
    if (probePath !== undefined) {
      const parsed = validatePathPrefix(probePath);
      if (!parsed.ok) {
        issues.push({
          code: 'option_not_supported',
          subjects: [pool.key],
          message: `풀 '${pool.key}' 의 healthCheck.path: ${parsed.message}`,
        });
      }
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
    // **https 도 `http` 프로필을 쓴다.** TLS 를 종단하고 나면 평범한 HTTP 다.
    notHere('http', l.protocol !== 'http' && l.protocol !== 'https' && l.http !== undefined);
    notHere('tls', l.protocol !== 'https' && l.tls !== undefined);
    // **h2c 는 동작한다** (§4.9 실측). 그래도 안 여는 이유는 브라우저가 안 쓰기
    // 때문이고, 그건 "표현 불가" 가 아니라 **의도된 배제**다.
    notHere('http2', l.protocol !== 'https' && l.http2 !== undefined);

    // **켜 달라고 했는데 엔진이 못 하면 막는다.** 조용히 무시하면 "켰는데 h2 가 안
    // 나온다" 가 되고, 원인은 설정 어디에도 안 보인다. 기본값이 못 걸리는 것은 다른
    // 이야기다 — 그건 capability 로 관측된다.
    if (l.protocol === 'https' && l.http2 === true && caps.http2 !== true) {
      issues.push({
        code: 'option_not_supported',
        subjects: [l.key],
        message:
          `리스너 '${l.key}' 가 http2 를 요구하는데 엔진이 못 낸다 — ` +
          `ngx_http_v2_module 과 nginx 1.25.1+ 가 함께 필요하다 (§4.9 · §7.6)`,
      });
    }
    notHere('udp', l.protocol !== 'udp' && l.udp !== undefined);
    notHere('onUnmatchedSni', l.protocol !== 'tls_passthrough' && l.onUnmatchedSni !== undefined);
    notHere('prereadTimeoutS', l.protocol !== 'tls_passthrough' && l.prereadTimeoutS !== undefined);

    if (l.defaultPool !== undefined) needPool(l.key, l.defaultPool, cls);
    if (l.protocol === 'tls_passthrough') {
      const o = l.onUnmatchedSni;
      if (o !== undefined && o !== 'reject') needPool(l.key, o.pool, 'tcp');
    }
    if ((l.protocol === 'http' || l.protocol === 'https') && l.http?.defaultAction !== undefined) {
      const a = l.http.defaultAction;
      if (a !== 'reject') needPool(l.key, a.pool, 'http');
    }
  }

  for (const c of findSocketConflicts(reservations)) {
    issues.push({ code: 'socket_conflict', subjects: [c.a, c.b], message: c.reason });
  }

  // ── stream 에서 PROXY 를 받으려면 stream_realip 이 있어야 한다 (§4.7 · §7.6 · E63) ──
  //
  // **전에는 없어도 됐다 — 그게 문제였다.** `stream_realip` 이 없으면 소스IP 해시를
  // `$proxy_protocol_addr` 로 렌더했는데, E63 으로 재보니 그 변수는 realip 설정과 무관하게
  // **언제나 헤더가 말하는 값**이다. 신뢰 경계는 오직 realip 을 거친 `$remote_addr` 에만
  // 걸린다. 즉 열등한 대체물이 아니라 **클라이언트가 정하는 값**으로 백엔드를 고르고
  // 있었다 — 원하는 peer 로 자기를 몰 수 있다.
  //
  // 이제 렌더러는 언제나 `set_real_ip_from` 을 함께 낸다. 그 디렉티브를 모르는 엔진에서는
  // `nginx -t` 가 실패하므로 어차피 못 쓴다. **게시 전에 실패하는 것보다 저장에서 막는
  // 편이 낫다** — 운영자가 plan 단계에서 알게 된다.
  for (const l of model.listeners) {
    // **https 는 stream 이 아니다.** 여기서 `http` 만 빼고 있었고, 그래서 https 의 PROXY
    // 수신이 `stream_realip` 을 요구했다 — OpenResty 에는 그 모듈이 없으므로 조합 자체가
    // 저장 불가였다. https 는 http 컨텍스트에서 서빙되고 `http_realip_module` 을 쓴다
    // (검수 S-02, 렌더러의 `realipNodes` 와 같은 기준이어야 한다).
    if (!l.enabled || l.protocol === 'udp'
      || l.protocol === 'http' || l.protocol === 'https') continue;
    if (l.acceptProxyProtocol === undefined) continue;
    if (caps.streamRealip) continue;
    issues.push({
      code: 'option_not_supported',
      subjects: [l.key],
      message:
        `리스너 '${l.key}' 가 stream 에서 PROXY 를 받으려 하는데 엔진에 stream_realip 이 없다. ` +
        `그러면 신뢰 경계를 걸 수 없고, 걸지 못한 채로 받으면 클라이언트가 자기 IP 를 정한다. ` +
        `stream_realip 이 있는 엔진을 쓰거나 이 리스너에서 PROXY 수신을 끈다.`,
    });
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
  const wantProtocol = (
    routeKey: string,
    listenerKey: string,
    want: readonly RawListener['protocol'][],
  ): boolean => {
    const l = listenerByKey.get(listenerKey);
    if (l === undefined || want.includes(l.protocol)) return true;
    issues.push({
      code: 'route_protocol_mismatch',
      subjects: [routeKey, listenerKey],
      message:
        `라우트 '${routeKey}' 는 ${want.join('/')} 용인데 리스너 '${listenerKey}' 는 ${l.protocol} 다. ` +
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
    // **https 도 http 라우트를 받는다.** TLS 를 종단하고 나면 평범한 HTTP 다.
    if (!wantProtocol(r.key, r.listener, ['http', 'https'])) continue;
    r.hosts.forEach((h, i) => addRoute(r.listener, `${r.key}#${i}`, h, r.priority, r.pathPrefix));
  }
  for (const r of model.passthroughRoutes) {
    if (r.action.kind === 'proxy') needPool(r.key, r.action.pool, 'tcp');
    if (!wantProtocol(r.key, r.listener, ['tls_passthrough'])) continue;
    r.snis.forEach((h, i) => addRoute(r.listener, `${r.key}#${i}`, h, r.priority));
  }

  // ── ACME 예약 경로 (§8.2 · ADR-ACME) ────────────────────────────────────
  //
  // *"시스템 소유 예약 라우트로 렌더되고 사용자가 만들거나 지울 수 없다."*
  //
  // **가로채면 발급이 조용히 실패한다.** 렌더러가 `^~` 로 내지만 그건 정규식만 막는다 —
  // nginx 의 location 은 **최장 접두사**가 이기므로 사용자가 더 긴 접두사를 내면 그쪽이
  // 먹는다. 그러면 CA 의 요청이 사용자 라우트로 가고, 증상은 "챌린지 검증 실패" 다.
  // 인증서 설정을 아무리 봐도 이상이 없어 보인다.
  for (const r of model.httpRoutes) {
    const path = r.pathPrefix;
    if (path === undefined) continue;
    // 위쪽 경로(`/.well-known/`)는 허용한다 — 더 짧은 접두사라 `^~` 가 이긴다.
    if (path === ACME_PREFIX || path.startsWith(ACME_PREFIX)) {
      issues.push({
        code: 'acme_path_reserved',
        subjects: [r.key],
        message:
          `라우트 '${r.key}' 의 경로 '${path}' 는 ACME http-01 예약 경로다. ` +
          `여기를 가로채면 인증서 발급이 조용히 실패한다 (§8.2)`,
      });
    }
  }

  // ── TLS (§4.6, S16·S17) ─────────────────────────────────────────────────
  //
  // 렌더러는 여기서 막힌 것들에 대해 **터진다.** 조용히 default 인증서를 물리면
  // SAN 미커버 제시가 되고, 그게 S17 합격 기준이 겨눈 실패다.
  {
    const certKeys = new Set(model.certificates.map((c) => c.key));
    const policyKeys = new Set(model.tlsPolicies.map((t) => t.key));

    for (const l of model.listeners) {
      if (l.protocol !== 'https') continue;
      // **RawModel 은 `tls` 없는 https 리스너를 표현할 수 있다.** 해독기도 잡지만
      // (`missing_field`), 검증기가 그걸 전제로 크래시하면 안 된다 — 둘은 각자 완결이다.
      if (l.tls === undefined) {
        issues.push({
          code: 'missing_field',
          subjects: [l.key],
          message: `https 리스너 '${l.key}' 에 tls 결박이 없다. 제시할 인증서가 정해지지 않는다`,
        });
        continue;
      }
      if (!policyKeys.has(l.tls.policy)) {
        issues.push({
          code: 'unknown_tls_reference',
          subjects: [l.key],
          message: `리스너 '${l.key}' 가 존재하지 않는 TLS 정책 '${l.tls.policy}' 를 참조한다`,
        });
      }
      if (!certKeys.has(l.tls.defaultCertificate)) {
        issues.push({
          code: 'unknown_tls_reference',
          subjects: [l.key],
          message:
            `리스너 '${l.key}' 가 존재하지 않는 인증서 '${l.tls.defaultCertificate}' 를 ` +
            `default 인증서로 참조한다`,
        });
      }
    }

    // **자료 없는 인증서는 바인딩할 수 없다.**
    //
    // ACME 로 관리되는 인증서는 첫 발급 전에 자료가 없다. 그건 정당한 상태이고 모델이
    // 표현해야 하지만, **렌더러가 낼 것이 없다** — 그대로 두면 세대가 `nginx -t` 에서
    // "파일이 없다" 로 죽고 원인은 apply 실패로만 보인다.
    //
    // 그래서 첫 발급은 두 단계다: ① 의도만 커밋 → 발급 ② 발급된 참조로 바인딩.
    const noMaterial = new Set(
      model.certificates.filter((c) => c.materialRef === undefined).map((c) => c.key));

    const usedBy = (certKey: string, subject: string): void => {
      if (!noMaterial.has(certKey)) return;
      issues.push({
        code: 'certificate_has_no_material',
        subjects: [subject, certKey],
        message:
          `'${subject}' 가 자료 없는 인증서 '${certKey}' 를 쓴다. ACME 발급 전이라 ` +
          `제시할 것이 없다 — 발급된 뒤에 바인딩한다`,
      });
    };

    for (const l of model.listeners) {
      if (l.protocol !== 'https' || l.tls === undefined) continue;
      usedBy(l.tls.defaultCertificate, `리스너 '${l.key}'`);
    }

    // ACME 의도의 모양. 도메인이 비어 있으면 스케줄러가 무엇을 주문할지 모른다.
    for (const c of model.certificates) {
      const acme = c.acme;
      if (acme === undefined) continue;
      if (acme.domains.length === 0) {
        issues.push({
          code: 'invalid_acme_intent',
          subjects: [c.key],
          message: `인증서 '${c.key}' 의 ACME 의도에 도메인이 없다`,
        });
      }
      for (const d of acme.domains) {
        const parsed = parseHostPattern(d);
        if (!parsed.ok) {
          issues.push({
            code: 'invalid_acme_intent',
            subjects: [c.key],
            message: `인증서 '${c.key}' 의 ACME 도메인 '${d}': ${parsed.message}`,
          });
        }
      }
    }

    // **HSTS preload 는 되돌리는 데 수개월이 걸린다.** 브라우저 빌드에 구워지기 때문이다.
    // 목록의 요구조건을 안 지킨 채 제출하면 거절되거나, 더 나쁘게는 준비 안 된
    // 서브도메인이 함께 등재된다. 저장 시점에 막는다.
    for (const t of model.tlsPolicies) {
      const h = t.hsts;
      if (h?.preload !== true) continue;
      if (h.maxAgeSeconds < 31_536_000) {
        issues.push({
          code: 'invalid_hsts',
          subjects: [t.key],
          message:
            `TLS 정책 '${t.key}' 가 HSTS preload 를 요구하는데 max-age 가 ` +
            `${h.maxAgeSeconds} 초다 — preload 목록은 1년(31536000) 이상을 요구한다`,
        });
      }
      if (h.includeSubdomains !== true) {
        issues.push({
          code: 'invalid_hsts',
          subjects: [t.key],
          message:
            `TLS 정책 '${t.key}' 가 HSTS preload 를 요구하는데 includeSubdomains 가 없다 — ` +
            `preload 목록이 요구한다`,
        });
      }
    }

    const bindingsByListener = new Map<string, SniCertificateBinding[]>();
    for (const b of model.sniBindings) {
      const l = listenerByKey.get(b.listener);
      if (l === undefined) {
        issues.push({
          code: 'unknown_listener',
          subjects: [b.key],
          message: `SNI 바인딩 '${b.key}' 가 존재하지 않는 리스너 '${b.listener}' 를 참조한다`,
        });
        continue;
      }
      if (l.protocol !== 'https') {
        issues.push({
          code: 'sni_binding_protocol_mismatch',
          subjects: [b.key, b.listener],
          message:
            `SNI 바인딩 '${b.key}' 가 ${l.protocol} 리스너 '${b.listener}' 에 붙었다. ` +
            `TLS 를 종단하지 않는 리스너는 인증서를 제시하지 않는다`,
        });
        continue;
      }
      if (!certKeys.has(b.certificate)) {
        issues.push({
          code: 'unknown_tls_reference',
          subjects: [b.key],
          message: `SNI 바인딩 '${b.key}' 가 존재하지 않는 인증서 '${b.certificate}' 를 참조한다`,
        });
      }
      usedBy(b.certificate, `SNI 바인딩 '${b.key}'`);
      // **호스트 모양.** exact 아니면 `*.suffix` 1라벨 와일드카드뿐이다. `*.a.*.b` 나
      // 맨 `*` 를 허용하면 렌더가 낼 정규식이 없다.
      for (const h of b.hosts) {
        const parsed = parseHostPattern(h);
        if (!parsed.ok) {
          issues.push({
            code: 'invalid_sni_host',
            subjects: [b.key],
            message: `SNI 바인딩 '${b.key}' 의 호스트 '${h}': ${parsed.message}`,
          });
        }
      }
      const list = bindingsByListener.get(b.listener) ?? [];
      list.push(b);
      bindingsByListener.set(b.listener, list);
    }

    // **같은 호스트가 두 인증서에 묶이면 설정이 답을 못 한다.** nginx 는 경고만 내고
    // 첫 블록에 준다 (E36 의 TLS 판) — `nginx -t` 는 통과하므로 조용한 오동작이다.
    for (const [listener, list] of bindingsByListener) {
      const seen = new Map<string, string>();
      for (const b of list) {
        for (const h of b.hosts) {
          const prev = seen.get(h);
          if (prev !== undefined && prev !== b.certificate) {
            issues.push({
              code: 'sni_binding_conflict',
              subjects: [listener, h],
              message:
                `리스너 '${listener}' 에서 호스트 '${h}' 가 인증서 '${prev}' 와 ` +
                `'${b.certificate}' 둘에 묶였다. 어느 쪽이 제시되는지 설정이 정하지 못한다`,
            });
          }
          seen.set(h, b.certificate);
        }
      }
    }

    // **라우트 호스트마다 인증서가 있어야 한다.** 없으면 렌더러가 그 server 블록에 낼
    // 인증서가 없다 — default 로 물리면 SAN 미커버 제시가 된다 (S17).
    for (const r of model.httpRoutes) {
      const l = listenerByKey.get(r.listener);
      if (l === undefined || l.protocol !== 'https') continue;
      const list = bindingsByListener.get(r.listener) ?? [];
      for (const h of r.hosts) {
        if (list.some((b) => b.hosts.some((p) => coversHost(p, h)))) continue;
        issues.push({
          code: 'sni_binding_missing',
          subjects: [r.key, h],
          message:
            `리스너 '${r.listener}' 의 호스트 '${h}' 를 덮는 SNI 바인딩이 없다. ` +
            `handshake 에서 제시할 인증서가 정해지지 않는다`,
        });
      }
    }
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
