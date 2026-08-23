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
 * **`https` 가 돌아왔다 (2026-08-17).** 한동안 일부러 빼 뒀다 — 렌더러가 TLS 종단을
 * 내지 못하는데 타입으로 제공하면, v3 처럼 `protocol: 'https'` 가 평문 `listen 443;`
 * 으로 렌더되기 때문이다. 되살리는 조건으로 걸어 둔 **S16(SNI 별 TLS policy)·S17(인증서
 * 선택)이 통과했고**(§12.0), 그 결과가 렌더 규칙 셋으로 내려왔다:
 *
 *   ① 와일드카드 `server_name` 은 `~^[^.]+\.suffix$` 앵커 정규식 — `*.x` 는 다중 라벨을
 *      삼켜 **SAN 미커버 인증서 제시**가 된다 (E22.2).
 *   ② TLS 리스너마다 `default_server` 를 반드시 낸다 — 없으면 모르는 SNI 가 첫 블록의
 *      인증서를 받는다 (E32 의 TLS 판).
 *   ③ TLS policy 는 **각 server 블록 안**에 낸다 — server 레벨이 http 레벨을 덮고,
 *      SNI 별로 실제 handshake 에 걸린다.
 */
export type ListenerProtocol = 'http' | 'https' | 'tls_passthrough' | 'tcp' | 'udp';

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


export type TlsVersion = '1.2' | '1.3';

/**
 * 암호군 정책 — **버전된 참조지 자유 문자열이 아니다** (§4.6).
 *
 * 자유 문자열이면 오타가 조용히 TLS 를 약하게 만든다. `ECDHE-RSA-AES128-GCM-SHA256` 을
 * `ECDHE-RSA-AES128-GCM-SHA255` 로 적으면 nginx 는 **그 이름을 그냥 무시하고** 남은
 * 목록으로 협상한다 — 설정에는 있는데 안 걸리는 그 모양이다.
 *
 * **이름에 연도가 붙는 이유**: 권고 목록은 바뀐다. `modern` 의 내용을 조용히 갈면 같은
 * 설정이 어느 날 다른 암호군을 쓰게 되고, 그건 재현 가능한 배포가 아니다. 내용이 바뀌면
 * **새 이름**을 만든다.
 */
export type CipherPolicyRef = 'modern-2026' | 'intermediate-2026';

/**
 * 인증서 **메타데이터**. §4.8 · §8.1
 *
 * **자료가 여기 없다.** `materialRef` 는 SecretStore 의 불변 버전 참조
 * (`store://<name>@<version>`) 이고, 개인키는 그 뒤에 있다 — 메인 DB 에도, 이 타입에도,
 * API 응답에도 들어가지 않는다.
 *
 * 왜 **버전**이 참조에 붙어야 하는가 — S8 이 실측했다. 이름만으로 가리키면 갱신이
 * 덮어써서, conf 를 롤백해도 **갱신된 인증서가 그대로 제시된다.** 롤백이 거짓말이 된다.
 */
