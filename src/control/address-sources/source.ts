/**
 * 주소 집합 출처의 **어댑터 계약** (2026-11-05).
 *
 * 공개 목록(Cloudflare · AWS · GCP · Fastly · 임의 URL)을 받아 대역 목록으로 답한다. 다른 출처를 붙이려면 이 인터페이스의
 * 구현 하나, `registry.ts` 의 한 줄, 모델의 이름 목록(`ADDRESS_SOURCE_KINDS`)과 해독기의 옵션 표 한 줄이다.
 *
 * **던지지 않는다** — 결과 객체다. 「실패면 집합을 그대로 둔다」 는 `refresh.ts` 가 한다.
 * **반쪽 목록을 내지 않는다** — 받은 값 중 하나라도 대역이 아니면 그 답 전체가 `invalid` 다. 목록이 곧 「누구를 믿는가 ·
 * 누구를 들이는가」 라서, 조용히 버린 한 줄이 그 대역에서 오는 연결을 막는다.
 */
import type { AddressSourceKind, AddressSourceOptions } from '../../model/provisional.js';
import { cidrVersion } from '../../validate/ip.js';
import type { SourceError } from '../sources/fetch.js';

export type AddressFetchResult = { ok: true; cidrs: string[] } | SourceError;

export interface AddressSource {
  readonly kind: AddressSourceKind;
  fetch(options: AddressSourceOptions): Promise<AddressFetchResult>;
}

/** 답 하나의 크기 상한. AWS 전체 목록(약 2MB)을 넉넉히 담는다. */
export const MAX_ADDRESS_RESPONSE_BYTES = 16 * 1024 * 1024;

/** 집합 하나의 대역 상한. 넘으면 `too-large` — 거르지 않은 AWS 전체 목록도 이 안이다. */
export const MAX_ADDRESS_CIDRS = 50_000;

export const ADDRESS_TIMEOUT_MS = 15_000;

/**
 * 받은 목록을 다듬는다 — 대역인지 · `family` 거르기 · 중복 접기 · 상한. 순서는 출처의 순서다(중복만 접는다).
 * 거른 뒤 비면 `invalid` 다 — 빈 집합은 모델이 받지 않고, 「출처가 비었다」 는 대개 거르기를 틀리게 적은 것이다.
 */
export function normalizeCidrs(raw: readonly string[], options: AddressSourceOptions, what: string): AddressFetchResult {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const c = r.trim();
    if (c === '') continue;
    const v = cidrVersion(c);
    if (v === 0) return { ok: false, reason: 'invalid', detail: `${what}: 대역이 아니다 — ${JSON.stringify(c.slice(0, 80))}` };
    if (options.family === 'ipv4' && v !== 4) continue;
    if (options.family === 'ipv6' && v !== 6) continue;
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  if (out.length === 0) return { ok: false, reason: 'invalid', detail: `${what}: 받은 대역이 없다 (거르기를 본다)` };
  if (out.length > MAX_ADDRESS_CIDRS) {
    return { ok: false, reason: 'too-large', detail: `${what}: 대역 ${out.length}개 — 상한 ${MAX_ADDRESS_CIDRS} (services · regions 로 거른다)` };
  }
  return { ok: true, cidrs: out };
}

/** 대소문자를 가리지 않는 포함 판정 — 거르기 목록이 없으면 다 통과다. */
export const matches = (list: readonly string[] | undefined, value: unknown): boolean =>
  list === undefined || (typeof value === 'string' && list.some((x) => x.toLowerCase() === value.toLowerCase()));
