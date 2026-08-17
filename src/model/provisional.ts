/**
 * 렌더러·검증기가 받는 입력 타입.
 *
 * ⚠️ **이건 DESIGN.md §4 의 확정 스키마가 아니다.** §12.0 스파이크 게이트를 통과하기 전까지
 * 타입·API·DB 스키마는 고정하지 않는다. 여기 있는 것은 "엔진이 이미 답을 정해 준 부분"에
 * 한정한 최소 부분집합이고, `topology_epoch` · changeset · ApplyOperation 같은 미확정 개념에
 * 의존하지 않는다. 그래서 스파이크 결과가 뒤집혀도 이 모듈들은 살아남는다.
 */

export type ProtocolClass = 'http' | 'tcp' | 'udp';

/**
 * **`https` 는 없다.** 렌더러가 TLS 종단을 내지 못하는데 타입으로 제공하면, v3 처럼
 * `protocol: 'https'` 가 평문 `listen 443;` 으로 렌더된다. S16(SNI 별 TLS policy)·
 * S17(인증서 선택)이 통과하고 실제 TLS 렌더러가 생긴 뒤에 되살린다.
 */
export type ListenerProtocol = 'http' | 'tls_passthrough' | 'tcp' | 'udp';

export type UdpPreset = 'dns' | 'wireguard' | 'game_generic' | 'custom';

/**
 * 인바운드 PROXY protocol 수신 (§4.7).
 *
 * **불리언이 아니다.** `trustedCidrs` 없이는 "켠다" 를 **표현할 수가 없다** — 이 저장소가
 * 반복해서 배운 것이 *"표현 가능한 것은 언젠가 들어온다"* 이고, 신뢰 경계 없는 PROXY
 * 수신은 표현 가능해서는 안 되는 것이다.
 *
 * 왜 필수인가 — 엔진으로 실측했다(E63):
 *
 * | 설정 | `$remote_addr` | `$proxy_protocol_addr` |
 * |---|---|---|
 * | realip 없음 | 실제 peer | **헤더가 말하는 값** |
 * | peer 를 신뢰 | 헤더 값 | 헤더 값 |
 * | peer 를 불신 | **실제 peer** | 헤더 값 |
 *
 * **`$proxy_protocol_addr` 는 어떤 경우에도 게이팅되지 않는다.** 신뢰 경계는 오직
 * realip 을 거친 `$remote_addr` 에만 걸린다. 그래서 그 변수로 해시하거나 로깅하면
 * 값을 **클라이언트가 정한다** — 원하는 백엔드로 자기를 몰 수 있다.
 */
export type InboundProxyProtocol = {
  /**
   * PROXY 헤더를 믿어 줄 앞단의 CIDR 목록. **비어 있을 수 없다** (§4.7).
   *
   * 여기 적힌 대역에서 온 연결에 대해서만 `$remote_addr` 가 헤더 값으로 바뀐다.
   */
  trustedCidrs: string[];
};


/**
 * 유효한 SNI 인데 매칭이 없을 때의 동작. §4.1
 *
 * SNI 부재와 파싱 실패(비-TLS 포함)는 **설정 대상이 아니다** — 언제나 reject 다.
 * 설정 가능한 폴백 풀로 보내면, SNI 를 안 보내는 클라이언트가 조용히 임의 백엔드에
 * 도달한다. $ssl_preread_protocol 로 구분은 가능하지만(E26.1) v0 은 동작이 같으므로
 * 분기를 만들지 않는다.
 */
export type SniOutcome = 'reject' | { pool: string };

type ListenerBase = {
  key: string;
  bind: string;
  port: number;
  enabled: boolean;
};

/**
 * **신뢰할 수 없는 입력.** JSON·DB·API 에서 온 그대로의 모양이다.
 *
 * 검증기는 이걸 받는다. 검증기가 이미 좁혀진 타입을 받으면 정작 막아야 할 조합을
 * 표현할 수가 없어서 아무것도 검사하지 못한다 — 타입이 런타임 입력을 대신하지 못한다.
 */
