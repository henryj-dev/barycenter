/**
 * plan 의 영향은 **지금 엔진이 돌리는 리비전**과 비교한다 (2026-11-01, web-01 에서 잡았다).
 *
 * web-01: r4 가 적용된 뒤 r8 이 0.0.0.0:443 · :80 을 열려다 `nginx -t` 로 실패했다. 그 뒤 바인드를 바꾼 r10 의 plan 이
 * base(r9) 와 비교해 「0.0.0.0:443 · :80 을 닫아요」 라고 했다 — 한 번도 열린 적 없는 소켓이다.
 *
 * 재는 것: 활성화된 리비전이 있으면 그것과 비교한다(닫힘에 안 열린 소켓이 없고, 열림에 실패한 리비전의 소켓이 다시
 * 나온다). 활성화된 적이 없으면 전처럼 base 와 비교한다.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ConfigStore, type PatchOp } from '../../src/store/config-store.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('impact-vs-active');
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

async function plan(ops: PatchOp[]) {
  const head = await store.head();
  const cs = await store.createChangeset(head.revision, 't');
  await store.patchChangeset(cs, ops, 't');
  return store.plan(cs, 't');
}

/** 적용 작업을 기록으로만 남긴다 — plane 이 남기는 것과 같은 행이다. */
async function record(p: { revision: string; planId: string }, phase: 'activated' | 'failed', epoch: number): Promise<void> {
  await db.query(
    `INSERT INTO operations (id, plan_id, revision, activation_epoch, generation, phase, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, 't')`,
    [randomUUID(), p.planId, p.revision, epoch, `r${p.revision}-e${epoch}`, phase],
  );
}

const base: PatchOp[] = [
  { op: 'put', kind: 'pool', key: 'web', body: { protocolClass: 'http', algorithm: 'round_robin' } },
  { op: 'put', kind: 'backend', key: 'w1', body: { pool: 'web', host: '10.0.0.1', port: 80, weight: 1 } },
  { op: 'put', kind: 'listener', key: 'a', body: { protocol: 'http', bind: '127.0.0.1', port: 18080, enabled: true, http: { defaultAction: { pool: 'web' } } } },
];
const wide: PatchOp = { op: 'put', kind: 'listener', key: 'b', body: { protocol: 'http', bind: '0.0.0.0', port: 18081, enabled: true, http: { defaultAction: { pool: 'web' } } } };
const narrow: PatchOp = { op: 'put', kind: 'listener', key: 'b', body: { protocol: 'http', bind: '127.0.0.1', port: 18081, enabled: true, http: { defaultAction: { pool: 'web' } } } };

describe('plan 의 영향 — 비교 기준', () => {
  it('**활성화된 리비전과 비교한다** — 적용이 실패한 리비전의 소켓을 닫는다고 하지 않는다', async () => {
    const r1 = await commit(base);
    await record(r1, 'activated', 1);
    const r2 = await commit([wide]);            // 0.0.0.0:18081 을 열려다
    await record(r2, 'failed', 2);               // 실패했다 — 엔진은 r1 그대로
    const p = await plan([narrow]);              // 바인드를 바꾼다

    expect(p.impact.socketChanges).toEqual({ added: ['tcp://127.0.0.1:18081'], removed: [] });
  });

  it('활성화된 리비전과 같은 소켓은 「열림」 에 안 나온다 — 커밋만 된 리비전이 사이에 있어도', async () => {
    const r1 = await commit(base);
    await record(r1, 'activated', 1);
    await commit([wide]);                        // 커밋만 — 적용 안 함
    const p = await plan([{ op: 'delete', kind: 'listener', key: 'b' }]);

    // base(r2) 와 비교하면 0.0.0.0:18081 을 「닫음」 이라 했다. 엔진에는 없는 소켓이다.
    expect(p.impact.socketChanges).toEqual({ added: [], removed: [] });
  });

  it('활성화된 적이 없으면 전처럼 base 와 비교한다', async () => {
    await commit(base);
    const p = await plan([wide]);
    expect(p.impact.socketChanges).toEqual({ added: ['tcp://0.0.0.0:18081'], removed: [] });
  });

  it('activeRevision 은 가장 큰 activation_epoch 의 활성화를 준다 — 실패는 안 센다', async () => {
    expect(await store.activeRevision()).toBeUndefined();
    const r1 = await commit(base);
    await record(r1, 'activated', 1);
    const r2 = await commit([wide]);
    await record(r2, 'failed', 2);
    expect(await store.activeRevision()).toBe(r1.revision);
  });
});
