/**
 * 클러스터 노드 (ADR-CLUSTER, #118).
 *
 * 한 주기에 하는 일:
 *   1. 리더가 아니면 `followActive` — PG 의 활성 세대를 자기 nginx 에 옮긴다.
 *      맞으면 멤버십만 다시 투영한다(헬스는 리더가 본다 — reload 없음).
 *   2. 자기 행을 `cluster_nodes` 에 쓴다. 다른 노드의 행은 쓰지 않는다.
 *
 * **한 주기가 끝나기 전에 다음 주기를 시작하지 않는다.** 활성화는 수 초가 걸릴 수 있고,
 * 겹쳐 부르면 같은 노드의 에이전트에 두 전환이 동시에 들어간다.
 */
import type { ControlPlane, FollowResult } from './plane.js';
import type { LeaderElection } from './leader.js';
import type { DataplaneDriver } from '../dp/driver.js';
import type { Db } from '../store/pg.js';
import { log } from '../obs/log.js';

export type NodeState = 'in_sync' | 'following' | 'failed' | 'standalone';

/** 한 주기의 결과 → 노드 상태. 순수 함수라 테스트가 직접 부른다. */
export function nodeStateOf(isLeader: boolean, r: FollowResult | Error | undefined): NodeState {
  if (r instanceof Error) return 'failed';
  if (isLeader) return 'in_sync';
  if (r === undefined || r.kind === 'nothing_active') return 'standalone';
  if (r.kind === 'in_sync') return 'in_sync';
  return r.phase === 'activated' ? 'in_sync' : 'failed';
}

export class ClusterNode {
  #timer: ReturnType<typeof setInterval> | undefined;
  #busy = false;
  #lastError: string | undefined;

  constructor(
    private readonly db: Db,
    private readonly control: ControlPlane,
    private readonly driver: DataplaneDriver,
    private readonly election: LeaderElection,
    private readonly name: string,
    private readonly url: string | undefined,
  ) {}