export type Certificate = {
  key: string;
  /**
   * `store://<name>@<version>`. 버전 없는 참조는 여기 못 들어온다.
   *
   * **없을 수 있다** — ACME 로 관리되는 인증서는 **첫 발급 전에 자료가 없다.** 그걸
   * 표현 못 하면 *"인증서를 받으려면 인증서가 있어야 한다"* 가 된다.
   *
   * 대신 **자료 없는 인증서는 바인딩할 수 없다** (검증기가 막는다). 렌더러가 낼 것이
   * 없기 때문이고, 그래서 첫 발급은 두 단계다:
   *
   *   ① `acme` 의도만 담은 인증서를 커밋한다 → 스케줄러가 발급한다
   *   ② 발급된 참조로 리스너·SNI 바인딩을 커밋한다
   *
   * 자체서명 임시 인증서를 자동으로 만들어 끼우는 길도 있지만 안 골랐다 — 그러면 **잘못된
   * 인증서가 잠깐 실제로 제시된다.** 그 잠깐이 얼마인지는 발급 성공 여부에 달려 있고,
   * 실패하면 영원이다.
   */
  materialRef?: string;
  /** 자료를 안 읽고도 세대 결박을 검증할 수 있게 함께 든다. 자료가 있으면 함께 있다. */
  chainDigest?: string;
  keyDigest?: string;
  /**
   * ACME 로 관리한다는 **의도** (§8.2 · ADR-ACME).
   *
   * **의도는 설정이고 주문은 운영 상태다.** "이 인증서를 이 도메인들로 자동 갱신한다" 는
   * 사람이 정하는 것이라 리비전에 남고, 그 결과 생기는 주문·챌린지는 `acme_orders` 에
   * 산다 — 리비전에 넣으면 롤백이 진행 중이던 주문을 되살린다(009 주석).
   */
  acme?: AcmeIntent;
};

export type AcmeIntent = {
  /** `AcmeAccount.key`. 어느 CA 계정으로 주문하는가. */
  account: string;
  /** 이 인증서가 덮을 이름들. 와일드카드는 dns-01 만 가능하다 (S18 실측). */
  domains: string[];
};

/**
 * TLS 정책. §4.6
 *
 * S16 이 실측했다 — 이 값들은 **비-default server 블록에서도 실제 handshake 에 걸린다.**
 * 그래서 SNI 별로 다르게 주는 것(`SniCertificateBinding.override`)이 표시만 하고 마는
 * 거짓말이 아니다.
 */
export type TlsPolicy = {
  key: string;
  minVersion: TlsVersion;
  maxVersion?: TlsVersion;
  /**
   * SNI 와 HTTP Host 가 다를 때 (§4.6).
   *
   * **둘은 다를 수 있다.** handshake 는 SNI 로, 요청은 Host 로 server 를 고르므로 —
   * 실측했다:
   *
   * ```
   * SNI=a.test + Host=b.test → 인증서는 a.test, 응답은 **b.test 의 것**
   * ```
   *
   * 그 자체로 권한 상승은 아니다(클라이언트가 처음부터 SNI=b 로 붙을 수 있었다). 위험은
   * **운영자가 "a 의 인증서를 받았으면 a 의 트래픽" 이라고 가정할 때** 생기고, 특히
   * **HTTP/2 가 그 가정을 깬다** — 브라우저는 인증서가 덮는 다른 오리진에 대해 같은
   * 커넥션을 재사용한다(RFC 7540 §9.1.1). 그래서 그 RFC 가 **421 Misdirected Request**
   * 를 답으로 정해 뒀다.
   *
   * 기본은 `allow` 다 — 켜는 쪽을 기본으로 하면 SNI 를 안 보내는 옛 클라이언트나
   * 프록시 뒤의 정당한 트래픽이 끊긴다. 멀티테넌트는 명시적으로 켠다.
   */
  sniHostMismatch?: 'allow' | 'reject_421';
  /**
   * 암호군 정책. 안 적으면 `intermediate-2026` 이다.
   *
   * **TLS1.2 이하와 TLS1.3 은 따로 정해진다** — 실측이다(§4.6):
   *
   * ```
   * ssl_ciphers ECDHE-RSA-AES128-GCM-SHA256  →  TLS1.2 는 그것, TLS1.3 은 TLS_AES_256_GCM_SHA384
   * ```
   *
   * `ssl_ciphers` 가 TLS1.3 에 **안 걸린다.** 그걸 모르고 "약한 암호를 껐다" 고 믿으면
   * 1.3 쪽은 손도 안 댄 것이다. 1.3 은 `ssl_conf_command Ciphersuites` 가 정한다.
   */
  cipherPolicy?: CipherPolicyRef;
  /**
   * HSTS (§4.6). 안 적으면 **안 낸다.**
   *
   * ── 왜 기본이 꺼짐인가 ────────────────────────────────────────────────
   *
   * HSTS 는 **클라이언트 쪽에서 되돌릴 수 없다.** `max-age` 동안 브라우저가 이 도메인을
   * https 로만 가고, 인증서가 깨지면 사용자는 **우회할 방법이 없다**(경고를 무시하고
   * 진행하는 버튼도 사라진다). 설정을 되돌려도 이미 나간 헤더는 회수가 안 된다.
   *
   * 이 저장소의 다른 기본값들과 성질이 다르다 — h2 는 잘못 켜도 끄면 그만이지만
   * 이건 아니다. **켜는 것은 사람이 정한다.**
   */
  hsts?: HstsPolicy;
};

