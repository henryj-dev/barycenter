/**
 * 실패한 head 를 같은 리비전으로 다시 적용한다 (2026-11-01, web-01 에서 잡았다).
 *
 * r8 적용이 `nginx -t` 로 실패하자 그 plan 은 작업이 붙어 적용 대기에서 빠졌고, 같은 plan 을 다시 적용하면 멱등이라
 * 실패를 그대로 돌려줬다. 남은 대기 plan(r7)은 head 보다 옛것이라 PLAN_STALE 이었다. 다시 적용할 길이 없었다.
 *
 * 재는 것: failedHead 가 그 상태를 알아본다, replanHead 가 같은 리비전 · 새 epoch 의 plan 을 만들고 그것이 적용
 * 대기에 들어간다, 다시 시도할 것이 없으면 409, 일부만 넘어간 실패는 다시 시도 대상이 아니다.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { pendingApplies } from '../../src/control/plane.js';
import { ConfigStore, type PatchOp } from '../../src/store/config-store.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('apply-retry');
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

async function commit(ops: PatchOp[]): Promise<{ revision: string; planId: string; epoch: string }> {
  const head = await store.head();
  const cs = await store.createChangeset(head.revision, 't');
  await store.patchChangeset(cs, ops, 't');
  const plan = await store.plan(cs, 't');
  const out = await store.commit(cs, plan.id, 't');
  return { revision: String(out.revision), planId: plan.id, epoch: String(out.activationEpoch) };
}

async function record(p: { revision: string; planId: string; epoch: string }, phase: string, detail: unknown): Promise<void> {
  await db.query(
    `INSERT INTO operations (id, plan_id, revision, activation_epoch, generation, phase, detail, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 't')`,
    [randomUUID(), p.planId, p.revision, p.epoch, `r${p.revision}-e${p.epoch}`, phase, JSON.stringify(detail)],
  );
  await db.query(`UPDATE plans SET state = $2 WHERE id = $1`, [p.planId, phase === 'activated' ? 'applied' : 'operation_bound']);
}

const pool: PatchOp[] = [
  { op: 'put', kind: 'pool', key: 'web', body: { protocolClass: 'http', algorithm: 'round_robin' } },
  { op: 'put', kind: 'backend', key: 'w1', body: { pool: 'web', host: '10.0.0.1', port: 80, weight: 1 } },
];
const listener = (port: number): PatchOp => ({
  op: 'put', kind: 'listener', key: 'a',
  body: { protocol: 'http', bind: '127.0.0.1', port, enabled: true, http: { defaultAction: { pool: 'web' } } },
});
const NGINX_T = { phase: 'failed', failure: '엔진이 설정을 거부했다 (nginx -t)', partialTransition: false };

describe('실패한 head 다시 적용', () => {
  it('**head 의 적용이 실패하면 알아보고, 같은 리비전의 새 plan 이 적용 대기에 들어간다**', async () => {
    const r1 = await commit([...pool, listener(18080)]);
    await record(r1, 'activated', { phase: 'activated' });
    const r2 = await commit([listener(18081)]);
    await record(r2, 'failed', NGINX_T);

    expect(await pendingApplies(db)).toEqual([]);                  // 다시 적용할 길이 없던 상태
    expect(await store.failedHead()).toEqual({ revision: r2.revision, planId: r2.planId, failure: NGINX_T.failure });

    const retry = await store.replanHead('t');
    expect(retry.revision).toBe(r2.revision);
    expect(retry.planId).not.toBe(r2.planId);
    const p = await store.getPlan(retry.planId);
    expect(p.state).toBe('committed');
    expect(p.targetRevision).toBe(r2.revision);
    expect(BigInt(p.activationEpoch ?? '0')).toBeGreaterThan(BigInt(r2.epoch));   // 세대 이름이 갈린다
    // 영향은 활성 리비전(r1)과 비교한다.
    expect(p.impact.socketChanges).toEqual({ added: ['tcp://127.0.0.1:18081'], removed: ['tcp://127.0.0.1:18080'] });

    expect(await pendingApplies(db)).toEqual([{ planId: retry.planId, revision: r2.revision }]);
    expect(await store.failedHead()).toBeUndefined();              // 새 plan 이 생겼으니 더 다시 시도할 것이 없다
    expect(await store.head()).toMatchObject({ revision: r2.revision });   // 새 리비전은 안 만든다
  });

  it('다시 시도할 것이 없으면 409 nothing_to_retry 다 — head 가 이미 활성일 때', async () => {
    const r1 = await commit([...pool, listener(18080)]);
    await record(r1, 'activated', { phase: 'activated' });
    expect(await store.failedHead()).toBeUndefined();
    await expect(store.replanHead('t')).rejects.toMatchObject({ status: 409, code: 'nothing_to_retry' });
  });

  it('적용 대기 plan 이 이미 있으면 다시 시도하지 않는다 — 그걸 적용하면 된다', async () => {
    await commit([...pool, listener(18080)]);
    expect(await store.failedHead()).toBeUndefined();
  });

  it('**일부 평면만 넘어간 실패는 다시 시도 대상이 아니다** — /recover 의 몫이다', async () => {
    const r1 = await commit([...pool, listener(18080)]);
    await record(r1, 'activated', { phase: 'activated' });
    const r2 = await commit([listener(18081)]);
    await record(r2, 'failed', { ...NGINX_T, partialTransition: true });
    expect(await store.failedHead()).toBeUndefined();
  });

  it('다시 시도한 것도 실패하면 또 다시 시도할 수 있다', async () => {
    const r1 = await commit([...pool, listener(18080)]);
    await record(r1, 'activated', { phase: 'activated' });
    const r2 = await commit([listener(18081)]);
    await record(r2, 'failed', NGINX_T);
    const retry = await store.replanHead('t');
    const p = await store.getPlan(retry.planId);
    await record({ revision: r2.revision, planId: retry.planId, epoch: p.activationEpoch ?? '0' }, 'failed', { ...NGINX_T, failure: '두 번째' });
    expect(await store.failedHead()).toMatchObject({ revision: r2.revision, planId: retry.planId, failure: '두 번째' });
  });
});

/**
 * 활성 head 를 다시 렌더한다 (2026-11-01, web-01). #163 이 기본 동작 location 에 X-Forwarded-For 를 더했는데, 배포해도
 * nginx 에 나가지 않았다. head 는 이미 활성이고, 같은 plan 은 멱등이고, 지금 리비전으로의 롤백은 막혀 있었다.
 */
