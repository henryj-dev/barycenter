/**
 * **클러스터 팔로워** (ADR-CLUSTER, #118) — 실물 PG.
 *
 * 설정 PG 하나를 리더 A 와 팔로워 B 가 함께 본다. 둘은 **데이터 플레인이 따로**다(세대 디렉토리·
 * 에이전트). 재는 것:
 *
 *   · 리더가 적용하면 B 의 `followActive` 가 **같은 이름의 세대**를 자기 쪽에 만들어 활성화한다
 *   · B 는 활성화 전에 fence 하고, 토큰은 `leader_token_seq` 의 마지막 값이다
 *   · B 는 `operations` 에 쓰지 않는다 — 그 표는 리더의 결정 기록이다
 *   · 다시 부르면 `in_sync` 다
 *   · B 의 활성화가 실패하면 노드 상태가 `failed` 이고 오류가 남는다
 *   · `ClusterNode.tick` 이 노드 행을 쓰고 `listClusterNodes` 가 읽는다
 *
 *   npm run test:store     (도커 필요)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigStore, type PatchOp } from '../../src/store/config-store.js';
import { ControlPlane } from '../../src/control/plane.js';
import { ClusterNode, listClusterNodes, nodeStateOf } from '../../src/control/cluster.js';
import { LeaderElection } from '../../src/control/leader.js';
import type { DataplaneDriver } from '../../src/dp/driver.js';
import type { ApplyOperation, ApplyResult } from '../../src/dp/operation.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('cluster-follow');
const CAPS = { httpLua: true, streamLua: true, streamRealip: false, sslConfCommand: true };

/** 상태가 있는 가짜 데이터 플레인. 활성화하면 epoch 이 옮겨 간다. */
class FakeDp {
  epoch = '0';
  generation: string | undefined;
  fenced: string[] = [];
  applied: ApplyOperation[] = [];
  failNext = false;
  readonly driver: DataplaneDriver = {
    fence: (t) => { this.fenced.push(t); return Promise.resolve({ maxToken: t }); },
    applyConfig: (op): Promise<ApplyResult> => {
      this.applied.push(op);
      if (this.failNext) {
        this.failNext = false;
        return Promise.resolve({ phase: 'failed', progress: { http: undefined, stream: undefined }, partialTransition: false } as unknown as ApplyResult);
      }
      this.epoch = op.planes.http!.target.activationEpoch;
      this.generation = op.targetGeneration;
      return Promise.resolve({ phase: 'activated', progress: { http: undefined, stream: undefined }, partialTransition: false });
    },
    recoverConfig: () => Promise.reject(new Error('안 쓴다')),
    abortConfig: () => Promise.resolve(),
    applyMembership: () => Promise.reject(new Error('안 쓴다')),
    pushMembershipDirect: () => Promise.resolve(),
    reconcileConfig: () => Promise.reject(new Error('안 쓴다')),
    status: () => Promise.resolve({
      maxLeaderToken: '0',
      planes: {
        http: { activationEpoch: this.epoch, membershipRevision: '1', payloadDigest: '' },
        stream: { activationEpoch: this.epoch, membershipRevision: '1', payloadDigest: '' },
      },
      published: this.generation === undefined ? { kind: 'none' } : { kind: 'inconsistent', generation: this.generation },
      lastEvidence: this.generation === undefined ? undefined : { acceptingGeneration: this.generation },
      unfinished: undefined,
    } as unknown as Awaited<ReturnType<DataplaneDriver['status']>>),
  };
}

const MODEL: PatchOp[] = [
  { op: 'put', kind: 'pool', key: 'app', body: { protocolClass: 'http', algorithm: 'round_robin' } },
  { op: 'put', kind: 'backend', key: 'a', body: { pool: 'app', host: '10.0.0.1', port: 80, weight: 1 } },
  { op: 'put', kind: 'listener', key: 'front', body: { protocol: 'http', bind: '0.0.0.0', port: 8080, enabled: true, http: { defaultAction: { pool: 'app' } } } },
];

let db: Db;
let store: ConfigStore;
let electionA: LeaderElection;
let electionB: LeaderElection;
let dpA: FakeDp;
let dpB: FakeDp;
let leader: ControlPlane;
let follower: ControlPlane;
const dirs: string[] = [];

const planeOf = (dp: FakeDp, election: LeaderElection): ControlPlane => {
  const prefix = mkdtempSync(join(tmpdir(), 'bary-cluster-'));
  dirs.push(prefix);
  return new ControlPlane(db, store, dp.driver, election, { prefix, adminSocket: join(prefix, 'admin.sock'), renderCaps: CAPS });
};

async function commitAndApply(ops: PatchOp[]): Promise<string> {
  const head = await store.head();
  const cs = await store.createChangeset(head.revision, 't');
  await store.patchChangeset(cs, ops, 't');
  const plan = await store.plan(cs, 't');
  await store.commit(cs, plan.id, 't');
  return (await leader.apply(plan.id, 't')).generation;
}

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 실물 PG 를 쓴다');
  startPg(PG);
  db = new Db(PG.dsn);
  await db.migrate();
  store = new ConfigStore(db, { streamRealip: false });
  electionA = new LeaderElection(PG.dsn, 'web-01');
  if (!(await electionA.tryAcquire())) throw new Error('리더 획득 실패');
  // B 는 락을 잡지 않는다 — 팔로워다.
  electionB = new LeaderElection(PG.dsn, 'web-02');
}, 240_000);

afterAll(async () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  await electionA?.release();
  await db?.close();
  stopPg(PG);
});

