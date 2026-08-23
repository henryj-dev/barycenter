/**
 * 제안 #10 의 남은 절반 — **`plans` 와 `changesets` 에도 상한이 있다** (2026-08-23).
 *
 * W4-1 이 `health_events`(30일 상한)와 `audit`(안 정하면 안 지운다)을 비대칭으로 닫았다.
 * 나머지는 그대로였다: *"`audit`·`config_revisions`·`plans`·`changesets`·`terminal` 원장
 * 모두 상한이 없다."*
 *
 * ── 무엇을 지우고 무엇을 안 지우나
 *
 * **이 표가 이 파일의 전부다.** 스키마 주석이 이미 답을 적어 뒀다:
 *
 * > TTL 은 `planned` 에만 걸린다 (§5.3). **커밋된 artifact 는 롤백 수단이므로** 보존
 * > 기간이 끝날 때까지 안 지운다 — 24시간 뒤 되돌릴 방법이 사라지는 상황을 안 만든다.
 *
 *   `plans` `expired`·만료된 `planned`   → 지운다. 아무도 못 쓴다
 *   `plans` `committed`·`operation_bound` → **안 지운다.** 롤백 수단이다
 *   `changesets` `discarded`             → 지운다. plans 가 CASCADE 로 따라간다
 *   `changesets` `open`·`sealed`         → **안 지운다.** 누가 편집 중이다
 *   `changesets` `committed`             → **안 지운다.** 커밋된 plan 이 매달려 있다
 *   `config_revisions`                   → 이 회차 뒤로는 **옵트인 접두사 삭제**가 있다.
 *                                          `db-retention-rest.test.ts` 를 본다
 *   `terminal` 원장                      → **안 건드린다.** 부활 방지 장치다.
 *                                          `dp/agent.ts` 의 `prune` 머리말이 근거다
 *
 * `config_revisions` 는 W4-1 이 "안 건드린다" 로 적어 뒀는데, 그 뒤 회차가 **사슬을
 * 안 깨는 규칙**을 찾아 옵트인으로 열었다 — 켜도 대개 아무것도 안 지운다. `terminal` 은
 * 그대로다: 지우면 운영자가 포기한 전환이 되살아난다.
 *
 *   npm run test:store     (도커 필요)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { sweepDatabase } from '../../src/store/db-retention.js';
import { ConfigStore } from '../../src/store/config-store.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('retplan');

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

const count = async (t: 'plans' | 'changesets'): Promise<number> =>
  Number((await db.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0]!['n']);

/** 나이를 뒤로 민다 — 시계를 기다리지 않는다. */
const age = async (t: 'plans' | 'changesets', col: string, days: number): Promise<void> => {
  await db.query(`UPDATE ${t} SET ${col} = now() - make_interval(days => $1::int)`, [String(days)]);
};