export type RawListener = ListenerBase & {
  protocol: ListenerProtocol;
  defaultPool?: string;
  acceptProxyProtocol?: InboundProxyProtocol;
  udp?: { preset: UdpPreset };
  http?: HttpProfile;
  onUnmatchedSni?: SniOutcome;
  prereadTimeoutS?: number;
};

export type HttpListener = ListenerBase & {
  protocol: 'http';
  acceptProxyProtocol?: InboundProxyProtocol;
  http?: HttpProfile;
};

export type PassthroughListener = ListenerBase & {
  protocol: 'tls_passthrough';
  acceptProxyProtocol?: InboundProxyProtocol;
  onUnmatchedSni?: SniOutcome;
  prereadTimeoutS?: number;
};

export type TcpListener = ListenerBase & {
  protocol: 'tcp';
  defaultPool: string;
  acceptProxyProtocol?: InboundProxyProtocol;
};

export type UdpListener = ListenerBase & {
  protocol: 'udp';
  defaultPool: string;
  udp: { preset: UdpPreset };
};

export type Listener = HttpListener | PassthroughListener | TcpListener | UdpListener;

/**
 * `least_conn` 은 v0 에 없다. stream/http OSS 에 네이티브로 있지만, S1 이 통과해 Lua
 * 밸런서 경로가 확정된 이상 그 경로에서는 워커별 근사가 된다. 정확한 것처럼 보이는
 * 이름으로 근사를 파느니 빼는 편이 낫다. S6 이 오차를 재고 나서 되살릴지 정한다.
 */
/**
 * `default_server` 의 동작. E32 로 실측: 명시하지 않으면 모르는 Host 가 **첫 번째 server**
 * 로 조용히 들어간다. 멀티테넌트에서는 테넌트 간 누수다. 기본은 끊는 것이다.
 */
export type HttpProfile = {
  defaultAction?: 'reject' | { pool: string };
};

export type Algorithm = 'round_robin' | 'source_ip_hash' | 'hash';

export type Pool = {
  key: string;
  protocolClass: ProtocolClass;
  algorithm: Algorithm;
  hashKey?: string;
  /** §4.7 — http 는 엔진에 송신 디렉티브 자체가 없고, udp 는 미지원. tcp 만 v1. */
  sendProxyProtocol?: 'v1';
};

export type Backend = {
  key: string;
  pool: string;
  host: string;
  port: number;
  weight: number;
};

export type HttpAction =
  | { kind: 'proxy'; pool: string; websocket: boolean }
  | { kind: 'redirect'; to: string; status: 301 | 302 | 307 | 308 }
  | { kind: 'reject'; status: 403 | 404 | 444 };

export type HttpRoute = {
  key: string;
  listener: string;
  hosts: string[];
  priority: number;
  pathPrefix?: string;
  action: HttpAction;
};

/** 패스스루는 TLS 를 종단하지 않으므로 HTTP status 를 가질 수 없다. */
export type PassthroughAction = { kind: 'proxy'; pool: string } | { kind: 'reject' };

export type PassthroughRoute = {
  key: string;
  listener: string;
  snis: string[];
  priority: number;
  action: PassthroughAction;
};

/**
 * **검증을 통과한 모델.** 렌더러는 이것만 받는다.
 *
 * 리스너가 판별 유니온이라 프로토콜에 없는 필드는 **표현 자체가 안 된다.** UDP 리스너에
 * `acceptProxyProtocol` 을 넣으면 컴파일이 막힌다 — 5차 검수가 재현한 조합이다.
 * 런타임 입력은 타입이 못 막으므로 `validateModel` 이 같은 규칙을 다시 검사한다.
 */
export type Model = {
  listeners: Listener[];
  httpRoutes: HttpRoute[];
  passthroughRoutes: PassthroughRoute[];
  pools: Pool[];
  backends: Backend[];
};

/** 검증 전 모델. `validateModel` 의 입력이다. */
export type RawModel = Omit<Model, 'listeners'> & { listeners: RawListener[] };
