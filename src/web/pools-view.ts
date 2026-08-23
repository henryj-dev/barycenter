/**
 * Pools 화면이 읽는 값 — DESIGN.md §10
 *
 * 헬스는 SSE 스냅샷과 `health` 델타다. `/health/backends` 를 다시 치지 않는다.
 * 관측이 없으면 `unknown` — 죽은 것과 아직 안 잰 것을 섞지 않는다 (§6.6).
 * 드레인·inflight 는 없다. S2 가 그 게이트다.
 */
export type PoolFact = {
  key: string;
  protocolClass: string;
  algorithm: string;
};

export type BackendFact = {
  key: string;
  pool: string;
  host: string;
  port: number;
  weight?: number;
};

export type HealthFact = {
  backendKey: string;
  state: string;
};

export type HealthMark = 'healthy' | 'unhealthy' | 'unknown';

export type BackendRow = {
  key: string;
  host: string;
  port: number;
  weight: number;
  state: HealthMark;
};

export type PoolRow = {
  key: string;
  protocolClass: string;
  algorithm: string;
  backends: BackendRow[];
  healthy: number;
  unknown: number;
  unhealthy: number;
};

export type PoolsView = { rows: PoolRow[] };

export function markOf(state: string): HealthMark {
  if (state === 'healthy' || state === 'unhealthy') return state;
  return 'unknown';
}

export function upsertHealth(
  rows: readonly HealthFact[],
  flip: HealthFact,
): HealthFact[] {
  const i = rows.findIndex((r) => r.backendKey === flip.backendKey);
  if (i < 0) return [...rows, { backendKey: flip.backendKey, state: flip.state }];
  return rows.map((r, n) => (n === i ? { backendKey: r.backendKey, state: flip.state } : r));
}

export function viewOfPools(
  pools: readonly PoolFact[],
  backends: readonly BackendFact[],
  health: readonly HealthFact[],
): PoolsView {
  const state = new Map(health.map((h) => [h.backendKey, markOf(h.state)]));
  const rows = [...pools]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((p) => {
      const members = backends
        .filter((b) => b.pool === p.key)
        .map((b) => ({
          key: b.key,
          host: b.host,
          port: b.port,
          weight: b.weight ?? 1,
          state: state.get(b.key) ?? 'unknown',
        }))
        .sort((a, b) => a.key.localeCompare(b.key));
      return {
        key: p.key,
        protocolClass: p.protocolClass,
        algorithm: p.algorithm,
        backends: members,
        healthy: members.filter((m) => m.state === 'healthy').length,
        unknown: members.filter((m) => m.state === 'unknown').length,
        unhealthy: members.filter((m) => m.state === 'unhealthy').length,
      };
    });
  return { rows };
}

/** 델타 한 줄. 풀·백엔드 목록을 다시 치지 않는다. */
export function applyHealthFlip(view: PoolsView, flip: HealthFact): PoolsView {
  const next = markOf(flip.state);
  return {
    rows: view.rows.map((p) => {
      if (!p.backends.some((b) => b.key === flip.backendKey)) return p;
      const backends = p.backends.map((b) => (
        b.key === flip.backendKey ? { ...b, state: next } : b
      ));
      return {
        ...p,
        backends,
        healthy: backends.filter((m) => m.state === 'healthy').length,
        unknown: backends.filter((m) => m.state === 'unknown').length,
        unhealthy: backends.filter((m) => m.state === 'unhealthy').length,
      };
    }),
  };
}

/**
 * 백엔드가 **왜 트래픽을 안 받나** — 화면 쪽 (제안 #9, 2026-08-23).
 *
 * `GET /backends/status` 를 냈는데 화면이 안 읽고 있었다. 그러면 운영자는 CLI 로만
 * 그 답을 얻고, §12.1 이 *"GUI 는 맨 뒤로 미루지 않는다"* 라고 적어 둔 것이 반쪽이 된다.
 *
 * **헬스 표시를 덮어쓰지 않는다.** 화면에는 이미 `살아 있다`/`빠진다` 가 있고, 이 API 가
 * 답하려던 것은 정확히 **헬스가 초록인데 트래픽이 0 인 경우**다(풀이 어디에도 안 걸림 ·
 * 드레인 중). 같은 칸에 쓰면 그 구분이 사라진다.
 */
const REASON_TEXT: Record<string, string> = {
  unhealthy: '프로버가 죽었다고 봤다',
  draining: '드레인 중이다',
  pool_not_routed: '이 풀을 가리키는 리스너·라우트가 없다',
  pool_missing: '풀이 없다',
};

/**
 * 이유 코드 → 사람 말. **모르는 코드는 그대로 낸다.**
 *
 * 서버가 새 이유를 더했을 때 화면이 그것을 감추면, 운영자는 "이유가 없는데 트래픽이
 * 0" 을 본다 — 못 읽는 코드를 보여 주는 편이 낫다.
 */
export const reasonLabels = (codes: readonly string[]): string[] =>
  codes.map((c) => REASON_TEXT[c] ?? c);

export type TrafficMark = { reasons: string[] };

/**
 * 표시할 것이 있으면 낸다.
 *
 * **관측이 없으면 `undefined`** — 상태 API 가 아직 안 왔거나 그 줄이 없는 것을
 * "이유 없음 = 받는 중" 으로 읽으면 못 읽은 것이 초록으로 보인다.
 *
 * 받는 중이어도 `undefined` 다. 매번 나오는 줄은 안 읽게 된다.
 */
export function trafficMarkOf(
  row: { receivingTraffic: boolean; reasons: readonly string[] } | undefined,
): TrafficMark | undefined {
  if (row === undefined) return undefined;
  if (row.receivingTraffic) return undefined;
  return { reasons: reasonLabels(row.reasons) };
}
