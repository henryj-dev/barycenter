/**
 * barycenter 참조 드라이버 — DESIGN.md §9.3
 *
 * 코어를 import 하지 않는다. 사내 레포가 이 파일을 복사해 시작할 수 있는 최소다.
 * 로더가 확인하는 것은 `apiVersion` 이고, 호환성 키트가 확인하는 것은 `capabilities` 다.
 *
 * 이 참조는 엔진을 재지 않는다. 네이티브 DNS 경로를 제공하지 않으므로
 * `nativeDns.available` 은 false 다 — 없는 능력을 있다고 하지 않는다.
 * resolve 가 있는 엔진에서 그 경로를 쓰는 드라이버는 available: true 와
 * S14 표(nxdomain=drop_peer, servfail/timeout=keep_last) 만 낼 수 있다.
 */
export const apiVersion = 1;

export const capabilities = {
  nativeDns: { available: false },
};
