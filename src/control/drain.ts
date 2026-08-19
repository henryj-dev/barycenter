/**
 * 드레인 시작·관측 (DESIGN.md §6.5 S2 축소).
 *
 * 새 트래픽은 멤버십에서 뺀다. peer 별 inflight/sessions 를 엔진이 안 주면
 * 조건은 `no_new_traffic` 뿐이고 **숫자를 짓지 않는다.**
 */
import type { Db } from '../store/pg.js';

export type DrainCondition = 'no_new_traffic';

export type DrainStatus = {
  backend: string;
  drain_condition: DrainCondition;
};

export async function startDrain(
  db: Db, backendKey: string, by: string, deadlineSeconds?: number,
): Promise<void> {
  const deadline = deadlineSeconds === undefined
    ? null
    : new Date(Date.now() + deadlineSeconds * 1000).toISOString();
  await db.query(
    `INSERT INTO backend_drain (backend_key, started_by, deadline_at)
     VALUES ($1,$2,$3)
     ON CONFLICT (backend_key) DO UPDATE SET
       started_at=now(), started_by=EXCLUDED.started_by, deadline_at=EXCLUDED.deadline_at`,
    [backendKey, by, deadline],
  );
}

export async function drainKeys(db: Db): Promise<Set<string>> {
  const rows = (await db.query('SELECT backend_key FROM backend_drain')).rows;
  return new Set(rows.map((r) => String(r['backend_key'])));
}

export async function isDraining(db: Db, backendKey: string): Promise<boolean> {
  const r = (await db.query(
    'SELECT 1 FROM backend_drain WHERE backend_key=$1', [backendKey],
  )).rows[0];
  return r !== undefined;
}

/**
 * 관측이 없으면 숫자를 안 싣는다. `inflight: 0` 을 기본값으로 두지 않는다.
 */
export function drainStatusOf(opts: {
  backend: string;
  draining: boolean;
  inflight?: number;
  sessions?: number;
}): DrainStatus | undefined {
  if (!opts.draining) return undefined;
  const out: DrainStatus & { inflight?: number; active_sessions?: number } = {
    backend: opts.backend,
    drain_condition: 'no_new_traffic',
  };
  if (opts.inflight !== undefined) out.inflight = opts.inflight;
  if (opts.sessions !== undefined) out.active_sessions = opts.sessions;
  return out;
}
