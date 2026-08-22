/**
 * plan 의 시맨틱 영향 — DESIGN.md §5.4 · §2.2-1
 *
 * §5.4 는 아홉 항목을 요구하는데 v0.1 은 다섯만 냈다. 나머지를 채우는 회차의
 * 재현물이다. **여기는 실물 저장소를 지난다** — 순수 함수 단위 검사는
 * `tests/unit/impact-semantics.test.ts` 에 있고, 이 파일이 재는 것은
 * *plan 이 실제로 그 값을 만들어 JSONB 로 왕복하는가* 다.
 *
 *   npm run test:store     (도커 필요)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ConfigStore, type PatchOp } from '../../src/store/config-store.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('impact');

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

/** 리스너 둘. 하나는 http, 하나는 tcp — 서로 다른 풀을 본다. */
const two: PatchOp[] = [
  PUT('pool', 'web', { protocolClass: 'http', algorithm: 'round_robin' }),
  PUT('backend', 'web-1', { pool: 'web', host: '10.0.0.1', port: 80, weight: 1 }),
  PUT('listener', 'front', {
    protocol: 'http', bind: '0.0.0.0', port: 999, enabled: true,
    http: { defaultAction: { pool: 'web' } },
  }),
  PUT('pool', 'game', { protocolClass: 'tcp', algorithm: 'round_robin' }),
  PUT('backend', 'game-1', { pool: 'game', host: '10.0.0.2', port: 7777, weight: 1 }),
  PUT('listener', 'edge', {
    protocol: 'tcp', bind: '0.0.0.0', port: 888, enabled: true, defaultPool: 'game',
  }),
];

async function commitAll(ops: PatchOp[]): Promise<void> {
  const head = await store.head();
  const cs = await store.createChangeset(head.revision, 't');
  await store.patchChangeset(cs, ops, 't');
  const plan = await store.plan(cs, 't');
  await store.commit(cs, plan.id, 't');
}

/** 패치를 얹고 plan 만 낸다 (커밋하지 않는다). */
async function planOf(ops: PatchOp[]) {
  const head = await store.head();
  const cs = await store.createChangeset(head.revision, 't');
  await store.patchChangeset(cs, ops, 't');
  return store.plan(cs, 't');
}

describe('§5.4 affectedListeners — 영향과 목록은 다르다', () => {
  it('영향받는 리스너만 싣는다', async () => {
    await commitAll(two);
    // web 풀의 백엔드만 옮긴다. `edge` 는 game 풀을 보므로 아무 상관이 없다.
    const plan = await planOf([
      PUT('backend', 'web-1', { pool: 'web', host: '10.0.0.9', port: 80, weight: 1 }),
    ]);
    const keys = plan.impact.affectedListeners.map((l) => l.key);
    expect(keys).toEqual(['front']);
  });

  it('지워진 리스너도 영향이다', async () => {
    await commitAll(two);
    const plan = await planOf([{ op: 'delete', kind: 'listener', key: 'edge' }]);
    const edge = plan.impact.affectedListeners.find((l) => l.key === 'edge');
    // 사라진 것은 모델에 없다. 그래도 **영향받은 것 중 가장 큰 것**이다 —
    // 여기서 안 실으면 화면이 "아무 리스너도 영향받지 않는다" 고 말한다.
    expect(edge).toBeDefined();
    expect(edge?.change).toBe('removed');
  });

  it('아무것도 안 바뀌면 아무 리스너도 영향이 아니다', async () => {
    await commitAll(two);
    // 같은 값을 다시 쓴다. 리비전은 움직이지만 내용은 그대로다.
    const plan = await planOf([
      PUT('backend', 'web-1', { pool: 'web', host: '10.0.0.1', port: 80, weight: 1 }),
    ]);
    expect(plan.impact.affectedListeners).toEqual([]);
  });
});
