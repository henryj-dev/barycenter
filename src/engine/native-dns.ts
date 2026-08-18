/**
 * 네이티브 DNS 폴백의 capability — DESIGN.md §7.3 · S14
 *
 * S14 가 잰 것: 엔진은 실패 모드마다 **하나의 동작만** 준다. 우리 모델의
 * `on_nxdomain` / `on_timeout` 선택형은 이 경로에서 표현할 수 없다. 선택형을
 * 모델에 두고 조용히 무시하면 GUI 가 없는 선택지를 보여주게 된다.
 *
 * 그래서 여기 있는 것은 선택지가 아니라 **사실**이다. 값은 리터럴이고 객체는
 * 얼려 있다. 엔진이 `resolve` 를 못하면(`available: false`) 실패 모드 표 자체를
 * 내놓지 않는다 — 없는 경로의 정책을 보여 줄 이유가 없다.
 *
 * `nginx -V` 로는 이 표를 읽을 수 없다. 버전·모듈이 아니라 런타임 동작이고,
 * 재는 자리는 `spike/s14/` 다. 이 모듈은 그 측정을 계약으로 옮긴 것이다.
 */
export const NATIVE_DNS_FAILURE_MODES = Object.freeze({
  /** NXDOMAIN — peer 를 뺀다. 마지막이면 502 (fail-closed). */
  nxdomain: 'drop_peer',
  /** SERVFAIL — 마지막으로 알던 peer 를 계속 쓴다. */
  servfail: 'keep_last',
  /** 무응답(침묵). SERVFAIL 과 같다. 서버를 죽인 ICMP 즉시 실패와는 다른 실험. */
  timeout: 'keep_last',
} as const);

export type NativeDnsFailureModes = typeof NATIVE_DNS_FAILURE_MODES;

export type NativeDnsCapabilities =
  | { readonly available: false }
  | {
      readonly available: true;
      readonly failureModes: NativeDnsFailureModes;
    };

/**
 * 드라이버가 드러내는 능력. **잰 것만** 넣는다 (§9.1 — 구현하지 않은 계약을 고정하지 않는다).
 *
 * DESIGN.md §9.2.1 의 큰 스케치는 비규범이다. 여기 있는 것이 지금 고정하는 표면이다.
 * 필드가 늘어나는 것은 표면 이동이고, 동결 카운터는 그때 0 으로 돌아간다.
 */
export type DataplaneCapabilities = {
  nativeDns: NativeDnsCapabilities;
};

export function nativeDnsOf(dnsResolve: boolean): NativeDnsCapabilities {
  if (!dnsResolve) return { available: false };
  return { available: true, failureModes: NATIVE_DNS_FAILURE_MODES };
}

export function dataplaneCapabilitiesOf(
  engine: { supports: { dnsResolve: boolean } },
): DataplaneCapabilities {
  return { nativeDns: nativeDnsOf(engine.supports.dnsResolve) };
}

/**
 * 로드된 드라이버가 드러낸 capability 를 읽는다.
 *
 * 로더는 공급망만 본다. 계약의 내용은 여기다. 선택형을 슬며시 받아들이면
 * S14 가 막으려던 GUI 가 다시 생긴다 — 모르는 키·다른 값은 거절한다.
 */
export class DriverContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriverContractError';
  }
}

export function capabilitiesFromDriver(mod: unknown): DataplaneCapabilities {
  if (mod === null || typeof mod !== 'object') {
    throw new DriverContractError('드라이버 모듈이 객체여야 한다');
  }
  const capabilities = (mod as { capabilities?: unknown }).capabilities;
  const raw = typeof capabilities === 'function'
    ? (capabilities as () => unknown)()
    : capabilities;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DriverContractError('capabilities 가 객체여야 한다');
  }
  const obj = raw as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (k !== 'nativeDns') throw new DriverContractError(`모르는 capability '${k}'`);
  }
  return { nativeDns: readNativeDns(obj['nativeDns']) };
}

function readNativeDns(raw: unknown): NativeDnsCapabilities {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DriverContractError('nativeDns 가 객체여야 한다');
  }
  const obj = raw as Record<string, unknown>;
  const available = obj['available'];
  if (available === false) {
    for (const k of Object.keys(obj)) {
      if (k !== 'available') throw new DriverContractError(`available: false 인데 '${k}' 가 있다`);
    }
    return { available: false };
  }
  if (available !== true) {
    throw new DriverContractError('nativeDns.available 은 boolean 이어야 한다');
  }
  const modes = obj['failureModes'];
  if (modes === null || typeof modes !== 'object' || Array.isArray(modes)) {
    throw new DriverContractError('available: true 이면 failureModes 가 있어야 한다');
  }
  const rec = modes as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (k !== 'available' && k !== 'failureModes') {
      throw new DriverContractError(`nativeDns 에 모르는 필드 '${k}'`);
    }
  }
  const want = NATIVE_DNS_FAILURE_MODES;
  const keys = Object.keys(rec).sort();
  const expected = Object.keys(want).sort();
  if (keys.join(',') !== expected.join(',')) {
    throw new DriverContractError('failureModes 의 키가 S14 표와 다르다');
  }
  for (const k of expected) {
    const field = k as keyof typeof want;
    if (rec[field] !== want[field]) {
      throw new DriverContractError(`failureModes.${field} 는 '${want[field]}' 이어야 한다`);
    }
  }
  return { available: true, failureModes: want };
}