beforeEach(async () => {
  await reset(db);
  await db.query('DELETE FROM cluster_nodes');
  dpA = new FakeDp();
  dpB = new FakeDp();
  leader = planeOf(dpA, electionA);
  follower = planeOf(dpB, electionB);
});

describe('팔로워가 리더의 활성 세대를 따라간다', () => {
  it('**같은 이름의 세대를 자기 쪽에 만들고 활성화한다**', async () => {
    const generation = await commitAndApply(MODEL);
    expect(dpA.generation).toBe(generation);

    const r = await follower.followActive('cluster:web-02');
    expect(r).toMatchObject({ kind: 'applied', generation, phase: 'activated' });
    expect(dpB.generation).toBe(generation);
    expect(dpB.epoch).toBe(dpA.epoch);
    // 팔로워 쪽 디렉토리에 같은 이름의 세대가 생겼다.
    const followerPrefix = dirs[dirs.length - 1]!;
    expect(existsSync(join(followerPrefix, 'generations', generation, 'nginx.conf'))).toBe(true);
  });

  it('활성화 **전에** fence 하고, 토큰은 리더 토큰보다 낮지 않다', async () => {
    await commitAndApply(MODEL);
    await follower.followActive('cluster:web-02');
    const leaderToken = dpA.applied[0]!.leaderToken;
    expect(dpB.fenced).toHaveLength(1);
    expect(BigInt(dpB.fenced[0]!) >= BigInt(leaderToken)).toBe(true);
    expect(dpB.applied[0]!.leaderToken).toBe(dpB.fenced[0]);
  });

  it('시퀀스가 리더 토큰보다 낮아도(되돌린 복구) 리더 토큰을 쓴다', async () => {
    await commitAndApply(MODEL);
    await db.query(`SELECT setval('leader_token_seq', 1, false)`);
    await follower.followActive('cluster:web-02');
    expect(dpB.fenced[0]).toBe(dpA.applied[0]!.leaderToken);
  });

  it('`operations` 에 쓰지 않는다 — 리더의 결정 기록이다', async () => {
    await commitAndApply(MODEL);
    const before = (await db.query('SELECT count(*)::int AS n FROM operations')).rows[0]!['n'];
    await follower.followActive('cluster:web-02');
    const after = (await db.query('SELECT count(*)::int AS n FROM operations')).rows[0]!['n'];
    expect(after).toBe(before);
  });

  it('다시 부르면 in_sync 다 — 같은 세대를 다시 만들지 않는다', async () => {
    await commitAndApply(MODEL);
    await follower.followActive('cluster:web-02');
    expect(await follower.followActive('cluster:web-02')).toMatchObject({ kind: 'in_sync' });
    expect(dpB.applied).toHaveLength(1);
  });

  it('새 리비전이 활성화되면 그것을 따라간다', async () => {
    await commitAndApply(MODEL);
    await follower.followActive('cluster:web-02');
    const g2 = await commitAndApply([{ op: 'put', kind: 'listener', key: 'front2', body: { protocol: 'http', bind: '0.0.0.0', port: 8081, enabled: true, http: { defaultAction: { pool: 'app' } } } }]);
    expect(await follower.followActive('cluster:web-02')).toMatchObject({ kind: 'applied', generation: g2 });
    expect(dpB.generation).toBe(g2);
  });

  it('활성 세대가 없으면 아무것도 안 한다', async () => {
    expect(await follower.followActive('cluster:web-02')).toEqual({ kind: 'nothing_active' });
    expect(dpB.applied).toHaveLength(0);
  });
});

describe('노드 상태 (cluster_nodes)', () => {
  it('리더와 팔로워가 각자 자기 행을 쓴다', async () => {
    await commitAndApply(MODEL);
    const a = new ClusterNode(db, leader, dpA.driver, electionA, 'web-01', 'https://web-01:8443');
    const b = new ClusterNode(db, follower, dpB.driver, electionB, 'web-02', undefined);
    expect(await a.tick()).toBe('in_sync');
    expect(await b.tick()).toBe('in_sync');
    const nodes = await listClusterNodes(db, 60_000);
    expect(nodes.map((n) => [n.name, n.role, n.state, n.activeGeneration === dpA.generation])).toEqual([
      ['web-01', 'leader', 'in_sync', true],
      ['web-02', 'follower', 'in_sync', true],
    ]);
    expect(nodes[0]!.url).toBe('https://web-01:8443');
  });

  it('**팔로워의 활성화가 실패하면 failed 와 오류를 남긴다** — 다른 노드는 그대로다', async () => {
    await commitAndApply(MODEL);
    dpB.failNext = true;
    const b = new ClusterNode(db, follower, dpB.driver, electionB, 'web-02', undefined);
    expect(await b.tick()).toBe('failed');
    const [row] = await listClusterNodes(db, 60_000);
    expect(row).toMatchObject({ name: 'web-02', state: 'failed' });
    expect(row!.lastError).toMatch(/활성화하지 못했다/);
    // 다음 주기에 다시 시도해 따라간다.
    expect(await b.tick()).toBe('in_sync');
  });

  it('오래된 신호는 stale 이다', async () => {
    await db.query(`INSERT INTO cluster_nodes (name, role, state, last_seen) VALUES ('web-09', 'follower', 'in_sync', now() - interval '1 hour')`);
    const [row] = await listClusterNodes(db, 60_000);
    expect(row).toMatchObject({ name: 'web-09', stale: true });
  });
});

describe('nodeStateOf', () => {
  it('규칙', () => {
    expect(nodeStateOf(true, undefined)).toBe('in_sync');
    expect(nodeStateOf(false, { kind: 'nothing_active' })).toBe('standalone');
    expect(nodeStateOf(false, new Error('x'))).toBe('failed');
  });
});
