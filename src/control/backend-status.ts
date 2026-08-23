/**
 * 백엔드 운영 상태 — **"왜 이 백엔드가 트래픽을 안 받나"** (제안 #9, 2026-08-23)
 *
 * 지금까지는 조각으로만 보였다: 헬스는 `GET /backends/{id}/status`, 드레인은
 * `GET /backends/{id}/drain-status`, 그리고 **슬롯 소속은 아무 데도 안 보였다.**
 * 운영자가 셋을 따로 물어 머리로 합쳐야 했고, 셋째 이유는 물을 창구조차 없었다.
 *
 * ── 판정의 정본은 리듀서다
 *
 * 엔진에게 "지금 슬롯에 뭐가 있냐" 고 되묻지 않는다. 슬롯을 정하는 것이
 * `reduceMembership` 이므로 되묻는 것은 우리가 방금 쓴 값을 다시 읽는 것이고, 그 사이
 * 갱신이 실패했다면 그건 **다른 사건**이다 (§6.7 — 판정 동결 vs 갱신 실패). 여기서
 * 섞으면 "왜 안 받나" 의 답이 두 층으로 갈리고, 운영자는 어느 층을 고쳐야 할지 모른다.
 *
 * ── 이유는 넷이고, 전부 싣는다
 *
 * `unhealthy` · `draining` 은 리듀서가 직접 보는 둘이다. 나머지 둘은 그 **앞단**에 있다:
 *
 *   · `pool_not_routed` — 풀이 어떤 리스너·라우트에도 안 걸렸다. 렌더에 upstream 이
 *     안 생기므로 슬롯 자체가 없다. **헬스는 초록이고 드레인도 아닌데 트래픽이 0 이다.**
 *     지금까지 이 상태는 모델을 손으로 훑어야만 알 수 있었다.
 *   · `pool_missing` — 참조하는 풀이 없다. 검증기가 커밋을 막지만, 판정은 검증기가
 *     막아 준다는 가정 위에 서지 않는다.
 *
 * **하나만 내고 멈추지 않는다.** 이유가 셋이면 셋을 다 싣는다 — 하나를 고치고도 여전히
 * 안 받으면 운영자는 이 API 를 두 번 믿지 않는다.
 */
import type { Model } from '../model/provisional.js';
import type { HealthState } from './health.js';

/** 트래픽을 못 받는 이유. */
export type BackendExclusion =
  /** 프로버가 죽었다고 판정했다. */
  | 'unhealthy'
  /** 운영자가 뺐다 (`POST /backends/{id}/drain`). */
  | 'draining'
  /** 풀이 어떤 리스너·라우트에도 안 걸려 렌더에 upstream 이 없다. */
  | 'pool_not_routed'
  /** 참조하는 풀이 모델에 없다. */
  | 'pool_missing';

export type BackendStatusRow = {
  key: string;
  pool: string;
  host: string;
  port: number;
  /** 어느 평면인가. http 와 stream 은 서로 못 보는 zone 이다 (E14 · §3.4). */
  plane: 'http' | 'stream' | undefined;
  health: { state: HealthState; observedAt?: string; detail?: string };
  draining: boolean;
  /** 지금 트래픽을 받는가 — 리듀서의 판정 그대로. */
  receivingTraffic: boolean;
  /** 안 받으면 왜. 받으면 빈 배열. **정렬해서 낸다** — 목록을 눈으로 비교할 수 있어야 한다. */
  reasons: BackendExclusion[];
};

export type BackendStatusInput = {
  model: Model;
  /** 백엔드 키 → 판정. 없으면 `unknown` 이다. */
  health: ReadonlyMap<string, HealthState>;
  /** 관측 시각·사유. 없어도 판정은 선다. */
  detail?: ReadonlyMap<string, { observedAt: string; detail?: string }>;
  draining: ReadonlySet<string>;
  /** 렌더에 upstream 이 생기는 풀들. `slotsOf` 가 보는 것과 같은 집합이다. */
  routedPools: ReadonlySet<string>;
};

export function backendStatusRows(input: BackendStatusInput): BackendStatusRow[] {
  const { model, health, draining, routedPools } = input;
  const poolOf = new Map(model.pools.map((p) => [p.key, p]));

  const rows = model.backends.map((b): BackendStatusRow => {
    const pool = poolOf.get(b.pool);
    // 없으면 `unknown` 이다. **`unknown` 은 안 뺀다** — 아직 못 잰 것과 죽은 것은
    // 다르고, 기동 직후 전부 `unknown` 일 때 다 빼면 멤버십이 통째로 빈다 (§6.6).
    const state = health.get(b.key) ?? 'unknown';
    const seen = input.detail?.get(b.key);

    const reasons: BackendExclusion[] = [];
    if (state === 'unhealthy') reasons.push('unhealthy');
    if (draining.has(b.key)) reasons.push('draining');
    if (pool === undefined) {
      reasons.push('pool_missing');
    } else if (!routedPools.has(b.pool)) {
      reasons.push('pool_not_routed');
    }
    reasons.sort();

    return {
      key: b.key,
      pool: b.pool,
      host: b.host,
      port: b.port,
      plane: pool === undefined ? undefined : (pool.protocolClass === 'http' ? 'http' : 'stream'),
      health: {
        state,
        ...(seen === undefined ? {} : { observedAt: seen.observedAt }),
        ...(seen?.detail === undefined ? {} : { detail: seen.detail }),
      },
      draining: draining.has(b.key),
      receivingTraffic: reasons.length === 0,
      reasons,
    };
  });

  // **순서를 고정한다.** 두 시점의 목록을 눈으로(그리고 diff 로) 비교할 수 있어야 한다.
  return rows.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
}