export type HstsPolicy = {
  maxAgeSeconds: number;
  includeSubdomains?: boolean;
  /**
   * 브라우저 **preload 목록**에 넣겠다는 선언.
   *
   * 목록은 브라우저 빌드에 구워지므로 빼는 데 수개월이 걸린다. 그래서 목록의 요구조건
   * (`max-age` ≥ 1년 + `includeSubdomains`)을 **검증기가 강제한다** — 그걸 안 지킨 채
   * 제출하면 거절되거나, 더 나쁘게는 서브도메인이 준비 안 된 채로 등재된다.
   */
  preload?: boolean;
};

/**
 * SNI → 인증서 바인딩. §4.6
 *
 * **라우트에 붙이지 않는다.** v1 의 설계 오류가 그것이었다 — 인증서와 TLS 버전은 HTTP
 * Host/path 를 보기 전에 **SNI 로** 선택된다. 라우트에 두면 같은 host 의 path 별 라우트가
 * 서로 다른 인증서를 갖는 표현이 허용되고, redirect/reject 라우트에도 인증서가 붙는다.
 */
export type SniCertificateBinding = {
  key: string;
  listener: string;
  /** handshake 단계의 선택 키. exact 또는 `*.suffix` 1라벨 와일드카드. */
  hosts: string[];
  certificate: string;
  /** S16 이 성립을 실측했으므로 유지한다. 실패했다면 §12.0 규칙에 따라 없앴을 필드다. */
  override?: { minVersion?: TlsVersion; maxVersion?: TlsVersion };
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
  tls?: RawTlsBinding;
  http2?: boolean;
};

/** 검증 전. `https` 가 아닌 리스너에 붙어 있을 수 있으므로 검증기가 막는다. */
export type RawTlsBinding = { policy: string; defaultCertificate: string };

export type HttpListener = ListenerBase & {
  protocol: 'http';
  acceptProxyProtocol?: InboundProxyProtocol;
  http?: HttpProfile;
};

/**
 * TLS 종단 리스너. §4.6
 *
 * `tls` 가 **선택이 아니다.** 인증서 없는 TLS 리스너는 `nginx -t` 가 거절하는 것을 넘어,
 * "모르는 SNI 에 무엇을 제시할 것인가" 가 비워 둘 수 있는 자리가 아니기 때문이다 —
 * S17 이 실측했듯 `default_server` 가 없으면 **첫 블록의 인증서**가 나가고, 그건
 * 멀티테넌트에서 테넌트 간 누수다.
 */
