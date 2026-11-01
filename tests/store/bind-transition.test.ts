/**
 * reload 로 못 여는 소켓은 plan 이 말하고 apply 가 보내기 전에 거절한다 (2026-11-01, web-01).
 *
 * 전에는 reload 를 두 번 보낸 뒤에야 「활성화되지 않았다」 로 끝났다. 원인(bind 실패)은 엔진의 error log 에만 있었다.
 * 드라이버는 부르면 터진다 — 거절이 데이터 플레인에 닿기 **전**인지 잰다.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ControlPlane } from '../../src/control/plane.js';
import { LeaderElection } from '../../src/control/leader.js';
import type { DataplaneDriver } from '../../src/dp/driver.js';
import { ConfigStore, StoreError, type PatchOp } from '../../src/store/config-store.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('bind-transition');
let db: Db;
let store: ConfigStore;
let control: ControlPlane;
let election: LeaderElection;
// 드라이버가 터지므로 쓰이지 않지만, 공유 /tmp 의 고정 이름을 쓰지 않는다.
const dir = mkdtempSync(join(tmpdir(), 'bary-bind-transition-'));
const driver: DataplaneDriver = new Proxy({} as DataplaneDriver, {
  get: (_t, prop) => () => { throw new Error(`데이터 플레인에 닿았다 (호출됨: ${String(prop)})`); },
});

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 실물 PG 를 쓴다');
  startPg(PG);
  db = new Db(PG.dsn);
  await db.migrate();
  store = new ConfigStore(db, { streamRealip: false });
  election = new LeaderElection(PG.dsn, 'bind-transition-test');
  if (!(await election.tryAcquire())) throw new Error('리더 획득 실패');
  control = new ControlPlane(db, store, driver, election,
    { prefix: join(dir, 'prefix'), adminSocket: join(dir, 'admin.sock') });
}, 180_000);

afterAll(async () => {
  await election?.release().catch(() => undefined);
  await db?.close();
  stopPg(PG);
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => { await reset(db); });

async function commit(ops: PatchOp[]): Promise<{ revision: string; planId: string; epoch: string }> {
  const head = await store.head();
  const cs = await store.createChangeset(head.revision, 't');
  await store.patchChangeset(cs, ops, 't');
  const plan = await store.plan(cs, 't');
  const out = await store.commit(cs, plan.id, 't');
  return { revision: String(out.revision), planId: plan.id, epoch: String(out.activationEpoch) };
}

/** 그 리비전이 엔진에서 돌고 있다고 적는다. */
async function activated(p: { revision: string; planId: string; epoch: string }): Promise<void> {
  await db.query(
    `INSERT INTO operations (id, plan_id, revision, activation_epoch, generation, phase, detail, created_by)
     VALUES ($1, $2, $3, $4, $5, 'activated', '{}', 't')`,
    [randomUUID(), p.planId, p.revision, p.epoch, `r${p.revision}-e${p.epoch}`],
  );
  await db.query(`UPDATE plans SET state = 'applied' WHERE id = $1`, [p.planId]);
}

const listener = (key: string, bind: string): PatchOp => ({
  op: 'put', kind: 'listener', key,
  body: { protocol: 'http', bind, port: 18080, enabled: true, http: { defaultAction: 'reject' } },
});

describe('reload 로 못 여는 소켓', () => {
  it('**특정 주소가 돌고 있을 때 와일드카드를 더하면 plan 이 말하고 apply 가 거절한다**', async () => {
    await activated(await commit([listener('site', '127.0.0.1')]));
    const r2 = await commit([listener('default', '0.0.0.0')]);

    const plan = await store.getPlan(r2.planId);
    expect(plan.impact.bindTransitions.map((b) => [b.opens, b.blockedBy])).toEqual([
      ['tcp://0.0.0.0:18080', ['tcp://127.0.0.1:18080']],
    ]);

    const e = await control.apply(r2.planId, 't').then(() => undefined, (x: unknown) => x);
    expect(e).toBeInstanceOf(StoreError);
    expect((e as StoreError).code).toBe('bind_transition');
    expect((e as StoreError).status).toBe(409);
    // 작업 행을 안 남긴다 — 적용 대기에서 빠지지 않고, 고쳐 저장하면 새 plan 이 온다.
    expect((await db.query('SELECT 1 FROM operations WHERE plan_id = $1', [r2.planId])).rows).toEqual([]);
  });

  it('옛 소켓을 닫는 변경은 막히지 않는다 — 두 단계의 첫째', async () => {
    await activated(await commit([listener('site', '127.0.0.1')]));
    const r2 = await commit([{ op: 'delete', kind: 'listener', key: 'site' }]);
    expect((await store.getPlan(r2.planId)).impact.bindTransitions).toEqual([]);
  });

  it('아직 활성화된 적이 없으면 비교할 옛 소켓이 없다', async () => {
    const r1 = await commit([listener('site', '127.0.0.1'), listener('default', '0.0.0.0')]);
    expect((await store.getPlan(r1.planId)).impact.bindTransitions).toEqual([]);
  });
});
