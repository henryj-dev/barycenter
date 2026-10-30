/**
 * 리비전 목록과 리소스별 기록 (GUI 경로 분리, 2026-10-30).
 *
 * `/change/history` 는 리비전 목록을, 상세의 「기록」 탭은 「이 리소스를 바꾼 리비전」 을 읽는다.
 * 둘 다 `config_revisions` 의 스냅샷에서 나온다. 감사 로그는 changeset 단위라 리소스를 모른다.
 *
 * 재는 것:
 *   · 이웃 리비전의 그 항목을 비교한다 — 다른 리소스만 바뀐 리비전은 안 나온다
 *   · 만들기 · 바꾸기 · 빼기를 가른다. before/after 를 싣는다
 *   · 창의 맨 앞은 `created` 라고 말하지 않는다(그 앞을 안 봤다)
 *   · 롤백 리비전은 rollbackOf 를 싣는다
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ConfigStore, type PatchOp } from '../../src/store/config-store.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('config-history');

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

const PUT = (kind: PatchOp extends { kind: infer K } ? K : never, key: string, body: unknown): PatchOp =>
  ({ op: 'put', kind, key, body });

const listener = (port: number): PatchOp => PUT('listener', 'edge', {
  protocol: 'http', bind: '0.0.0.0', port, enabled: true, http: { defaultAction: { pool: 'app' } },
});

/** 빈 풀은 저장되지 않는다 — 백엔드 하나를 함께 넣는다. */
const appPool: PatchOp[] = [
  PUT('pool', 'app', { protocolClass: 'http', algorithm: 'round_robin' }),
  PUT('backend', 'app-1', { pool: 'app', host: '10.0.0.1', port: 8080, weight: 1 }),
];

async function commitAll(ops: PatchOp[], by = 't'): Promise<string> {
  const head = await store.head();
  const cs = await store.createChangeset(head.revision, by);
  await store.patchChangeset(cs, ops, by);
  const plan = await store.plan(cs, by);
  return (await store.commit(cs, plan.id, by)).revision;
}

describe('리소스별 기록', () => {
  it('그 리소스가 바뀐 리비전만 — 만들기·바꾸기·빼기를 가르고 before/after 를 싣는다', async () => {
    const r1 = await commitAll([
      PUT('pool', 'app', { protocolClass: 'http', algorithm: 'round_robin' }),
      PUT('backend', 'app-1', { pool: 'app', host: '10.0.0.1', port: 8080, weight: 1 }),
      listener(80),
    ], 'alice');
    // 다른 리소스만 바뀐 리비전 — 리스너 기록에 안 나와야 한다.
    const r2 = await commitAll([PUT('backend', 'app-2', { pool: 'app', host: '10.0.0.2', port: 8080, weight: 1 })]);
    const r3 = await commitAll([listener(8080)], 'bob');
    const r4 = await commitAll([{ op: 'delete', kind: 'listener', key: 'edge' }]);

    const h = await store.resourceHistory('listener', 'edge');
    expect(h.map((c) => [c.revision, c.change])).toEqual([[r4, 'deleted'], [r3, 'changed'], [r1, 'created']]);
    expect(h.some((c) => c.revision === r2)).toBe(false);
    const changed = h.find((c) => c.revision === r3)!;
    expect(changed.createdBy).toBe('bob');
    expect(changed.changeset).toMatch(/^[0-9a-f-]{36}$/);
    expect((changed.before as { port: number }).port).toBe(80);
    expect((changed.after as { port: number }).port).toBe(8080);
    expect(h.find((c) => c.revision === r4)!.after).toBeNull();

    // 백엔드 app-2 는 r2 에서 생겼다.
    expect((await store.resourceHistory('backend', 'app-2')).map((c) => c.change)).toEqual(['created']);
    // 없는 리소스는 빈 목록이다.
    expect(await store.resourceHistory('pool', 'nope')).toEqual([]);
  });

  it('창의 맨 앞은 created 라고 말하지 않는다 — 그 앞을 안 봤다', async () => {
    await commitAll([...appPool, listener(80)]);
    const last = await commitAll([PUT('backend', 'app-2', { pool: 'app', host: '10.0.0.2', port: 8080, weight: 1 })]);
    const h = await store.resourceHistory('listener', 'edge', { scan: 1 });
    expect(h).toEqual([expect.objectContaining({ revision: last, change: 'earliest' })]);
  });

  it('롤백 리비전은 rollbackOf 를 싣는다', async () => {
    const r1 = await commitAll([...appPool, listener(80)]);
    await commitAll([listener(8080)]);
    const back = await store.rollbackTo(r1, 't');
    const h = await store.resourceHistory('listener', 'edge', { limit: 1 });
    expect(h[0]).toMatchObject({ revision: back.revision, change: 'changed', rollbackOf: r1 });
    expect((h[0]!.after as { port: number }).port).toBe(80);
  });
});

describe('리비전 목록', () => {
  it('새 것부터 — changeset·rollbackOf·limit', async () => {
    const r1 = await commitAll(appPool, 'alice');
    const r2 = await commitAll([listener(80)]);
    const back = await store.rollbackTo(r1, 'carol', '되돌림');
    const list = await store.revisions(3);
    expect(list.map((r) => r.revision)).toEqual([back.revision, r2, r1]);
    expect(list[0]).toMatchObject({ rollbackOf: r1, createdBy: 'carol', note: '되돌림', changeset: null });
    expect(list[2]).toMatchObject({ createdBy: 'alice' });
    expect(list[2]!.changeset).toMatch(/^[0-9a-f-]{36}$/);
    expect(await store.revisions(1)).toHaveLength(1);
    // 음수·0 은 1 로 묶는다 — PG 까지 가면 500 이다(검수 B-11).
    expect(await store.revisions(-5)).toHaveLength(1);
  });
});
