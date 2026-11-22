/**
 * **빌린 연결이 끊겨도 데몬이 안 죽는다** (2026-11-22, web-01) — PG 만.
 *
 * 풀은 쉬는 연결의 `error` 만 받는다. 트랜잭션으로 빌린 동안 쿼리 사이에 연결이 끊기면 `Client` 의 `error` 를
 * 아무도 안 들어 Node 가 던졌다. 여기서는 트랜잭션 안에서 그 연결을 서버 쪽에서 끊는다. 처리되지 않은 오류가
 * 나면 vitest 가 실패로 센다. 그 트랜잭션은 실패로 끝나고, 다음 쿼리는 새 연결로 된다.
 * 리더 세션의 keepalive 설정이 PG 에서 받아들여지는 것은 `leader.test.ts` 가 리더를 잡을 때마다 잰다.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Db, dockerAvailable, pgFor, startPg, stopPg, TEST_DB } from './pg-fixture.js';

const PG = pgFor('disconnect');
const ON = TEST_DB === 'postgres';
let db: Db;

beforeAll(async () => {
  if (!ON) return;
  if (!dockerAvailable()) throw new Error('도커가 없다 — 이 스위트는 실물 PG 를 쓴다');
  startPg(PG);
  db = new Db(PG.dsn);
  await db.migrate();
}, 180_000);

afterAll(async () => {
  if (!ON) return;
  await db?.close();
  stopPg(PG);
});

describe.runIf(ON)('PG — 빌린 연결이 끊길 때', () => {
  it('트랜잭션 안에서 끊기면 그 트랜잭션만 실패하고, 데몬은 산다', async () => {
    const run = db.tx(async (c) => {
      const pid = String((await c.query('SELECT pg_backend_pid() AS pid')).rows[0]?.['pid']);
      // 다른 연결로 이 연결을 끊는다 — 쿼리 사이의 끊김이다(진행 중인 쿼리가 없다).
      await db.query('SELECT pg_terminate_backend($1::int)', [pid]);
      await new Promise((r) => setTimeout(r, 200));
      await c.query('SELECT 1');
    });
    await expect(run).rejects.toThrow();
    // 끊긴 연결은 풀에 안 돌아갔다 — 다음 쿼리가 새 연결로 된다.
    expect((await db.query('SELECT 1 AS one')).rows[0]?.['one']).toBe(1);
  });
});
