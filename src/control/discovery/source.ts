/**
 * 백엔드 디스커버리 출처의 **어댑터 계약** (2026-11-05).
 *
 * 출처(DNS SRV · Consul · Kubernetes · 파일)가 같은 모양으로 답한다. 다른 출처를 붙이려면 이 인터페이스의 구현 하나와
 * `registry.ts` 의 한 줄, 그리고 모델의 이름 목록(`DISCOVERY_SOURCE_KINDS`)에 이름 하나다.
 *
 * **실패를 던지지 않는다** — 결과 객체다. 정책(실패면 마지막 값을 지킨다 · 빈 목록을 어떻게 읽는다)은
 * `runner.ts` 가 정한다. 출처는 「무엇을 받았나」 만 말한다.
 *
 * **주소는 IP 다.** 멤버십 슬롯은 `host:port` 이고 엔진의 밸런서는 그 자리에서 이름을 풀지 않는다 — 이름이 오면
 * 그 peer 는 연결되지 않는다. 이름을 주는 출처(SRV 의 target)는 어댑터가 IP 로 푼다. 그래도 IP 가 아닌 값이 오면
 * 그 답 전체가 `invalid` 다(반쪽 목록으로 바꾸지 않는다).
 */
import { isIP } from 'node:net';

import type { DiscoverySourceKind } from '../../model/provisional.js';
import type { SourceError } from '../sources/fetch.js';

export type DiscoveredAddress = { host: string; port: number };

export type DiscoveryResult = { ok: true; endpoints: DiscoveredAddress[] } | SourceError;

export interface DiscoverySource {
  readonly kind: DiscoverySourceKind;
  /** 판정 때문에 던지지 않는다. */
  resolve(query: string): Promise<DiscoveryResult>;
}

/** 한 풀에 받을 수 있는 주소의 상한. 넘으면 `too-large` — 출처의 고장이 슬롯 dict 를 채우지 않게. */
export const MAX_DISCOVERED = 1024;

/** 응답 본문 상한 (Consul · Kubernetes). 1024 개 주소를 넉넉히 담는다. */
export const MAX_DISCOVERY_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * 받은 목록을 다듬는다 — IP 인지 · 포트 범위 · 상한, 그리고 중복을 접고 정렬한다(같은 집합이면 같은 배열이어야
 * 「바뀌었나」 를 배열 비교로 볼 수 있다).
 */
export function normalizeEndpoints(list: readonly DiscoveredAddress[], what: string): DiscoveryResult {
  const seen = new Map<string, DiscoveredAddress>();
  for (const e of list) {
    if (isIP(e.host) === 0) {
      return { ok: false, reason: 'invalid', detail: `${what}: IP 주소가 아니다 — ${JSON.stringify(e.host)}` };
    }
    if (!Number.isInteger(e.port) || e.port < 1 || e.port > 65535) {
      return { ok: false, reason: 'invalid', detail: `${what}: 포트가 1~65535 가 아니다 — ${JSON.stringify(e.port)}` };
    }
    seen.set(`${e.host}|${e.port}`, { host: e.host, port: e.port });
  }
  if (seen.size > MAX_DISCOVERED) {
    return { ok: false, reason: 'too-large', detail: `${what}: 주소가 ${seen.size}개 — 상한 ${MAX_DISCOVERED}` };
  }
  const endpoints = [...seen.values()].sort((a, b) =>
    (a.host === b.host ? a.port - b.port : a.host < b.host ? -1 : 1));
  return { ok: true, endpoints };
}
