/**
 * 드레인 시작·관측 (DESIGN.md §6.5 S2 축소).
 *
 * 새 트래픽은 멤버십에서 뺀다. peer 별 inflight/sessions 를 엔진이 안 주면
 * 조건은 `no_new_traffic` 뿐이고 **숫자를 짓지 않는다.**
 */
import { resolvePeer } from './membership.js';
import type { Db } from '../store/pg.js';

export type DrainCondition = 'no_new_traffic' | 'quiesced';

export type DrainStatus = {
  backend: string;
  drain_condition: DrainCondition;
};

/**
 * 엔진이 준 관측만 받는다. 필드가 없거나 정수가 아니면 **숫자를 안 만든다.**
 * `inflight: 0` 을 기본값으로 두지 않는다.
 */
/**
 * 슬롯과 같은 키. 밸런서는 resolve 된 IP 로 `in:` 을 올린다.
 * 모델 호스트 이름을 그대로 치면 관측이 있어도 숫자를 못 읽는다.
 */
export async function observationPeerOf(host: string, port: number): Promise<string> {
  return resolvePeer(`${host}:${port}`);
}

/**
 * 엔진 admin 에서 peer 관측을 읽는다. 없거나 깨지면 undefined — 숫자를 안 짓는다.
 */
export async function observePeerFromAdmin(
  fetchImpl: typeof fetch, adminPort: number, peer: string,
): Promise<unknown> {
  try {
    const r = await fetchImpl(
      `http://127.0.0.1:${adminPort}/membership/inflight?peer=${encodeURIComponent(peer)}`,
      { signal: AbortSignal.timeout(2000) },
    );
    if (!r.ok) return undefined;
    const text = await r.text();
    if (text === '' || text === '{}') return undefined;
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function parsePeerObservation(raw: unknown): { inflight: number; sessions: number } | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const inflight = o['inflight'];
  const sessions = o['active_sessions'] ?? o['sessions'];
  if (typeof inflight !== 'number' || typeof sessions !== 'number') return undefined;
  if (!Number.isInteger(inflight) || !Number.isInteger(sessions)) return undefined;
  if (inflight < 0 || sessions < 0) return undefined;
  return { inflight, sessions };
}

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

/**
 * 드레인을 푼다. 없었으면 `false` (검수 B-04).
 *
 * **행을 지운다.** 종료 시각을 적고 남기는 길도 있지만, 이 표는 감사 기록이 아니라
 * 리듀서가 매번 읽는 **현재 상태**다 — 끝난 것을 남기면 읽는 쪽이 매번 걸러야 하고,
 * 그 필터를 한 군데서 빠뜨리면 풀린 백엔드가 계속 빠진다. 누가 언제 뺐다 넣었는지는
 * `audit` 이 든다.
 */
export async function endDrain(db: Db, backendKey: string): Promise<boolean> {
  const r = await db.query('DELETE FROM backend_drain WHERE backend_key=$1', [backendKey]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * 지금 빼야 할 백엔드들.
 *
 * **`deadline_at` 을 읽는다** (검수 B-04). 전에는 저장만 하고 아무도 안 봤다 — API 가
 * `deadline_s` 를 받아 적어 두는데 만료돼도 아무 일이 안 일어났다. 이 저장소가 반복해서
 * 잡는 *"필드는 있는데 아무도 안 읽는다"* 의 한 판이다.
 *
 * 만료된 행을 여기서 지우지는 않는다. 읽기 경로가 쓰면 프로버 틱마다 쓰기가 생기고,
 * 리더가 아닌 인스턴스도 이 함수를 부른다. 지우는 것은 `endDrain` 과 백엔드 삭제
 * CASCADE 의 몫이다.
 */
const LIVE = `deadline_at IS NULL OR deadline_at > now()`;

export async function drainKeys(db: Db): Promise<Set<string>> {
  const rows = (await db.query(
    `SELECT backend_key FROM backend_drain WHERE ${LIVE}`)).rows;
  return new Set(rows.map((r) => String(r['backend_key'])));
}

export async function isDraining(db: Db, backendKey: string): Promise<boolean> {
  // **`drainKeys` 와 같은 조건이어야 한다.** 갈리면 "드레인 중이라는데 트래픽은 간다" 가 된다.
  const r = (await db.query(
    `SELECT 1 FROM backend_drain WHERE backend_key=$1 AND (${LIVE})`, [backendKey],
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
  if (opts.inflight === 0 && opts.sessions === 0) out.drain_condition = 'quiesced';
  return out;
}
