/**
 * 롤백도 스냅샷을 **해독한다** — 검수 2026-08-24 D7
 *
 * ── 이 병은 이미 한 번 이름 붙었다
 *
 * `modelAt` 의 주석이 적어 뒀다:
 *
 * > 전에는 `r['model'] as Model` 이었다. 그건 *지금의* `Model` 모양을 옛 스냅샷이
 * > 갖고 있다고 가정하는 것이고, 스키마가 자라는 순간 거짓이 된다 — v0.6 이 컬렉션
 * > 셋을 더하자 **v0.6 이전 리비전으로 롤백하면 `undefined.map` 으로 500** 이 났다.
 * > 캐스팅은 그 순간까지 아무 말도 안 한다.
 *
 * 그래서 `modelAt` 은 캐스팅을 버리고 `decodeModel` 을 지난다. **`rollbackTo` 는
 * 안 지났다** — 같은 컬럼을 직접 읽어 캐스팅하고 곧바로 `opsOf(model)` 에 넣는데,
 * `opsOf` 는 여덟 컬렉션에 `.map` 을 건다. 고친 것과 정확히 같은 병이 옆자리에 남아
 * 있었다.
 *
 * ── 왜 지금까지 안 드러났나
 *
 * 지금 코드가 만드는 스냅샷은 `readModel` 을 지나므로 **언제나 여덟 컬렉션이 다 있다.**
 * 이 결함은 **업그레이드를 건넌 데이터에서만** 드러난다 — 그것이 이 부류가 매번
 * 늦게 발견되는 이유이고, 재현물이 옛 모양을 **손으로 넣는** 이유다.
 *
 *   npm run test:store     (도커 필요)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ConfigStore, StoreError, type PatchOp } from '../../src/store/config-store.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('rollback-decode');

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

const minimal: PatchOp[] = [
  PUT('pool', 'web', { protocolClass: 'http', algorithm: 'round_robin' }),
  PUT('backend', 'web-1', { pool: 'web', host: '10.0.0.1', port: 80, weight: 1 }),
  PUT('listener', 'front', {
    protocol: 'http', bind: '0.0.0.0', port: 999, enabled: true,
    http: { defaultAction: { pool: 'web' } },
  }),
];

async function commitAll(ops: PatchOp[]): Promise<string> {
  const head = await store.head();
  const cs = await store.createChangeset(head.revision, 't');
  await store.patchChangeset(cs, ops, 't');
  const plan = await store.plan(cs, 't');
  const out = await store.commit(cs, plan.id, 't');
  return out.revision;
}

/**
 * 리비전 하나의 스냅샷을 **옛 모양**으로 바꿔 놓는다.
 *
 * v0.6 이전에는 `certificates` · `tlsPolicies` · `sniBindings` 가 아예 없었다. 그 시절
 * 코드가 만든 행이 지금 코드 밑에 그대로 있는 것 — 업그레이드가 만드는 상태다.
 */
async function stripCollections(revision: string, keys: string[]): Promise<void> {
  const row = (await db.query(
    'SELECT model FROM config_revisions WHERE revision = $1', [revision])).rows[0];
  const model = { ...(row?.['model'] as Record<string, unknown>) };
  for (const k of keys) delete model[k];
  await db.query(
    'UPDATE config_revisions SET model = $2 WHERE revision = $1',
    [revision, JSON.stringify(model)]);
}

describe('옛 모양 스냅샷으로 롤백', () => {
  it('**컬렉션이 없는 옛 리비전으로 롤백된다** — `undefined.map` 이 아니다', async () => {
    const old = await commitAll(minimal);
    await commitAll([PUT('backend', 'web-2', { pool: 'web', host: '10.0.0.2', port: 80, weight: 1 })]);

    // v0.6 이전 모양 — 컬렉션 셋이 통째로 없다.
    await stripCollections(old, ['certificates', 'tlsPolicies', 'sniBindings']);

    // 지금은 `TypeError: Cannot read properties of undefined (reading 'map')` 이 나고
    // API 는 그것을 500 으로 답한다 — 우리 잘못이 아니라고 말하는 500 이고, 사실
    // 우리 잘못이다.
    //
    // **해독기는 없는 컬렉션을 빈 배열로 채운다.** 그게 옛 리비전의 정확한 의미이므로
    // (`modelAt` 의 주석이 그렇게 적어 뒀다) 옳은 답은 "잘 거절한다" 가 아니라
    // **"그냥 된다"** 다.
    const out = await store.rollbackTo(old, 't');
    expect(out.rollbackOf).toBe(old);

    const restored = await store.modelAt(out.revision);
    expect(restored.backends.map((b) => b.key)).toEqual(['web-1']);
    expect(restored.certificates).toEqual([]);
    expect(restored.tlsPolicies).toEqual([]);
    expect(restored.sniBindings).toEqual([]);
  });

  it('`modelAt` 과 같은 답을 한다 — 같은 스냅샷을 두 경로가 다르게 말하면 안 된다', async () => {
    const old = await commitAll(minimal);
    await commitAll([PUT('backend', 'web-2', { pool: 'web', host: '10.0.0.2', port: 80, weight: 1 })]);
    await stripCollections(old, ['certificates']);

    // 읽기 경로가 이 스냅샷을 어떻게 읽는지 먼저 본다.
    const read = await store.modelAt(old);
    expect(read.certificates).toEqual([]);

    // 롤백이 되돌린 것이 그것과 같아야 한다.
    const out = await store.rollbackTo(old, 't');
    const restored = await store.modelAt(out.revision);
    expect(restored.certificates).toEqual(read.certificates);
    expect(restored.backends.map((b) => b.key)).toEqual(read.backends.map((b) => b.key));
  });

  it('**정말 깨진 스냅샷은 거절한다** — 빈 배열로 채우는 것과 다른 일이다', async () => {
    const old = await commitAll(minimal);
    await commitAll([PUT('backend', 'web-2', { pool: 'web', host: '10.0.0.2', port: 80, weight: 1 })]);

    // 없는 것이 아니라 **모양이 틀린** 것. 해독기가 여기서 말해야 한다.
    const row = (await db.query(
      'SELECT model FROM config_revisions WHERE revision = $1', [old])).rows[0];
    const model = { ...(row?.['model'] as Record<string, unknown>), pools: 'nope' };
    await db.query(
      'UPDATE config_revisions SET model = $2 WHERE revision = $1',
      [old, JSON.stringify(model)]);

    const err = await store.rollbackTo(old, 't').then(() => undefined, (e: unknown) => e as StoreError);
    expect(err).toBeInstanceOf(StoreError);
    // `modelAt` 이 같은 상태에 쓰는 이름과 같아야 한다 — 자리가 둘이라도 답은 하나다.
    expect(err?.code).toBe('corrupt_revision');
  });

  it('멀쩡한 스냅샷은 그대로 롤백된다 — 해독이 길을 막지 않는다', async () => {
    const old = await commitAll(minimal);
    await commitAll([PUT('backend', 'web-2', { pool: 'web', host: '10.0.0.2', port: 80, weight: 1 })]);

    const out = await store.rollbackTo(old, 't');
    expect(out.rollbackOf).toBe(old);

    // 되돌린 내용이 그 시점과 같은가 — 백엔드가 하나로 돌아온다.
    const restored = await store.modelAt(out.revision);
    expect(restored.backends.map((b) => b.key)).toEqual(['web-1']);
  });
});
