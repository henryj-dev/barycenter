/**
 * 렌더러·검증기가 받는 입력 타입.
 *
 * ⚠️ **이건 DESIGN.md §4 의 확정 스키마가 아니다.** §12.0 스파이크 게이트를 통과하기 전까지
 * 타입·API·DB 스키마는 고정하지 않는다. 여기 있는 것은 "엔진이 이미 답을 정해 준 부분"에
 * 한정한 최소 부분집합이고, `topology_epoch` · changeset · ApplyOperation 같은 미확정 개념에
 * 의존하지 않는다. 그래서 스파이크 결과가 뒤집혀도 이 모듈들은 살아남는다.
 */

export type ProtocolClass = 'http' | 'tcp' | 'udp';

export type ListenerProtocol = 'http' | 'https' | 'tls_passthrough' | 'tcp' | 'udp';

export type UdpPreset = 'dns' | 'wireguard' | 'game_generic' | 'custom';

/** SNI 결과 분기. §4.1 — no-SNI 와 no-match 는 합치지 않는다. */
export type SniOutcome = 'reject' | { pool: string };

export type Listener = {
  key: string;
  protocol: ListenerProtocol;
  bind: string;
  port: number;
  enabled: boolean;
  /** tcp / udp 는 라우트 매칭이 없으므로 필수. */
  defaultPool?: string;
  /**
   * 앞단 LB 가 보낸 PROXY 헤더를 받는다. UDP 는 엔진이 지원하지 않는다 (§4.7).
   * 실제 계약(신뢰 CIDR 등)은 §4.7 의 InboundProxyProtocol 이지만, 렌더러가 알아야 하는
   * 것은 "받는가" 하나뿐이라 여기서는 그것만 갖는다.
   */
  acceptProxyProtocol?: boolean;
  udp?: { preset: UdpPreset };
  /** tls_passthrough 전용 */
  onNoSni?: SniOutcome;
  onNoMatch?: SniOutcome;
  prereadTimeoutS?: number;
};

export type Algorithm = 'round_robin' | 'least_conn' | 'source_ip_hash' | 'hash';

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

export type Model = {
  listeners: Listener[];
  httpRoutes: HttpRoute[];
  passthroughRoutes: PassthroughRoute[];
  pools: Pool[];
  backends: Backend[];
};