describe('plan·changeset 보존 (제안 #10)', () => {
  it('**만료된 plan 을 지운다**', async () => {
    const head = await store.head();
    const cs = await store.createChangeset(head.revision, 't');
    await store.patchChangeset(cs, [
      { op: 'put', kind: 'pool', key: 'app', body: { protocolClass: 'http', algorithm: 'round_robin' } },
      { op: 'put', kind: 'backend', key: 'a', body: { pool: 'app', host: '10.0.0.1', port: 80, weight: 1 } },
    ], 't');
    await store.plan(cs, 't');
    expect(await count('plans')).toBe(1);

    // 만료시킨다. 커밋 안 된 plan 은 아무도 못 쓴다.
    await db.query("UPDATE plans SET expires_at = now() - interval '1 day'");
    const r = await sweepDatabase({ db, planDays: 1 });
    expect(r.plans).toBe(1);
    expect(await count('plans')).toBe(0);
  });

  it('**커밋된 plan 은 안 지운다** — 롤백 수단이다', async () => {
    const head = await store.head();
    const cs = await store.createChangeset(head.revision, 't');
    await store.patchChangeset(cs, [
      { op: 'put', kind: 'pool', key: 'app', body: { protocolClass: 'http', algorithm: 'round_robin' } },
      { op: 'put', kind: 'backend', key: 'a', body: { pool: 'app', host: '10.0.0.1', port: 80, weight: 1 } },
    ], 't');
    const plan = await store.plan(cs, 't');
    await store.commit(cs, plan.id, 't');

    // 아주 오래된 것으로 밀어도 남는다.
    await age('plans', 'created_at', 3650);
    await db.query("UPDATE plans SET expires_at = now() - interval '3650 days'");
    const r = await sweepDatabase({ db, planDays: 1 });
    expect(r.plans, '커밋된 plan 이 지워졌다 — 롤백 수단이 사라진다').toBe(0);
    expect(await count('plans')).toBe(1);
  });

  it('**버려진 changeset 을 지운다** — plan 이 CASCADE 로 따라간다', async () => {
    const head = await store.head();
    const cs = await store.createChangeset(head.revision, 't');
    await store.patchChangeset(cs, [
      { op: 'put', kind: 'pool', key: 'app', body: { protocolClass: 'http', algorithm: 'round_robin' } },
      { op: 'put', kind: 'backend', key: 'a', body: { pool: 'app', host: '10.0.0.1', port: 80, weight: 1 } },
    ], 't');
    await store.plan(cs, 't');
    await store.discardChangeset(cs, 't');
    await age('changesets', 'created_at', 40);

    const r = await sweepDatabase({ db, changesetDays: 30 });
    expect(r.changesets).toBe(1);
    expect(await count('changesets')).toBe(0);
    // FK 가 CASCADE 라 plan 도 함께 간다 — 고아를 남기지 않는다.
    expect(await count('plans')).toBe(0);
  });

  it('**열려 있는 changeset 은 안 지운다** — 누가 편집 중이다', async () => {
    const head = await store.head();
    await store.createChangeset(head.revision, 't');
    await age('changesets', 'created_at', 3650);
    const r = await sweepDatabase({ db, changesetDays: 1 });
    expect(r.changesets).toBe(0);
    expect(await count('changesets')).toBe(1);
  });

  it('**커밋된 changeset 은 안 지운다** — 커밋된 plan 이 매달려 있다', async () => {
    const head = await store.head();
    const cs = await store.createChangeset(head.revision, 't');
    await store.patchChangeset(cs, [
      { op: 'put', kind: 'pool', key: 'app', body: { protocolClass: 'http', algorithm: 'round_robin' } },
      { op: 'put', kind: 'backend', key: 'a', body: { pool: 'app', host: '10.0.0.1', port: 80, weight: 1 } },
    ], 't');
    const plan = await store.plan(cs, 't');
    await store.commit(cs, plan.id, 't');
    await age('changesets', 'created_at', 3650);

    const r = await sweepDatabase({ db, changesetDays: 1 });
    expect(r.changesets).toBe(0);
    expect(await count('changesets')).toBe(1);
  });

  it('**안 정하면 안 지운다** — 기존 배포의 보존을 조용히 바꾸지 않는다', async () => {
    const head = await store.head();
    await store.createChangeset(head.revision, 't');
    await db.query("UPDATE changesets SET state='discarded'");
    await age('changesets', 'created_at', 3650);

    const r = await sweepDatabase({ db });
    expect(r.changesets).toBe(0);
    expect(r.plans).toBe(0);
  });

  it('나이 값을 검사한다 — SQL 로 가는 자유 문자열을 안 만든다', async () => {
    await expect(sweepDatabase({ db, planDays: 0 })).rejects.toThrow();
    await expect(sweepDatabase({ db, changesetDays: 1.5 })).rejects.toThrow();
  });

  it('`config_revisions` 는 안 건드린다 — 롤백과 시크릿 GC root 다', async () => {
    const before = Number((await db.query('SELECT count(*)::int AS n FROM config_revisions')).rows[0]!['n']);
    await sweepDatabase({ db, planDays: 1, changesetDays: 1, auditDays: 1, healthEventDays: 1 });
    const after = Number((await db.query('SELECT count(*)::int AS n FROM config_revisions')).rows[0]!['n']);
    expect(after).toBe(before);
  });
});
