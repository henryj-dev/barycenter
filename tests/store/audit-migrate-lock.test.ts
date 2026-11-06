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
import { spawn } from 'node:child_process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sqlitePathOf } from '../../src/store/sqlite.js';

import { Db, dockerAvailable, freshSchema, pgFor, startPg, stopPg, TEST_DB } from './pg-fixture.js';

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
    if (TEST_DB === 'sqlite') {
      await freshSchema(db);
    } else {
      await db.query('DROP SCHEMA public CASCADE');
      await db.query('CREATE SCHEMA public');
    }
  } finally {
    await db.close();
  }
}

describe('동시 기동', () => {
  // SQLite 에서는 같은 프로세스의 두 저장소가 파일 하나의 쓰기 줄을 함께 쓴다(`sqlite.ts` 의 `Shared`). 다른 프로세스의
  // 짝은 아래 「다른 프로세스」 시험이다.
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

  /**
   * SQLite 의 짝. 다른 프로세스가 쓰기 잠금을 쥔 동안(그 프로세스의 마이그레이션 자리) 이 프로세스의 마이그레이션은
   * 던지지 않고 기다렸다가 전부 한 번 적용한다 — 「진 쪽이 재시작 루프에 안 빠진다」 의 SQLite 모양이다.
   */
  it.runIf(TEST_DB === 'sqlite')('**다른 프로세스가 쓰기를 쥔 동안 떠도 기다렸다 성공한다** (SQLite)', async () => {
    await wipe();
    const child = spawn(process.execPath, ['--no-warnings', '-e', `
      const { DatabaseSync } = require('node:sqlite');
      const c = new DatabaseSync(${JSON.stringify(sqlitePathOf(PG.dsn))}, { timeout: 0 });
      c.exec('BEGIN IMMEDIATE');
      process.stdout.write('held\\n');
      setTimeout(() => { c.exec('COMMIT'); c.close(); process.exit(0); }, 1500);
    `], { stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = new Promise<number | null>((r) => child.on('exit', r));
    await new Promise<void>((res, rej) => {
      child.stdout?.on('data', (d: Buffer) => { if (d.toString().includes('held')) res(); });
      child.on('exit', (code) => rej(new Error(`잠금을 쥘 자식이 먼저 끝났다: ${code}`)));
    });
    const db = new Db(PG.dsn);
    try {
      const t0 = Date.now();
      const applied = await db.migrate();
      expect(Date.now() - t0, '잠금을 기다리지 않았다 — 자식이 쥐고 있었어야 한다').toBeGreaterThan(500);
      expect(applied.length).toBeGreaterThan(0);
      expect(new Set(applied).size).toBe(applied.length);
    } finally {
      await db.close();
      child.kill('SIGKILL');
      await exited;
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

  // PG 의 advisory 잠금을 `pg_locks` 로 잰다 — SQLite 에는 그 잠금이 없다. SQLite 의 짝은 바로 아래 시험이다.
  it.skipIf(TEST_DB === 'sqlite')('잠금을 놓는다 — 다음 기동이 안 매달린다', async () => {
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

  // SQLite 의 마이그레이션 잠금은 쓰기 트랜잭션(`BEGIN IMMEDIATE`)이다. 열어 둔 연결이 그 잠금을 놓았는지
  // 다른 연결의 쓰기로 잰다 — 안 놓았으면 `busy_timeout` 뒤에 `database is locked` 로 던진다.
  it.runIf(TEST_DB === 'sqlite')('잠금을 놓는다 — 다른 연결이 곧바로 쓴다 (SQLite)', async () => {
    const db = new Db(PG.dsn);
    const other = new Db(PG.dsn);
    try {
      await db.migrate();
      const t0 = Date.now();
      await other.tx(async (c) => {
        await c.query(`UPDATE bary_sequences SET last_value = last_value WHERE name = 'leader_token_seq'`);
      });
      expect(Date.now() - t0).toBeLessThan(1_000);
    } finally {
      await other.close();
      await db.close();
    }
  }, 120_000);
});
