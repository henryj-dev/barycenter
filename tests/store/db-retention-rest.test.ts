/**
 * 제안 #10 의 마지막 조각 — **`operations` 와 `config_revisions`** (2026-08-23)
 *
 * W4-1 이 `health_events`·`audit` 을, 앞 회차가 `plans`·`changesets` 를 닫았다. 목록에
 * 남아 있던 것이 이 둘이다.
 *
 * ── 두 표가 서로 다른 이유
 *
 *   `operations`        종단한 것만. 비종단은 **복구가 이어받을 것**이라 나이와 무관하게
 *                       남는다 (§6.2 저널).
 *   `config_revisions`  `parent` 로 이어진 **사슬**이다. 가운데를 못 지운다 —
 *                       가장 오래된 **접두사**만, 그것도 붙잡힌 것이 나오면 거기서 멈춘다.
 *
 * ── 이 파일이 지키는 것
 *
 * 지우는 것보다 **안 지우는 것**이 많다. 그게 맞다 — 상한을 준다는 것과 이력을 버린다는
 * 것은 다르고, 이 표들은 롤백과 멱등 판정이 매달려 있다.
 *
 *   npm run test:store     (도커 필요)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { sweepDatabase } from '../../src/store/db-retention.js';
import { ConfigStore } from '../../src/store/config-store.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('retrest');

let db: Db;
let store: ConfigStore;

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 이 스위트는 실물 PG 를 쓴다');
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

const num = async (sql: string): Promise<number> =>
  Number((await db.query(sql)).rows[0]!['n']);

const countOps = (): Promise<number> => num('SELECT count(*)::int AS n FROM operations');
const countRevs = (): Promise<number> => num('SELECT count(*)::int AS n FROM config_revisions');

/** 리비전 하나를 만든다 — 커밋까지 가면 head 가 옮겨진다. */
async function newRevision(key: string): Promise<string> {
  const head = await store.head();
  const cs = await store.createChangeset(head.revision, 't');
  await store.patchChangeset(cs, [
    { op: 'put', kind: 'pool', key, body: { protocolClass: 'http', algorithm: 'round_robin' } },
    { op: 'put', kind: 'backend', key: `b-${key}`, body: { pool: key, host: '10.0.0.1', port: 80, weight: 1 } },
  ], 't');
  const plan = await store.plan(cs, 't');
  await store.commit(cs, plan.id, 't');
  return plan.id;
}

/** 오퍼레이션 행을 직접 심는다 — 실제 apply 를 태우면 드라이버가 필요하다. */
async function seedOperation(
  planId: string, revision: string, phase: string, ageDays: number,
): Promise<void> {
  await db.query(
    `INSERT INTO operations (id, plan_id, revision, activation_epoch, generation, phase,
                             created_at, updated_at, created_by)
     VALUES (gen_random_uuid(), $1, $2::bigint, 1, 'g', $3,
             now() - make_interval(days => $4::int),
             now() - make_interval(days => $4::int), 't')`,
    [planId, revision, phase, String(ageDays)],
  );
}

