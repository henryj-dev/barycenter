/**
 * 적용 대기에서 **이미 덮인 plan** 을 빼다 (2026-10-31, web-01).
 *
 * ACME 가 발급을 반영하며 r22 를 커밋하고 자동 적용했다. 그 앞의 r20 · r21 은 미적용 plan 으로 남았는데,
 * r22 가 그 변경을 모두 품고 이미 활성화됐다. 그래도 상태는 그것들을 「적용 대기」 로 보였고, 화면의
 * 「적용해요」 가 r21 을 보내 `PLAN_STALE` 로 거절됐다.
 *
 * 재는 것:
 *   · 아무것도 적용 안 했으면 커밋된 plan 이 다 보인다(숨기지 않는다)
 *   · 더 새 리비전이 활성화되면 그 앞의 plan 은 빠지고, 그보다 새 것만 남는다
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { pendingApplies } from '../../src/control/plane.js';
import { ConfigStore, type PatchOp } from '../../src/store/config-store.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('pending-superseded');
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

const pool = (key: string): PatchOp => ({ op: 'put', kind: 'pool', key, body: { protocolClass: 'http', algorithm: 'round_robin' } });

/** 하나 커밋하고 그 plan 과 리비전을 돌려준다. */
async function commit(key: string): Promise<{ planId: string; revision: string }> {
  const head = await store.head();
  const cs = await store.createChangeset(head.revision, 't');
  await store.patchChangeset(cs, [pool(key)], 't');
  const plan = await store.plan(cs, 't');
  const done = await store.commit(cs, plan.id, 't');
  return { planId: plan.id, revision: String(done.revision) };
}

/** 그 plan 을 활성화한 것으로 적는다 — 적용 경로가 남기는 것과 같은 행. */
async function activate(p: { planId: string; revision: string }): Promise<void> {
  await db.query(
    `INSERT INTO operations (id, plan_id, revision, activation_epoch, generation, phase, created_by)
     VALUES ($1, $2, $3, 1, $4, 'activated', 't')`,
    [randomUUID(), p.planId, p.revision, `r${p.revision}-e1`],
  );
  await db.query(`UPDATE plans SET state='applied' WHERE id=$1`, [p.planId]);
}

describe('적용 대기', () => {
  it('아무것도 적용 안 했으면 커밋된 plan 이 다 보인다', async () => {
    const a = await commit('a');
    const b = await commit('b');
    expect((await pendingApplies(db)).map((p) => p.revision)).toEqual([a.revision, b.revision]);
  });

  it('더 새 리비전이 활성화되면 그 앞의 plan 은 빠진다 — 덮였고, 적용하면 PLAN_STALE 이다', async () => {
    const a = await commit('a');
    const b = await commit('b');
    const c = await commit('c');
    const d = await commit('d');
    await activate(c);
    const left = (await pendingApplies(db)).map((p) => p.revision);
    expect(left, `${a.revision} · ${b.revision} 는 ${c.revision} 이 품는다`).toEqual([d.revision]);
  });
});