describe('활성 head 다시 렌더', () => {
  it('**활성 head 의 새 plan 이 적용 대기에 들어간다** — 같은 리비전, 새 epoch, 새 리비전 없음', async () => {
    const r1 = await commit([...pool, listener(18080)]);
    await record(r1, 'activated', { phase: 'activated' });
    expect(await pendingApplies(db)).toEqual([]);

    const again = await store.replanActiveHead('t');
    expect(again.revision).toBe(r1.revision);
    const p = await store.getPlan(again.planId);
    expect(p.state).toBe('committed');
    expect(p.targetRevision).toBe(r1.revision);
    expect(BigInt(p.activationEpoch ?? '0')).toBeGreaterThan(BigInt(r1.epoch));
    expect(p.impact.socketChanges).toEqual({ added: [], removed: [] });
    expect(await pendingApplies(db)).toEqual([{ planId: again.planId, revision: r1.revision }]);
    expect(await store.head()).toMatchObject({ revision: r1.revision });
  });

  it('적용 대기 plan 이 이미 있으면 409 pending_exists 다', async () => {
    const r1 = await commit([...pool, listener(18080)]);
    await record(r1, 'activated', { phase: 'activated' });
    await store.replanActiveHead('t');
    await expect(store.replanActiveHead('t')).rejects.toMatchObject({ status: 409, code: 'pending_exists' });
  });

  it('head 가 활성이 아니면 409 head_not_active 다 — 적용 대기나 실패를 먼저 처리한다', async () => {
    const r1 = await commit([...pool, listener(18080)]);
    await record(r1, 'activated', { phase: 'activated' });
    const r2 = await commit([listener(18081)]);
    await expect(store.replanActiveHead('t')).rejects.toMatchObject({ status: 409, code: 'head_not_active' });
    await record(r2, 'failed', NGINX_T);
    await expect(store.replanActiveHead('t')).rejects.toMatchObject({ status: 409, code: 'head_not_active' });
  });
});