describe('operations 보존', () => {
  it('안 정하면 안 지운다 — 무한 보존이 기본이다', async () => {
    const planId = await newRevision('a');
    await newRevision('b');                       // head 를 앞으로 민다
    const rev = String((await store.head()).revision);
    await seedOperation(planId, String(BigInt(rev) - 1n), 'activated', 3650);
    const r = await sweepDatabase({ db });
    expect(r.operations).toBe(0);
    expect(await countOps()).toBe(1);
  });

  it('**종단한 옛 오퍼레이션을 지운다**', async () => {
    const planId = await newRevision('a');
    await newRevision('b');
    await seedOperation(planId, String(BigInt((await store.head()).revision) - 1n), 'activated', 40);
    const r = await sweepDatabase({ db, operationDays: 30 });
    expect(r.operations).toBe(1);
    expect(await countOps()).toBe(0);
  });

  /**
   * **이 검사가 제일 중요하다.** `ControlPlane.apply()` 가 멱등을 이 표로 판정한다 —
   * `findOperation(planId)` 가 있으면 그대로 돌려준다. head 의 오퍼레이션을 지우면
   * 같은 plan 에 apply 를 다시 부를 수 있고, 이미 끝난 전환이 되살아난다.
   */
  it('**head 리비전의 것은 안 지운다** — 멱등 판정이 여기 매달려 있다', async () => {
    const planId = await newRevision('a');
    await seedOperation(planId, String((await store.head()).revision), 'activated', 3650);
    const r = await sweepDatabase({ db, operationDays: 1 });
    expect(r.operations, 'head 의 오퍼레이션이 지워졌다 — apply 가 다시 돈다').toBe(0);
    expect(await countOps()).toBe(1);
  });

  it('비종단은 안 지운다 — 복구가 이어받을 것이다', async () => {
    const planId = await newRevision('a');
    await newRevision('b');
    await seedOperation(planId, String(BigInt((await store.head()).revision) - 1n), 'staged', 3650);
    const r = await sweepDatabase({ db, operationDays: 1 });
    expect(r.operations, '비종단이 지워졌다 — 저널이 이어받을 것을 잃는다').toBe(0);
    expect(await countOps()).toBe(1);
  });

  it('나이가 덜 되면 안 지운다', async () => {
    const planId = await newRevision('a');
    await newRevision('b');
    await seedOperation(planId, String(BigInt((await store.head()).revision) - 1n), 'activated', 5);
    expect((await sweepDatabase({ db, operationDays: 30 })).operations).toBe(0);
  });
});

