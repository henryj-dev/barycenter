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