  start(intervalMs: number): void {
    void this.tick();
    this.#timer = setInterval(() => { void this.tick(); }, intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** 한 주기. 겹치면 건너뛴다. 결과를 돌려준다 — 테스트와 진단이 읽는다. */
  async tick(): Promise<NodeState | undefined> {
    if (this.#busy) return undefined;
    this.#busy = true;
    try {
      const isLeader = this.election.state.isLeader;
      let result: FollowResult | Error | undefined;
      if (!isLeader) {
        try {
          // 활성화가 수 초 걸릴 수 있다 — 그동안 화면은 「따라가는 중」을 본다 (#120).
          result = await this.control.followActive(`cluster:${this.name}`,
            async () => { await this.report(false, 'following'); });
          if (result.kind === 'in_sync') await this.control.projectHealth();
          if (result.kind === 'applied') {
            log.info('cluster.followed', { node: this.name, generation: result.generation, phase: result.phase });
          }
        } catch (e) {
          result = e instanceof Error ? e : new Error(String(e));
          log.warn('cluster.follow.failed', { node: this.name, error: result.message });
        }
      }
      const state = nodeStateOf(isLeader, result);
      this.#lastError = result instanceof Error ? result.message
        : (result !== undefined && result.kind === 'applied' && result.phase !== 'activated')
          ? `활성화하지 못했다 (${result.phase})` : (state === 'failed' ? this.#lastError : undefined);
      await this.report(isLeader, state);
      return state;
    } finally {
      this.#busy = false;
    }
  }

  private async report(isLeader: boolean, state: NodeState): Promise<void> {
    let epoch: string | undefined;
    let generation: string | undefined;
    try {
      const st = await this.driver.status();
      epoch = st.planes.http.activationEpoch;
      // 활성화 증거의 세대가 가장 정확하다(엔진이 실제로 받는 세대). 없으면 게시 기록.
      generation = st.lastEvidence?.acceptingGeneration
        ?? (st.published.kind === 'owned' ? st.published.record.generation
          : st.published.kind === 'inconsistent' ? st.published.generation : undefined);
    } catch { /* 모르면 비워 둔다 — 지어내지 않는다 */ }
    await this.db.query(
      `INSERT INTO cluster_nodes (name,url,role,active_epoch,active_generation,state,last_error,last_seen,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now())
       ON CONFLICT (name) DO UPDATE SET url=EXCLUDED.url, role=EXCLUDED.role,
         active_epoch=EXCLUDED.active_epoch, active_generation=EXCLUDED.active_generation,
         state=EXCLUDED.state, last_error=EXCLUDED.last_error, last_seen=now(), updated_at=now()`,
      [this.name, this.url ?? null, isLeader ? 'leader' : 'follower',
        epoch === undefined || epoch === '0' ? null : epoch, generation ?? null, state, this.#lastError ?? null],
    ).catch((e: unknown) => log.warn('cluster.report.failed', { node: this.name, error: String(e) }));
  }
}

/** API·CLI 가 읽는 모양. `stale` 은 마지막 신호가 오래된 노드다. */
export type ClusterNodeView = {
  name: string; url?: string; role: 'leader' | 'follower';
  activeEpoch?: string; activeGeneration?: string;
  state: NodeState; lastError?: string; lastSeen: string; stale: boolean;
  /**
   * **리더와 다른 epoch 을 서빙한다** (#120 「뒤처짐」). 둘 다 알 때만 참이다 — 모르는 것을
   * 뒤처졌다고 하지 않는다. 따라가는 중인 노드도 잠깐 참이다; 화면은 state 를 먼저 본다.
   */
  behind: boolean;
};

export async function listClusterNodes(db: Db, staleAfterMs: number): Promise<ClusterNodeView[]> {
  const rows = (await db.query(
    `SELECT name, url, role, active_epoch::text AS epoch, active_generation, state, last_error,
            last_seen, (now() - last_seen) > ($1::text || ' milliseconds')::interval AS stale
       FROM cluster_nodes ORDER BY name`, [String(staleAfterMs)],
  )).rows;
  const leaderEpoch = rows.find((r) => r['role'] === 'leader' && r['epoch'] != null)?.['epoch'];
  return rows.map((r) => ({
    name: String(r['name']),
    ...(r['url'] == null ? {} : { url: String(r['url']) }),
    role: r['role'] === 'leader' ? 'leader' : 'follower',
    ...(r['epoch'] == null ? {} : { activeEpoch: String(r['epoch']) }),
    ...(r['active_generation'] == null ? {} : { activeGeneration: String(r['active_generation']) }),
    state: String(r['state']) as NodeState,
    ...(r['last_error'] == null ? {} : { lastError: String(r['last_error']) }),
    lastSeen: new Date(r['last_seen'] as string).toISOString(),
    stale: r['stale'] === true,
    behind: r['role'] === 'follower' && leaderEpoch != null && r['epoch'] != null
      && String(r['epoch']) !== String(leaderEpoch),
  }));
}

/** 지금 리더와 리더가 된 시각 (#120). `leadership` 은 관측용 기록이다 — 락 자체가 아니다. */
export async function currentLeader(db: Db): Promise<{ name: string; since: string } | undefined> {
  const r = (await db.query(
    `SELECT holder, acquired_at FROM leadership WHERE released_at IS NULL ORDER BY token DESC LIMIT 1`,
  )).rows[0];
  if (r === undefined) return undefined;
  return { name: String(r['holder']), since: new Date(r['acquired_at'] as string).toISOString() };
}

/** 노드 하나의 최근 적용 기록 (#120). 팔로워의 `cluster.follow` 감사 행이다. */
export type NodeApplyRecord = { at: string; revision?: string; generation?: string; phase?: string };

export async function nodeHistory(db: Db, name: string, limit = 20): Promise<NodeApplyRecord[]> {
  const rows = (await db.query(
    `SELECT at, revision::text AS revision, after FROM audit
      WHERE principal = $1 AND action = 'cluster.follow'
      ORDER BY at DESC LIMIT $2`, [`cluster:${name}`, limit],
  )).rows;
  return rows.map((r) => {
    const after = (r['after'] ?? {}) as { generation?: string; phase?: string };
    return {
      at: new Date(r['at'] as string).toISOString(),
      ...(r['revision'] == null ? {} : { revision: String(r['revision']) }),
      ...(after.generation === undefined ? {} : { generation: after.generation }),
      ...(after.phase === undefined ? {} : { phase: after.phase }),
    };
  });
}
