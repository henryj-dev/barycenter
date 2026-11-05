/**
 * dns-01 공급자의 **어댑터 계약** — TXT 하나를 더하고 그 하나만 지운다.
 *
 * 다른 공급자를 붙이려면 이 인터페이스의 구현 하나와 `registry.ts` 의 등록 한 줄이면 된다.
 * 러너(`AcmeRunner`)는 공급자를 모른다 — `Dns01Placer`(`placer.ts`)가 이것을 `ChallengePlacer` 로 바꾼다.
 *
 * ── 왜 「더하기 · 그 값만 지우기」 인가
 *
 * 같은 이름에 TXT 가 둘 설 수 있다: `example.com` 과 `*.example.com` 을 한 주문에 넣으면 둘 다
 * `_acme-challenge.example.com` 이다. 하나를 놓으며 다른 하나를 덮거나, 하나를 치우며 둘 다 지우면
 * 검증이 깨진다. 그래서 공급자는 **값 단위로** 더하고 지운다.
 *
 * **실패를 예외로 던지지 않는다** — 결과 객체다.
 */

export type DnsFailure =
  /** 자격증명을 거절했다(401 · 403 · TSIG). 배포 문제다. */
  | 'auth'
  /** 그 이름을 담는 영역(zone)을 찾지 못했다. */
  | 'zone-not-found'
  /** 공급자가 요청을 거절했다(형식 · 정책). */
  | 'rejected'
  /** 닿지 못했거나, 시도 제한, 알 수 없는 답. 다시 하면 될 수 있다. */
  | 'unavailable'
  /** https 가 아닌 주소. 보내지 않았다. */
  | 'insecure'
  /** 놓았지만 권한 있는 이름서버에 정해진 시간 안에 보이지 않았다. */
  | 'propagation-timeout';

export type DnsResult = { ok: true } | { ok: false; reason: DnsFailure; detail: string };

export interface Dns01Provider {
  /** 등록부의 이름(`cloudflare` …). 로그 · 사유에 쓴다. */
  readonly kind: string;
  /** `name` 에 TXT `value` 를 더한다. 같은 이름의 다른 값은 그대로 둔다. 이미 있으면 성공이다. */
  addTxt(name: string, value: string): Promise<DnsResult>;
  /** `name` 의 TXT 중 `value` 하나만 지운다. 이미 없으면 성공이다. */
  removeTxt(name: string, value: string): Promise<DnsResult>;
}

/** TXT 이름으로 쓸 수 있는가 — 줄바꿈 · 공백 · 따옴표가 공급자 요청(특히 nsupdate 입력)에 섞이지 않게. */
export function validTxtName(name: string): boolean {
  if (name.length === 0 || name.length > 253) return false;
  return name.split('.').every((l) => /^[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9])?$/.test(l));
}

/** 챌린지 값(base64url 43자)인가. */
export function validTxtValue(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,255}$/.test(value);
}

/**
 * 영역 후보 — 긴 것부터. `_acme-challenge.a.example.com` → `a.example.com`, `example.com`.
 * 첫 라벨(`_acme-challenge`)과 최상위 라벨 하나만 남은 것은 넣지 않는다.
 */
export function zoneCandidates(name: string): string[] {
  const labels = name.replace(/\.$/, '').toLowerCase().split('.');
  const out: string[] = [];
  for (let i = 1; i <= labels.length - 2; i += 1) out.push(labels.slice(i).join('.'));
  return out;
}

export const fail = (reason: DnsFailure, detail: string): DnsResult => ({ ok: false, reason, detail });
export const OK: DnsResult = { ok: true };
