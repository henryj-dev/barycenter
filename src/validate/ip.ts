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

/**
 * `주소/접두사` 또는 주소 하나 (리스너 `sourceAllow` — 2026-10-29).
 *
 * nginx 의 `allow` 와 `geo` 가 받는 모양만 받는다:
 *   · 접두사는 IPv4 0–32, IPv6 0–128. **선행 0 을 안 받는다** (`/08`).
 *   · **존 ID 를 안 받는다** (`fe80::1%eth0`). `ipVersion` 은 받지만 nginx 는 못 읽는다.
 *   · 접두사 없는 주소는 단일 호스트다 (`/32` · `/128` 과 같다).
 *
 * 호스트 비트가 켜진 대역(`10.0.0.1/8`)은 **받는다.** nginx 가 경고만 내고 망 주소로
 * 읽는다 — 운영자가 붙여 넣는 목록에는 흔한 모양이라 거절하면 쓰기만 어렵다.
 */
export function cidrVersion(input: string): 0 | 4 | 6 {
  const slash = input.indexOf('/');
  const addr = slash < 0 ? input : input.slice(0, slash);
  if (addr.includes('%')) return 0;
  const v = ipVersion(addr);
  if (v === 0) return 0;
  if (slash < 0) return v;
  const prefix = input.slice(slash + 1);
  if (!/^(0|[1-9][0-9]{0,2})$/.test(prefix)) return 0;
  return Number(prefix) <= (v === 4 ? 32 : 128) ? v : 0;
}

/**
 * 주소 집합 참조 `@이름` (#114). 이름은 리소스 key 문법과 같다. 참조가 아니면 `undefined`.
 * 브라우저에서도 돈다 — GUI 의 출발지 제한 입력이 같은 판정을 쓴다.
 */
export function addressSetRef(input: string): string | undefined {
  const m = /^@([A-Za-z0-9][A-Za-z0-9._-]{0,62})$/.exec(input);
  return m === null ? undefined : m[1];
}

/** 주소 → 정수. IP 가 아니면 `undefined`. 존 ID 는 받지 않는다(`cidrVersion` 과 같다). */
function ipBits(addr: string): { v: 4 | 6; n: bigint } | undefined {
  const v = ipVersion(addr);
  if (v === 0 || addr.includes('%')) return undefined;
  if (v === 4) return { v, n: addr.split('.').reduce((acc, o) => (acc << 8n) | BigInt(Number(o)), 0n) };
  let a = addr;
  let low: bigint | undefined;
  const lastColon = a.lastIndexOf(':');
  const tailPart = a.slice(lastColon + 1);
  if (tailPart.includes('.')) {
    low = ipBits(tailPart)!.n;
    a = `${a.slice(0, lastColon + 1)}0:0`;
  }
  const dbl = a.indexOf('::');
  const head = dbl < 0 ? a.split(':') : a.slice(0, dbl) === '' ? [] : a.slice(0, dbl).split(':');
  const tail = dbl < 0 ? [] : a.slice(dbl + 2) === '' ? [] : a.slice(dbl + 2).split(':');
  const groups = [...head, ...new Array<string>(8 - head.length - tail.length).fill('0'), ...tail];
  let n = groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
  if (low !== undefined) n = (n & ~0xffffffffn) | low;
  return { v: 6, n };
}

/**
 * **대역 `outer` 가 대역 `inner` 를 덮는가** (2026-11-02, 라우트 출발지 규칙). 계열이 다르면 덮지 않는다. 접두사 없는
 * 주소는 단일 호스트다. 호스트 비트가 켜진 대역은 nginx 처럼 망 주소로 읽는다. 둘 중 하나라도 CIDR 이 아니면 거짓이다.
 */
export function cidrCovers(outer: string, inner: string): boolean {
  const parse = (s: string): { v: 4 | 6; net: bigint; len: number } | undefined => {
    if (cidrVersion(s) === 0) return undefined;
    const slash = s.indexOf('/');
    const ip = ipBits(slash < 0 ? s : s.slice(0, slash));
    if (ip === undefined) return undefined;
    const width = ip.v === 4 ? 32 : 128;
    const len = slash < 0 ? width : Number(s.slice(slash + 1));
    const mask = len === 0 ? 0n : ((1n << BigInt(len)) - 1n) << BigInt(width - len);
    return { v: ip.v, net: ip.n & mask, len };
  };
  const o = parse(outer);
  const i = parse(inner);
  if (o === undefined || i === undefined || o.v !== i.v || o.len > i.len) return false;
  const width = o.v === 4 ? 32 : 128;
  const mask = o.len === 0 ? 0n : ((1n << BigInt(o.len)) - 1n) << BigInt(width - o.len);
  return (i.net & mask) === o.net;
}
