/**
 * 검수 2026-08-22 · B-13 — **누적 patch 는 유계다**
 *
 * `patchChangeset` 은 `patch = patch || $2::jsonb` 로 무한히 누적했다. 한 요청은
 * `maxBodyBytes`(기본 4 MiB)로 제한되지만 **같은 changeset 에 반복 PATCH 하는 총량**에는
 * 상한이 없었다.
 *
 * 그리고 `plan()` 과 `commit()` 이 그 전부를 순차로 적용한다 — 누적된 changeset 하나가
 * 커밋 트랜잭션을 오래 잡고, `config_head` 를 `FOR UPDATE` 로 잠근 채로 그렇게 한다.
 * 즉 **다른 모든 커밋이 그 뒤에 줄을 선다.**
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ConfigStore, MAX_CHANGESET_OPS, StoreError, type PatchOp,
} from '../../src/store/config-store.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('audit-patchcap');

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

const poolOps = (n: number, from = 0): PatchOp[] =>
  Array.from({ length: n }, (_, i) => ({
    op: 'put' as const, kind: 'pool' as const, key: `p${from + i}`,
    body: { protocolClass: 'http', algorithm: 'round_robin' },
  }));

async function open(): Promise<string> {
  const head = await store.head();
  return store.createChangeset(head.revision, 'tester');
}

describe('changeset 누적 상한 (검수 B-13)', () => {
  it('누적 patch 는 유계다', async () => {
    const cs = await open();

    // 상한 직전까지는 받는다.
    await store.patchChangeset(cs, poolOps(MAX_CHANGESET_OPS), 'tester');

    // 한 걸음 더 가면 거절이다. **상태와 충돌하지만 해소 가능** — 409 다 (§5.1).
    await expect(store.patchChangeset(cs, poolOps(1, MAX_CHANGESET_OPS), 'tester'))
      .rejects.toThrow(StoreError);
    await expect(store.patchChangeset(cs, poolOps(1, MAX_CHANGESET_OPS), 'tester'))
      .rejects.toMatchObject({ status: 409, code: 'changeset_too_large' });
  });

  it('한 번에 상한을 넘겨도 거절한다', async () => {
    const cs = await open();
    await expect(store.patchChangeset(cs, poolOps(MAX_CHANGESET_OPS + 1), 'tester'))
      .rejects.toMatchObject({ status: 409, code: 'changeset_too_large' });
  });

  it('거절해도 앞서 쌓은 것은 그대로다', async () => {
    // 부분 적용으로 어중간하게 잘리면 안 된다 — 받거나 안 받거나 둘 중 하나다.
    const cs = await open();
    await store.patchChangeset(cs, poolOps(3), 'tester');
    await expect(store.patchChangeset(cs, poolOps(MAX_CHANGESET_OPS), 'tester'))
      .rejects.toMatchObject({ code: 'changeset_too_large' });

    const row = (await db.query('SELECT patch FROM changesets WHERE id=$1', [cs])).rows[0];
    expect((row?.['patch'] as unknown[]).length).toBe(3);
  });

  it('상한 안의 평범한 편집은 그대로 지난다', async () => {
    const cs = await open();
    await store.patchChangeset(cs, poolOps(2), 'tester');
    await store.patchChangeset(cs, poolOps(2, 2), 'tester');
    const row = (await db.query('SELECT patch FROM changesets WHERE id=$1', [cs])).rows[0];
    expect((row?.['patch'] as unknown[]).length).toBe(4);
  });
});