describe('config_revisions 보존', () => {
  it('안 정하면 안 지운다', async () => {
    await newRevision('a');
    await newRevision('b');
    const before = await countRevs();
    expect((await sweepDatabase({ db })).revisions).toBe(0);
    expect(await countRevs()).toBe(before);
  });

  /**
   * plan 이 `target_revision` 으로 가리키는 리비전은 **붙잡힌다.** 그리고 커밋된 plan 은
   * 안 지워지므로(앞 회차), 실제 배포에서 이 값이 지우는 양은 **대개 0** 이다.
   * 그게 맞는 동작이다 — 롤백 수단을 상한이라는 이름으로 버리지 않는다.
   */
  it('**커밋된 plan 이 가리키면 안 지운다** — 롤백 수단이다', async () => {
    await newRevision('a');
    await newRevision('b');
    await db.query("UPDATE config_revisions SET created_at = now() - interval '3650 days'");
    const before = await countRevs();
    const r = await sweepDatabase({ db, revisionDays: 1 });
    expect(r.revisions, '롤백 수단인 리비전이 지워졌다').toBe(0);
    expect(await countRevs()).toBe(before);
  });

  it('head 는 안 지운다', async () => {
    await db.query("UPDATE config_revisions SET created_at = now() - interval '3650 days'");
    const before = await countRevs();
    expect((await sweepDatabase({ db, revisionDays: 1 })).revisions).toBe(0);
    expect(await countRevs()).toBe(before);
  });

  /**
   * **붙잡힌 것이 나오면 거기서 멈춘다.** 질의는 조건에 걸린 리비전을 그냥 빼고 주므로
   * 결과가 연속이 아닐 수 있는데, 그대로 지우면 사슬 가운데가 사라진다.
   *
   * 리비전 1 을 붙잡아 두면(head 가 아니고 plan 도 없는 2·3 이 있어도) **아무것도**
   * 안 지워져야 한다 — 접두사가 1 에서 시작하는데 1 이 막혔기 때문이다.
   */
  it('접두사 첫 칸이 막히면 그 뒤도 안 지운다 — 사슬에 구멍을 안 낸다', async () => {
    await newRevision('a');
    await newRevision('b');
    await newRevision('c');
    await db.query("UPDATE config_revisions SET created_at = now() - interval '3650 days'");
    // changeset 이 전부를 붙잡고 있으면 이 검사가 무엇을 재는지 흐려진다 — 걷어낸다.
    await db.query('DELETE FROM changesets');
    // 가장 오래된 리비전을 operation 으로 붙잡는다.
    const oldest = String((await db.query(
      'SELECT min(revision)::text AS m FROM config_revisions',
    )).rows[0]!['m']);
    // plan 은 changeset 과 함께 CASCADE 로 사라졌다 — 오퍼레이션을 매달 자리를 새로 만든다.
    await db.query(
      `INSERT INTO changesets (id, base_revision, state, created_at, created_by)
       VALUES (gen_random_uuid(), $1::bigint, 'discarded', now(), 't')`, [oldest],
    );
    const csId = String((await db.query(
      "SELECT id FROM changesets WHERE state='discarded' LIMIT 1",
    )).rows[0]!['id']);
    await db.query(
      `INSERT INTO plans (id, changeset_id, state, base_revision, model, impact,
                          render_digest, renderer_version, expires_at,
                          target_revision, activation_epoch)
       VALUES (gen_random_uuid(), $1, 'operation_bound', $2::bigint, '{}', '{}', 'd', 'v',
               now() + interval '1 day', $2::bigint, 1)`, [csId, oldest],
    );
    const planId = String((await db.query(
      'SELECT id FROM plans ORDER BY created_at LIMIT 1',
    )).rows[0]!['id']);
    await seedOperation(planId, oldest, 'activated', 1);

    const before = await countRevs();
    const r = await sweepDatabase({ db, revisionDays: 1 });
    expect(r.revisions, '막힌 첫 칸을 건너뛰고 지웠다 — 사슬에 구멍이 난다').toBe(0);
    expect(await countRevs()).toBe(before);
  });

  /**
   * 지울 수 있는 모양을 **일부러 만들어** 실제로 지워지는 것도 본다. 안 그러면 위
   * 검사들이 "아무것도 안 지운다" 를 통과시키는 것만으로 초록이 된다.
   *
   * plan 을 지우면(버려진 changeset 경로) 그 리비전을 붙잡는 것이 없어진다.
   */
  it('붙잡는 것이 없으면 가장 오래된 접두사를 지우고 parent 를 끊는다', async () => {
    await newRevision('a');
    await newRevision('b');
    await newRevision('c');
    await db.query("UPDATE config_revisions SET created_at = now() - interval '3650 days'");
    /**
     * 붙잡는 것을 전부 걷어낸다 — 이 테스트는 **사슬 규칙**을 재지 plan·changeset 규칙을
     * 재지 않는다. changeset 은 `base_revision`·`committed_revision` 둘로 붙잡으므로
     * 통째로 지운다(버려진 changeset 청소가 이미 돈 상태를 흉내 낸다).
     */
    await db.query('DELETE FROM changesets');

    const before = await countRevs();
    const r = await sweepDatabase({ db, revisionDays: 1 });
    expect(r.revisions, '지울 수 있는데 아무것도 안 지웠다').toBeGreaterThan(0);
    expect(await countRevs()).toBe(before - r.revisions);

    // 새 최고참의 parent 가 끊겨 있어야 한다 — 안 끊으면 FK 가 애초에 막았을 것이다.
    const top = (await db.query(
      'SELECT parent FROM config_revisions ORDER BY revision LIMIT 1',
    )).rows[0]!;
    expect(top['parent'], '새 최고참이 사라진 리비전을 가리킨다').toBeNull();

    // head 는 살아 있다.
    const headRow = (await db.query(
      'SELECT count(*)::int AS n FROM config_revisions r JOIN config_head h ON h.revision = r.revision',
    )).rows[0]!;
    expect(Number(headRow['n']), 'head 가 사라졌다').toBe(1);
  });
});
