/**
 * 리스너 호스트가 저장소를 지나도 남는다 (ADR-VHOST · 029, 2026-10-31).
 *
 * 랩에서 잡았다: GUI 로 호스트 리스너를 만들었는데 `hosts` 가 저장되지 않았다. 리스너는 칸마다 열이 있는
 * 표에 살고, 새 칸은 열 · 읽기 · 쓰기가 모두 있어야 한다. 그래서 둘째 호스트 리스너가 「같은 소켓에 호스트
 * 없는 리스너 둘」 로 읽혀 `socket_conflict` 로 막혔다.
 *
 * 재는 것: 같은 포트의 호스트 리스너 둘이 저장되고, 다시 읽은 모델에 호스트가 그대로 있다. 호스트를 지우면 사라진다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ConfigStore, type PatchOp } from '../../src/store/config-store.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('listener-hosts');
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

async function commit(ops: PatchOp[]): Promise<string> {
  const head = await store.head();
  const cs = await store.createChangeset(head.revision, 't');
  await store.patchChangeset(cs, ops, 't');
  const plan = await store.plan(cs, 't');
  return String((await store.commit(cs, plan.id, 't')).revision);
}

const listener = (key: string, hosts?: string[]): PatchOp => ({
  op: 'put', kind: 'listener', key,
  body: {
    protocol: 'http', bind: '0.0.0.0', port: 18080, enabled: true,
    http: { defaultAction: { pool: 'web' } },
    ...(hosts === undefined ? {} : { hosts }),
  },
});

describe('리스너 호스트 저장', () => {
  it('같은 포트의 호스트 리스너 둘이 저장되고 호스트가 그대로 읽힌다', async () => {
    const rev = await commit([
      { op: 'put', kind: 'pool', key: 'web', body: { protocolClass: 'http', algorithm: 'round_robin' } },
      { op: 'put', kind: 'backend', key: 'w1', body: { pool: 'web', host: '10.0.0.1', port: 80, weight: 1 } },
      listener('a', ['a.test']),
      listener('b', ['b.test', 'www.b.test']),
    ]);
    const m = await store.modelAt(rev);
    expect(m.listeners.find((l) => l.key === 'a')).toMatchObject({ hosts: ['a.test'] });
    expect(m.listeners.find((l) => l.key === 'b')).toMatchObject({ hosts: ['b.test', 'www.b.test'] });
  });

  it('호스트를 빼면 그 리스너는 호스트 없는 리스너로 읽힌다', async () => {
    await commit([
      { op: 'put', kind: 'pool', key: 'web', body: { protocolClass: 'http', algorithm: 'round_robin' } },
      { op: 'put', kind: 'backend', key: 'w1', body: { pool: 'web', host: '10.0.0.1', port: 80, weight: 1 } },
      listener('a', ['a.test']),
    ]);
    const rev = await commit([listener('a')]);
    const a = (await store.modelAt(rev)).listeners.find((l) => l.key === 'a');
    expect(a).toBeDefined();
    expect(a && 'hosts' in a).toBe(false);
  });
});