export type HttpsListener = ListenerBase & {
  protocol: 'https';
  acceptProxyProtocol?: InboundProxyProtocol;
  http?: HttpProfile;
  tls: { policy: string; defaultCertificate: string };
  /**
   * HTTP/2 (§4.9). 안 적으면 **켠다** — 요즘 HTTPS 에서 h2 없이 서비스하는 것은 사실상
   * 결함이다.
   *
   * **https 에만 있다.** 평문에서도 h2c 는 동작하지만(실측), 브라우저가 안 쓰므로
   * 켜 놓고 아무 일도 안 일어난다 — §4.9 가 그 이유를 적었다.
   *
   * 엔진이 못 하는데 `true` 로 명시하면 **검증기가 막는다.** 기본값이 못 걸리는 것은
   * 조용히 넘어가지만, 그건 `/api/v1/status` 의 capability 로 보인다.
   */
  http2?: boolean;
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

export type Listener =
  | HttpListener
  | HttpsListener
  | PassthroughListener
  | TcpListener
  | UdpListener;

/**
 * ── `least_conn` 을 되살린 이유 (S6, 2026-08-23)
 *
 * 전에는 이렇게 적혀 있었다: *"Lua 밸런서 경로가 확정된 이상 그 경로에서는 **워커별
 * 근사**가 된다. 정확한 것처럼 보이는 이름으로 근사를 파느니 빼는 편이 낫다."*
 *
 * **그때는 맞았고, 지금은 아니다.** 그 뒤에 `in:` 카운터가 생겼다 — 드레인 관측(S2)이
 * 넣은 peer 별 inflight 이고, `lua_shared_dict` 에 산다. 이 저장소가 이미 두 번 그
 * 공유성에 기대고 있다: `round_robin` 의 `rr:` 카운터(렌더러 주석이 *"워커 간 공유다.
 * 워커 로컬로 두면 워커 수만큼 편향된다"*), 그리고 멤버십 `slot:`(S1·S5 가 수렴 실측).
 *
 * 그러니 이제 **워커별 근사가 아니다** — 전 워커의 inflight 합을 보고 고른다.
 *
 * ⚠️ 남는 오차는 다른 종류다: 읽고 고르는 사이가 원자적이지 않아 두 워커가 같은 peer
 * 를 동시에 고를 수 있다. nginx 네이티브도 같은 성질이고(공유 zone 에 락을 걸지만 선택
 * 자체는 순간의 값을 본다), **워커 수만큼 편향되는 것**과는 크기가 다르다.
 *
 * 멤버십 평면이 **없는** 엔진에서는 nginx 의 `least_conn;` 을 그대로 쓴다.
 */
/**
 * `default_server` 의 동작. E32 로 실측: 명시하지 않으면 모르는 Host 가 **첫 번째 server**
 * 로 조용히 들어간다. 멀티테넌트에서는 테넌트 간 누수다. 기본은 끊는 것이다.
 */
export type HttpProfile = {
  defaultAction?: 'reject' | { pool: string };
  /**
   * 프록시 타임아웃과 본문 크기 (제안 #8). 없으면 **nginx 기본값**이다.
   *
   * 전에는 셋 다 고정이었다 — `proxy_connect_timeout` 60s · `proxy_read_timeout` 60s ·
   * `client_max_body_size` **1m**. 마지막 것이 특히 물린다: 기본 1m 이라 조금 큰
   * 업로드가 413 으로 죽는데 고칠 손잡이가 없었다.
   *
   * **라우트(location)별로는 안 연다.** nginx 는 거기서도 받지만, 라우트마다 다른 값을
   * 주려면 "어느 라우트가 무엇을 상속받는가" 가 모델에 드러나야 하고 그건 다른 크기의
   * 일이다. 없는 것을 있는 척하지 않는다.
   */
  limits?: ProxyLimits;
  /**
   * 얹을 헤더 (제안 #7). 없으면 아무것도 안 낸다.
   *
   * **자리가 갈린다.** nginx 의 `add_header` 와 `proxy_set_header` 는 둘 다 상속이
   * 아니라 **대체**인데, 렌더러가 이미 낸 것들의 위치가 서로 반대다:
   *
   *   응답 → server   (location 에 내면 상위 HSTS 가 통째로 사라진다)
   *   요청 → location (server 에 내면 기존 `Host`·`X-Forwarded-*` 셋에 지워진다)
   *
   * 그래서 라우트별로 안 연다. 열려면 "이 location 이 무엇을 상속받는가" 를 모델이
   * 표현해야 하고, 그건 nginx 의 대체 규칙을 모델에 통째로 들이는 일이다.
   */
  headers?: HeaderRules;
  /**
   * 레이트리밋과 커넥션 제한 (제안 #6). 없으면 아무 제한도 안 낸다.
   *
   * zone **선언**은 `http` 블록에만 있을 수 있고 **적용**은 server 다. 이름은 리스너
   * 키에서 판다 — 별도 리소스로 만들면 "이 zone 을 누가 쓰나" 가 모델에 또 하나의
   * 참조 그래프가 되는데, 쓰는 쪽이 리스너 하나뿐이라 그 대가에 비해 얻는 것이 없다.
   */
  rateLimit?: RateLimit;
};

/**
 * 레이트리밋·커넥션 제한.
 *
 * **키는 `$binary_remote_addr` 고정이다.** 사용자가 고르게 하면 nginx 변수 표면이
 * 통째로 열리고(§4.9 가 화이트리스트로 좁혀 둔 그것), 얻는 것은 "누구를 세는가" 의
 * 변형뿐이다. realip 뒤라 PROXY protocol 을 쓰는 배포에서도 진짜 클라이언트를 센다.
 *
 * **`burst`·`nodelay` 만 적을 수는 없다.** 무엇의 burst 인지가 없다 — 저장은 되는데
 * 렌더가 못 하는 조합을 만들지 않는다.
 */
export type RateLimit = {
  /**
   * ⚠️ **`return` 으로 끝나는 라우트에는 안 걸린다** (실측, 2026-08-23).
   *
   * nginx 의 단계 순서다: `return` 은 **rewrite**, `limit_req` 는 **preaccess** 인데
   * rewrite 가 앞이다. 그래서 redirect·reject 라우트는 레이트리밋이 돌기 전에 끝난다.
   * 이 저장소가 같은 함정에 두 번 물렸다(`if` 의 단계, ACME 예약 라우트).
   *
   * 고치려면 `return` 을 content 단계로 옮겨야 하고 그건 redirect 한 줄의 대가로는
   * 너무 크다. **사실로 적어 둔다** — `tests/golden/rate-limit.test.ts` 가 못 박는다.
   */
  /** 초당 요청 수 (`rate=Nr/s`). */
  requestsPerSecond?: number;
  /** 순간적으로 넘길 수 있는 양 (`burst=`). `requestsPerSecond` 가 있어야 한다. */
  burst?: number;
  /**
   * burst 를 **지연 없이** 통과시킨다 (`nodelay`).
   *
   * 기본값을 우리가 안 고른다 — 켜고 끄는 차이가 백엔드가 받는 부하의 *모양*을 바꾼다.
   */
  nodelay?: boolean;
  /** 클라이언트당 동시 연결 상한 (`limit_conn`). 자기 zone 을 쓴다. */
  maxConnections?: number;
  /**
   * zone 크기 (KB). 없으면 10m.
   *
   * 차면 nginx 가 **503 을 낸다** — 상태를 못 들고 있으면 통과시키는 게 아니라 막는다.
   * 클라이언트가 많은 배포에서 이 값이 실제로 물린다.
   */
  zoneKb?: number;
};

/** 한 줄. `value` 는 §4.9 의 변수 화이트리스트를 지난다. */
export type HeaderRule = { name: string; value: string };

/**
 * 얹을 헤더.
 *
 * **못 덮는 이름이 있다.** `X-Forwarded-For`·`X-Forwarded-Proto` 는 백엔드가 신뢰하는
 * 값이라 덮으면 클라이언트 IP 사슬이 조용히 끊기고, `Upgrade`·`Connection` 위에는
 * websocket 이 선다. 응답 쪽 `Strict-Transport-Security` 는 모델에 자기 필드가 있어
 * 출처가 둘이 되면 싸운다 — 그리고 HSTS 는 클라이언트 쪽에서 되돌릴 수 없다.
 *
 * `Host` 는 **연다.** 다른 Host 를 기대하는 백엔드로 프록시하는 것은 정당하고 흔하다.
 */
export type HeaderRules = {
  /** 업스트림으로 나가는 요청에 얹는다 (`proxy_set_header`). */
  request?: HeaderRule[];
  /** 클라이언트로 나가는 응답에 얹는다 (`add_header … always`). */
  response?: HeaderRule[];
};

/**
 * 프록시 한계값. **전부 선택이고, 안 적으면 그 디렉티브를 아예 안 낸다.**
 *
 * 기본값을 우리가 정해 렌더하면 설정을 안 건드린 배포의 렌더 바이트가 바뀌고, 그러면
 * 전 배포가 다음 apply 에서 세대 전환을 한다. B-12(dict 크기)가 1024 의 배수를 `m` 으로
 * 낸 것과 같은 이유다.
 */
export type ProxyLimits = {
  /**
   * `proxy_connect_timeout` (ms).
   *
   * ⚠️ **nginx 상한이 75s 다.** 문서가 못 박았다 — *"this timeout cannot usually
   * exceed 75 seconds."* 넘겨 적으면 조용히 무시되므로 해독기가 막는다.
   */
  connectTimeoutMs?: number;
  /** `proxy_read_timeout` (ms). 두 번의 **읽기 사이** 간격이지 전체 시간이 아니다. */
  readTimeoutMs?: number;
  /** `proxy_send_timeout` (ms). 두 번의 **쓰기 사이** 간격이다. */
  sendTimeoutMs?: number;
  /**
   * `client_max_body_size` (바이트). **`0` 은 무제한**이고, 그건 "안 적음" 과 다르다 —
   * 안 적으면 nginx 기본 1m 이고, `0` 은 검사를 끄는 것이다.
   */
  clientMaxBodyBytes?: number;
};

export type Algorithm = 'round_robin' | 'source_ip_hash' | 'hash' | 'least_conn';

/**
 * HTTP 헬스체크 (검수 B-07).
 *
 * 전에는 프로버가 `GET /` 을 치고 **본문이 비어 있지 않으면 살았다고 봤다.** 그래서
 * 500·502·503 과 함께 온 에러 페이지가 전부 `healthy` 였다 — 죽은 백엔드가 계속 트래픽을
 * 받는다. "연결만 열린 죽은 앱" 을 막으려고 본문을 보게 했는데, 정작 **앱이 죽었다고
 * 말하는 신호를 안 봤다.**
 *
 * 이 필드가 없으면 `GET /` 에 2xx 다. 그것이 기본이고, 여기서 좁힐 수 있다.
 *
 * **간격·임계값은 여기 없다.** 그건 프로버 전체의 리듬이고 지금도 환경변수다 —
 * 풀마다 다르게 하려면 프로버가 풀별 스케줄을 들어야 하는데, 그건 다른 크기의 일이다.
 * 없는 것을 있는 척하지 않는다.
 */
export type HealthCheck = {
  /** GET 할 경로. 없으면 `/`. */
  path?: string;
  /** 산 것으로 볼 상태 코드. 없으면 2xx. */
  expectStatus?: number[];
  /** 본문이 이것과 같아야 한다. 없으면 본문을 안 본다. */
  expectBody?: string;
};

export type Pool = {
  key: string;
  protocolClass: ProtocolClass;
  algorithm: Algorithm;
  hashKey?: string;
  /** §4.7 — http 는 엔진에 송신 디렉티브 자체가 없고, udp 는 미지원. tcp 만 v1. */
  sendProxyProtocol?: 'v1';
  /**
   * HTTP 헬스체크 (검수 B-07). **http 풀에만** — stream 에는 요청 개념이 없고,
   * 프로버는 연결만 본다.
   */
  healthCheck?: HealthCheck;
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
/**
 * 엔진 전역 설정 (§7.x main 컨텍스트).
 *
 * **일부러 좁다.** nginx 의 main 컨텍스트에는 수십 개 디렉티브가 있지만, 여기 여는 것은
 * **재 보고 대가를 아는 것**뿐이다. 일반 탈출구(자유 문자열 주입)를 열면 렌더러가
 * 보장하는 것이 통째로 무너진다 — 이 저장소가 `cipher_preset: custom` 을 없앤 것과 같은
 * 이유다.
 */
export type EngineSettings = {
  /**
   * HUP 뒤 옛 워커를 얼마나 기다릴 것인가 (`worker_shutdown_timeout`).
   *
   * **안 적으면 안 낸다 = 무한이다** (nginx 기본값). 그게 안전한 기본값인 이유와 켤 때의
   * 대가를 둘 다 실측했다:
   *
   * | 설정 | in-flight 요청 |
   * |---|---|
   * | 없음(기본) | **끝까지 간다** — 10 초짜리 요청이 200 으로 완료 |
   * | `2s` | **응답 없이 죽는다** — `exit=52` empty reply, 본문 0 바이트 |
   *
   * 502 도 부분 응답도 아니다. 클라이언트는 **네트워크 장애와 구분할 수 없고**,
   * 비멱등 요청이면 부작용이 이미 일어났을 수 있다.
   *
   * 그럼에도 여는 이유는 S13 이다: 이게 없으면 옛 워커가 **얼마나 오래 사는지 상한이
   * 없고**, GC 는 "이 세대를 아직 누가 쓰는가" 를 영영 모른다(마커로는 못 센다 — 실측).
   * 상한을 걸면 *"이 시간이 지나면 아무도 안 든다"* 를 쓸 수 있다.
   *
   * **모르는 것을 없애는 대신 유계로 바꾸는 거래**이고, 값은 in-flight 다.
   */
  workerShutdownTimeoutS?: number;

  /**
   * 멤버십 shared dict 의 크기 (KB). 없으면 1024 (= `1m`) — 지금까지의 하드코딩 값.
   *
   * **왜 열어야 하는가** (검수 B-12). 이 dict 에는 epoch 별 슬롯, 라운드로빈 카운터,
   * 그리고 **peer 별 in-flight 카운터**가 함께 산다. 차면 nginx 는 **LRU 로 밀어낸다** —
   * 밀려난 것이 `slot:` 이면 `balancer_by_lua` 가 `ngx.exit(ngx.ERROR)` 를 타고
   * **그 풀의 모든 요청이 끊긴다.**
   *
   * 즉 이건 성능 손잡이가 아니라 **절벽**이다. 백엔드가 늘면 언젠가 닿고, 닿는 순간
   * 조용하지 않게 끊긴다. 크기를 못 바꾸면 그때 할 수 있는 것이 없다.
   */
  membershipDictKb?: number;

  /**
   * ACME 토큰 dict 의 크기 (KB). 없으면 64 — 지금까지의 하드코딩 값.
   *
   * 멤버십과 **다른 dict** 인 이유는 S18 이 실측했다: 같이 쓰면 멤버십 staging 이 토큰을
   * LRU 로 밀어내고, 증상은 "인증서 발급이 가끔 안 된다" 다.
   */
  acmeDictKb?: number;
};

export type Model = {
  /** 엔진 전역 설정. 없으면 렌더러가 아무것도 안 낸다 (엔진 기본값). */
  engine?: EngineSettings;
  listeners: Listener[];
  httpRoutes: HttpRoute[];
  passthroughRoutes: PassthroughRoute[];
  pools: Pool[];
  backends: Backend[];
  certificates: Certificate[];
  tlsPolicies: TlsPolicy[];
  sniBindings: SniCertificateBinding[];
};

/** 검증 전 모델. `validateModel` 의 입력이다. */
export type RawModel = Omit<Model, 'listeners'> & { listeners: RawListener[] };
