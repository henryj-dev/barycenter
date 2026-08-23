/**
 * IP 주소 판별 — **노드 내장 없이.**
 *
 * `node:net` 의 `isIP` 를 쓰던 자리다. 그 import 하나가 `validate/strings.ts` 에
 * 있었고, GUI 가 `routes-view → route/compile → validate/strings` 로 그 모듈에
 * 닿는다. 그래서 **브라우저 번들이 서지 않았다**:
 *
 * ```
 * "isIP" is not exported by "__vite-browser-external"
 * ```
 *
 * 즉 `gui/build` 가 만들어지지 않았고, 데몬은 그게 없으면 조용히 GUI 없이 뜬다
 * (`barycenterd.ts` 의 `serveRoot`). 제품 명제가 GUI 인데(§2) 그 산출물이 없는
 * 상태였고, `gui/` 가 게이트 밖이라 아무 스위트도 그 사실을 말하지 않았다.
 *
 * **직접 만드는 대신 옮겨 적지 않는다.** 규칙을 문서에서 베끼면 미묘하게 다른 판정이
 * 하나 더 생긴다 — 그건 이 저장소가 반복해서 잡아온 모양이다. 그래서 `net.isIP` 를
 * **오라클로 두고 차분 검증**한다 (`tests/unit/ip-version.test.ts`). 아래 규칙은 전부
 * 그 오라클에 물어보고 적은 것이다:
 *
 * | 입력 | `net.isIP` |
 * |---|---|
 * | `01.2.3.4` | **0** — 선행 0 은 IPv4 가 아니다 |
 * | `fe80::1%eth0` | **6** — 존 ID 를 받는다 |
 * | `fe80::1%` | 0 — 빈 존 ID 는 아니다 |
 * | `00000::1` | 0 — hextet 은 1–4 자리 |
 * | `1:2:3:4:5:6:7::8` | 0 — `::` 는 최소 한 그룹을 대신해야 한다 |
 * | `1.2.3.4::` | 0 — 임베디드 IPv4 는 **꼬리**에만 온다 |
 */

/** `0` = IP 아님 · `4` = IPv4 · `6` = IPv6. `net.isIP` 와 같은 값이다. */
export function ipVersion(input: string): 0 | 4 | 6 {
  if (isIPv4(input)) return 4;
  if (isIPv6(input)) return 6;
  return 0;
}

/** 점 넷으로 끊긴 십진 넷. **선행 0 을 안 받는다** — 8진수로 읽히는 표기다. */
const V4_OCTET = /^(0|[1-9][0-9]{0,2})$/;

function isIPv4(input: string): boolean {
  const parts = input.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => V4_OCTET.test(p) && Number(p) <= 255);
}

const HEXTET = /^[0-9a-fA-F]{1,4}$/;

function isIPv6(input: string): boolean {
  // 존 ID (`%eth0`) 는 주소의 일부가 아니다. 하나만, 그리고 비어 있으면 안 된다.
  let addr = input;
  const pct = input.indexOf('%');
  if (pct >= 0) {
    const zone = input.slice(pct + 1);
    if (zone.length === 0 || zone.includes('%')) return false;
    addr = input.slice(0, pct);
  }

  const dbl = addr.indexOf('::');
  if (dbl !== addr.lastIndexOf('::')) return false;   // `::` 는 한 번뿐이다

  let head: string[];
  let tail: string[];
  if (dbl >= 0) {
    const h = addr.slice(0, dbl);
    const t = addr.slice(dbl + 2);
    // `1:::` 처럼 `::` 에 콜론이 더 붙는 것은 아니다.
    if (h.endsWith(':') || t.startsWith(':')) return false;
    head = h === '' ? [] : h.split(':');
    tail = t === '' ? [] : t.split(':');
  } else {
    head = addr.split(':');
    tail = [];
  }

  const all = [...head, ...tail];
  const last = all[all.length - 1];
  let hextets = all;
  let groups = all.length;
  if (last !== undefined && last.includes('.')) {
    // 임베디드 IPv4 는 **맨 뒤**에서만 유효하다. `1.2.3.4::` 는 IP 가 아니다.
    if (dbl >= 0 && tail.length === 0) return false;
    if (!isIPv4(last)) return false;
    hextets = all.slice(0, -1);
    groups = hextets.length + 2;              // IPv4 는 하위 32비트 = hextet 둘
  }

  if (!hextets.every((p) => HEXTET.test(p))) return false;
  // `::` 는 **최소 한 그룹**을 대신한다. 없으면 정확히 여덟이어야 한다.
  return dbl >= 0 ? groups <= 7 : groups === 8;
}
