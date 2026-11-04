/**
 * 적용 대기 리소스 (#126 후속) — 엔진이 돌리는 리비전과 head 를 리소스 하나씩 비교한다.
 *
 * 재는 것: 두 리비전을 커밋하고 첫 리비전만 활성화하면, 둘째에서 바뀐 리소스만 나온다(리스너 단위가 아니다).
 * head 를 활성화하면 빈 목록. 활성화된 적이 없으면 head 의 모든 리소스가 더함이다. API 도 같은 것을 준다.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ConfigStore, type PatchOp } from '../../src/store/config-store.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('pending-resources');
let db: Db;
let store: ConfigStore;

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 실물 PG 를 쓴다');
  startPg(PG);
  db = new Db(PG.dsn);
  await db.migrate();
  store = new ConfigStore(db);
}, 180_000);

afterAll(async () => {
  await db?.close();
  stopPg(PG);
});

beforeEach(async () => {
  await reset(db);
});

async function commit(ops: PatchOp[]): Promise<{ revision: string; planId: string }> {
  const head = await store.head();
  const cs = await store.createChangeset(head.revision, 't');
  await store.patchChangeset(cs, ops, 't');
  const plan = await store.plan(cs, 't');
  return { revision: String((await store.commit(cs, plan.id, 't')).revision), planId: plan.id };
}

/** 적용 작업을 기록으로만 남긴다 — plane 이 남기는 것과 같은 행이다. */
async function activate(p: { revision: string; planId: string }, epoch: number): Promise<void> {
  await db.query(
    `INSERT INTO operations (id, plan_id, revision, activation_epoch, generation, phase, created_by)
     VALUES ($1, $2, $3, $4, $5, 'activated', 't')`,
    [randomUUID(), p.planId, p.revision, epoch, `r${p.revision}-e${epoch}`],
  );
}

const base: PatchOp[] = [
  { op: 'put', kind: 'pool', key: 'web', body: { protocolClass: 'http', algorithm: 'round_robin' } },
  { op: 'put', kind: 'pool', key: 'old', body: { protocolClass: 'http', algorithm: 'round_robin' } },
  { op: 'put', kind: 'backend', key: 'w1', body: { pool: 'web', host: '10.0.0.1', port: 80, weight: 1 } },
  { op: 'put', kind: 'listener', key: 'a', body: { protocol: 'http', bind: '127.0.0.1', port: 18080, enabled: true, http: { defaultAction: { pool: 'web' } } } },
];

describe('적용 대기 리소스 — 활성 리비전과 head', () => {
  it('첫 리비전만 활성화하면 둘째에서 바뀐 리소스만 나온다', async () => {
    const r1 = await commit(base);
    await activate(r1, 1);
    const r2 = await commit([
      { op: 'put', kind: 'backend', key: 'w1', body: { pool: 'web', host: '10.0.0.2', port: 80, weight: 1 } },
      { op: 'put', kind: 'pool', key: 'api', body: { protocolClass: 'http', algorithm: 'round_robin' } },
      { op: 'delete', kind: 'pool', key: 'old' },
    ]);

    const p = await store.pendingResources();
    expect(p.activeRevision).toBe(r1.revision);
    expect(p.headRevision).toBe(r2.revision);
    expect(p.resources).toEqual([
      { kind: 'pool', key: 'api', change: 'added' },
      { kind: 'pool', key: 'old', change: 'removed' },
      { kind: 'backend', key: 'w1', change: 'changed' },
    ]);

    // 리비전이 하나 더 쌓여도 기준은 활성이다 — 그 사이 것까지 모두 나온다.
    await commit([{ op: 'put', kind: 'pool', key: 'web', body: { protocolClass: 'http', algorithm: 'least_conn' } }]);
    expect((await store.pendingResources()).resources.map((r) => `${r.kind}/${r.key}`))
      .toEqual(['pool/api', 'pool/old', 'pool/web', 'backend/w1']);
  });

  it('head 를 활성화하면 빈 목록이다', async () => {
    await activate(await commit(base), 1);
    const r2 = await commit([{ op: 'delete', kind: 'pool', key: 'old' }]);
    await activate(r2, 2);
    const p = await store.pendingResources();
    expect(p).toEqual({ activeRevision: r2.revision, headRevision: r2.revision, resources: [] });
  });

  it('활성화된 적이 없으면 head 의 모든 리소스가 더함이다', async () => {
    const r1 = await commit(base);
    const p = await store.pendingResources();
    expect(p.activeRevision).toBeNull();
    expect(p.headRevision).toBe(r1.revision);
    expect(p.resources.every((r) => r.change === 'added')).toBe(true);
    expect(p.resources.map((r) => `${r.kind}/${r.key}`).sort())
      .toEqual(['backend/w1', 'listener/a', 'pool/old', 'pool/web']);
  });
});
