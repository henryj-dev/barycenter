/**
 * 기동 마이그레이션에 잠금 — 검수 2026-08-24 D15
 *
 * ── 이 배포는 인스턴스가 여럿인 것을 정상으로 친다
 *
 * `deploy/docker-compose.yml` 이 적어 뒀다: *"같은 PG 를 보는 인스턴스를 여러 대 띄우면
 * 하나만 리더가 되고 나머지는 읽기만 답한다."* §11.4 의 콜드 스탠바이다.
 *
 * 그런데 `db.migrate()` 는 **리더 선출 전에, 잠금 없이** 돈다. 업그레이드 때 둘이 동시에
 * 뜨면 같은 마이그레이션을 둘 다 시도한다 — `schema_migrations` 를 읽는 시점에는 둘 다
 * 「아직 안 했다」로 보이기 때문이다. 진 쪽은 `relation already exists` 로 죽고
 * `process.exit(1)` → 재시작 루프다.
 *
 * ── 왜 트랜잭션만으로는 안 되나
 *
 * 마이그레이션 하나가 한 트랜잭션인 것은 **부분 적용**을 막는다. 동시 실행은 못 막는다 —
 * 둘 다 커밋을 시도하고 DDL 이 충돌한다. 막는 것은 잠금뿐이다.
 *
 * 리더 선출이 이미 advisory lock 을 쓴다(§3.5). **키만 다르게** 잡는다 — 같은 키를 쓰면
 * 마이그레이션이 리더 선출을 기다리게 되고, 그건 선출 전에 도는 것의 뜻을 뒤집는다.
 *
 *   npm run test:store     (도커 필요)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Db, dockerAvailable, pgFor, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('migrate-lock');

beforeAll(() => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 이 스위트는 실물 PG 를 쓴다');
  startPg(PG);
}, 180_000);

afterAll(() => {
  stopPg(PG);
});

/** 아무것도 없는 스키마로 되돌린다 — 마이그레이션을 처음부터 돌리기 위해. */
async function wipe(): Promise<void> {
  const db = new Db(PG.dsn);
  try {
    await db.query('DROP SCHEMA public CASCADE');
    await db.query('CREATE SCHEMA public');
  } finally {
    await db.close();
  }
}

describe('동시 기동', () => {
  it('**둘이 동시에 떠도 둘 다 성공한다** — 진 쪽이 재시작 루프에 안 빠진다', async () => {
    await wipe();

    // 서로의 큐를 모르는 **다른 연결 풀** 둘. 한 프로세스 안의 직렬화로는 이 경합을
    // 못 만든다 — 실제 배포에서 갈리는 것도 프로세스다.
    const a = new Db(PG.dsn);
    const b = new Db(PG.dsn);
    try {
      const [ra, rb] = await Promise.all([a.migrate(), b.migrate()]);

      // 한쪽이 전부 적용하고 다른 쪽은 하나도 안 하거나, 나눠 가지거나 — 어느 쪽이든
      // **둘 다 던지지 않아야** 한다. 그것이 이 테스트의 전부다.
      expect(Array.isArray(ra)).toBe(true);
      expect(Array.isArray(rb)).toBe(true);

      // 그리고 각 마이그레이션은 **정확히 한 번** 적용됐다.
      const applied = [...ra, ...rb];
      expect(new Set(applied).size).toBe(applied.length);
    } finally {
      await a.close();
      await b.close();
    }
  }, 180_000);

  it('두 번째 기동은 아무것도 안 한다 — 멱등이 안 깨졌다', async () => {
    const db = new Db(PG.dsn);
    try {
      expect(await db.migrate()).toEqual([]);
    } finally {
      await db.close();
    }
  }, 120_000);

  it('잠금을 놓는다 — 다음 기동이 안 매달린다', async () => {
    // 앞 테스트가 잠금을 안 놓았으면 여기서 영영 안 끝난다. 마감이 그것을 잡는다.
    const db = new Db(PG.dsn);
    try {
      await db.migrate();
      const held = (await db.query(
        `SELECT count(*)::int AS n FROM pg_locks
          WHERE locktype = 'advisory' AND granted`)).rows[0];
      expect(Number(held?.['n'] ?? 0)).toBe(0);
    } finally {
      await db.close();
    }
  }, 120_000);
});
