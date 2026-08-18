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
