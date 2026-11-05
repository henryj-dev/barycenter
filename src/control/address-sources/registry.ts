/**
 * 주소 집합 출처 등록부 (2026-11-05) — 집합의 `source` 이름으로 고른다.
 *
 * 다른 출처를 붙이려면: `AddressSource` 를 구현한 함수 하나(`providers.ts`) + 아래 표에 한 줄 + 모델의
 * `ADDRESS_SOURCE_KINDS` 와 해독기의 옵션 표. 표의 타입이 `Record<AddressSourceKind, …>` 라서 모델에 이름을 더하고
 * 여기를 잊으면 컴파일이 막는다.
 *
 * ── 설정 (env) — 데몬의 주기 갱신 ───────────────────────────────────────
 *
 *   BARY_ADDRESS_SOURCE_INTERVAL_MS   주기. **없으면 주기 갱신이 꺼진다** — 지금과 같다(CLI · 화면의 「다시 받기」 만)
 *   BARY_ADDRESS_SOURCE_AUTOAPPLY     `0` 이면 커밋까지만. 기본 `1` — ACME 게시와 같은 규칙으로 자동 적용한다
 *                                     (다른 변경이 적용 대기에 있으면 미룬다)
 *
 * 출처는 공개 목록이라 자격(비밀)이 없다.
 */
import type { AddressSourceKind } from '../../model/provisional.js';
import type { FetchLike } from '../sources/fetch.js';
import { awsSource, cloudflareSource, fastlySource, gcpSource, urlSource, type ProviderOptions } from './providers.js';
import type { AddressSource } from './source.js';

const SOURCES: Readonly<Record<AddressSourceKind, (p: ProviderOptions) => AddressSource>> = {
  cloudflare: cloudflareSource,
  aws: awsSource,
  gcp: gcpSource,
  fastly: fastlySource,
  url: urlSource,
};

export function addressSourceKinds(): string[] {
  return Object.keys(SOURCES);
}

/** 모르는 이름이면 던진다(해독기가 먼저 막으므로 여기 오면 프로그래밍 오류다). */
export function addressSource(kind: string, p: ProviderOptions = {}): AddressSource {
  const make = Object.hasOwn(SOURCES, kind) ? SOURCES[kind as AddressSourceKind] : undefined;
  if (make === undefined) throw new Error(`모르는 주소 집합 출처: ${kind} (쓸 수 있는 것: ${addressSourceKinds().join(', ')})`);
  return make(p);
}

export type AddressSourceSchedule = { intervalMs?: number; autoApply: boolean };

/** env → 주기 설정. 틀린 값은 던진다(기동 거부). 주기가 없으면 `intervalMs` 가 없다 — 주기 갱신이 꺼진다. */
export function addressSourceScheduleFromEnv(env: NodeJS.ProcessEnv = process.env): AddressSourceSchedule {
  const raw = (env['BARY_ADDRESS_SOURCE_INTERVAL_MS'] ?? '').trim();
  const auto = (env['BARY_ADDRESS_SOURCE_AUTOAPPLY'] ?? '').trim();
  if (auto !== '' && auto !== '0' && auto !== '1') {
    throw new Error(`BARY_ADDRESS_SOURCE_AUTOAPPLY 는 0 이나 1 이다 (받은 것: ${auto})`);
  }
  if (raw === '') {
    if (auto !== '') throw new Error('BARY_ADDRESS_SOURCE_AUTOAPPLY 를 줬으면 BARY_ADDRESS_SOURCE_INTERVAL_MS 도 필요하다 — 주기 갱신이 꺼져 있다');
    return { autoApply: true };
  }
  const n = Number(raw);
  // 하한 1분 — 공개 목록은 하루에 몇 번 바뀌지 않고, 더 잦게 두드리면 받는 쪽이 막는다.
  if (!Number.isInteger(n) || n < 60_000 || n > 7 * 86_400_000) {
    throw new Error(`BARY_ADDRESS_SOURCE_INTERVAL_MS 는 60000~604800000 의 정수다 (받은 것: ${raw})`);
  }
  return { intervalMs: n, autoApply: auto !== '0' };
}

export type AddressSources = (kind: string) => AddressSource;

/** 이름 → 출처. 시험이 fetch 를 주입한다. */
export function addressSources(fetch?: FetchLike): AddressSources {
  return (kind) => addressSource(kind, fetch === undefined ? {} : { fetch });
}
