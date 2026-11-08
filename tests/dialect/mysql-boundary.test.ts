/**
 * MySQL · MariaDB 경계의 고유한 계약 — 이름 잠금 리더 · 펜싱 · 비트랜잭션 DDL · 값과 오류의 모양 (docs/adr-multi-db.md 「3단계」)
 *
 *   BARY_TEST_DB=mysql   npx vitest run tests/dialect/mysql-boundary.test.ts
 *   BARY_TEST_DB=mariadb npx vitest run tests/dialect/mysql-boundary.test.ts
 *
 * 다른 방언에서는 건너뛴다 — 여기 재는 것(`GET_LOCK` · `KILL` · 암묵 커밋 DDL)은 MySQL 계열의 손발이다. 공통 계약은
 * `dialect-conformance` 가 잰다. **클러스터 모드의 전제**(여러 프로세스가 같은 서버 하나로 선출한다)를 여기서 잰다 —
 * 다른 프로세스가 쥔 잠금 · 그 프로세스의 SIGKILL · 세션 끊김 · 동시 시도.
 */
import { spawn, type ChildProcess } from 'node:child_process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ACCOUNT_MIGRATIONS } from '../../src/accounts/migrations.js';
import { LeaderElection } from '../../src/control/leader.js';
import type { Database } from '../../src/store/db.js';
import { MysqlLeaderLock } from '../../src/store/mysql-leader.js';
import { mysqlConfigOf } from '../../src/store/mysql.js';
import { openDbForTest, openLeaderLockForTest } from '../../src/store/open.js';
import { compareShapes, readSchemaShape } from '../../src/store/schema-shape.js';
import { startTestDb, testDbName, type TestDb } from './db-under-test.js';

const ON = ((): boolean => { const n = testDbName(); return n === 'mysql' || n === 'mariadb'; })();

let t: TestDb;
let db: Database;

beforeAll(async () => {
  if (!ON) return;
  t = startTestDb('mysql-boundary');
  db = openDbForTest(t.dsn);
  await db.migrate();
  await db.migrate(ACCOUNT_MIGRATIONS);
  await db.query(`CREATE TABLE probe (k varchar(64) NOT NULL PRIMARY KEY, n bigint NOT NULL, b boolean, j json, at datetime(6),
                  CONSTRAINT probe_n_check CHECK (n >= 0)) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`);
}, 240_000);

afterAll(async () => {
  await db?.close();
  t?.stop();
});

const until = async (cond: () => boolean | Promise<boolean>, ms: number): Promise<void> => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('기다린 조건이 오지 않았다');
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe.skipIf(!ON)(`MySQL 경계 (${process.env['BARY_TEST_DB'] ?? ''})`, () => {
  it('값이 PG 와 같은 JS 모양으로 온다 — bigint 문자열 · boolean · JSON · Date', async () => {
    await db.query('INSERT INTO probe (k, n, b, j, at) VALUES ($1, $2, $3, $4, $5)',
      ['v', '9007199254740993', true, { a: [1, 2] }, new Date('2026-01-02T03:04:05.006Z')]);
    const r = (await db.query('SELECT n, b, j, at FROM probe WHERE k = $1', ['v'])).rows[0];
    expect(r).toEqual({ n: '9007199254740993', b: true, j: { a: [1, 2] }, at: new Date('2026-01-02T03:04:05.006Z') });
  });

  it('**`now()` 는 트랜잭션 안에서 한 값이다** — 밖에서는 문장마다 움직인다', async () => {
    const [a, b] = await db.tx(async (c) => {
      const x = (await c.query('SELECT now() AS t')).rows[0]?.['t'] as Date;
      await new Promise((res) => setTimeout(res, 30));
      const y = (await c.query('SELECT now() AS t')).rows[0]?.['t'] as Date;
      return [x, y];
    });
    expect(a).toBeInstanceOf(Date);
    expect(b?.getTime()).toBe(a?.getTime());
    const o1 = (await db.query('SELECT now() AS t')).rows[0]?.['t'] as Date;
    await new Promise((res) => setTimeout(res, 30));
    const o2 = (await db.query('SELECT now() AS t')).rows[0]?.['t'] as Date;
    expect(o2.getTime()).toBeGreaterThan(o1.getTime());
    // 서버 시계 — UTC 다(세션 time_zone '+00:00').
    expect(Math.abs(o2.getTime() - Date.now())).toBeLessThan(60_000);
  });

  it('**UPDATE 의 rowCount 는 맞은 행**(값이 같아 안 바뀐 행도 센다 — PG 와 같다)', async () => {
    const r = await db.query('UPDATE probe SET n = n WHERE k = $1', ['v']);
    expect(r.rowCount).toBe(1);
  });

  it('제약 오류는 PG SQLSTATE 와 PG 의 제약 이름으로 온다', async () => {
    await expect(db.query("INSERT INTO probe (k, n) VALUES ('v', 1)")).rejects.toMatchObject({ code: '23505', constraint: 'probe_pkey' });
    await expect(db.query("INSERT INTO probe (k, n) VALUES ('w', -1)")).rejects.toMatchObject({ code: '23514', constraint: 'probe_n_check' });
    await expect(db.query("INSERT INTO probe (k, n) VALUES ('w', NULL)")).rejects.toMatchObject({ code: '23502' });
    await expect(db.query(`INSERT INTO pools (id, key, name, protocol_class, algorithm, created_by, updated_by, revision)
                           VALUES (gen_random_uuid(), 'Bad Key', 'n', 'http', 'round_robin', 't', 't', 1)`))
      .rejects.toMatchObject({ code: '23514', constraint: 'pools_key_syntax' });
    // 정규식 CHECK 의 `$` 는 끝의 줄바꿈 앞에서도 맞는다 — PG 처럼 거절해야 한다. 맞는 키는 받는다.
    const pool = (k: string): Promise<unknown> => db.query(`INSERT INTO pools (id, key, name, protocol_class, algorithm, created_by, updated_by, revision)
                           VALUES (gen_random_uuid(), $1, 'n', 'http', 'round_robin', 't', 't', 1)`, [k]);
    await expect(pool('ok\n')).rejects.toMatchObject({ code: '23514', constraint: 'pools_key_syntax' });
    await pool('ok.key-1_A');
    await db.query("DELETE FROM pools WHERE key = 'ok.key-1_A'");
    await expect(db.query(`INSERT INTO backends (id, key, pool_id, host, port, weight, created_by, updated_by, revision)
                           VALUES (gen_random_uuid(), 'b1', '00000000-0000-4000-8000-000000000000', 'h', 80, 1, 't', 't', 1)`))
      .rejects.toMatchObject({ code: '23503', constraint: 'backends_pool_id_fkey' });
  });

  it('**비교는 바이트다** — 대소문자를 가른다(PG text 처럼)', async () => {
    await db.query("INSERT INTO probe (k, n) VALUES ('Case', 1)");
    expect((await db.query("SELECT k FROM probe WHERE k = 'case'")).rows).toEqual([]);
    // 리터럴끼리도 — 연결의 collation 이 utf8mb4_bin 이다.
    expect((await db.query("SELECT CASE WHEN 'a' = 'A' THEN 'same' ELSE 'diff' END AS r")).rows[0]?.['r']).toBe('diff');
  });

  describe('마이그레이션 — DDL 이 트랜잭션이 아니다', () => {
    it('**001 을 다시 돌려도 같은 끝 상태다** — 반쯤 적용된 채 죽고 다시 뜨는 경우(기록이 없어 처음부터 다시 돈다)', async () => {
      const before = await readSchemaShape(db);
      const seeds = (await db.query("SELECT name, CAST(`last_value` AS CHAR) AS v FROM bary_sequences ORDER BY name")).rows;
      await db.query(`DELETE FROM schema_migrations WHERE name = '001_init.sql'`);
      await db.query(`DELETE FROM account_schema_migrations WHERE name = '001_accounts.sql'`);
      expect(await db.migrate()).toEqual(['001_init.sql']);
      expect(await db.migrate(ACCOUNT_MIGRATIONS)).toEqual(['001_accounts.sql']);
      expect(compareShapes(before, await readSchemaShape(db))).toEqual([]);
      expect((await db.query("SELECT name, CAST(`last_value` AS CHAR) AS v FROM bary_sequences ORDER BY name")).rows).toEqual(seeds);
      expect((await db.query('SELECT count(*) AS n FROM config_revisions')).rows[0]?.['n']).toBe('1');
    });

    it('**동시에 둘이 돌아도 하나만 적용한다** — `GET_LOCK` 을 기다린다', async () => {
      await db.query(`DELETE FROM schema_migrations WHERE name = '033_data_sources.sql'`);
      const a = openDbForTest(t.dsn);
      const b = openDbForTest(t.dsn);
      try {
        const [ra, rb] = await Promise.all([a.migrate(), b.migrate()]);
        expect([...ra, ...rb]).toEqual(['033_data_sources.sql']);
      } finally {
        await a.close();
        await b.close();
      }
    });

  });

  describe('리더 — `GET_LOCK` 세션 잠금 (클러스터 모드의 전제)', () => {
    const elect = (h: string): LeaderElection => new LeaderElection(openLeaderLockForTest(t.dsn), h);

    it('**동시에 여럿이 시도해도 하나만 쥔다**', async () => {
      const es = Array.from({ length: 6 }, (_, i) => elect(`n${i}`));
      try {
        const got = await Promise.all(es.map(async (e) => e.tryAcquire()));
        expect(got.filter(Boolean)).toHaveLength(1);
      } finally {
        for (const e of es) await e.release();
      }
    });

    it('**토큰은 엄격히 커진다** — 놓고 다시 쥘 때마다', async () => {
      const a = elect('a');
      const b = elect('b');
      let last = 0n;
      try {
        for (let i = 0; i < 4; i++) {
          const e = i % 2 === 0 ? a : b;
          expect(await e.tryAcquire()).toBe(true);
          const tok = BigInt(e.assertLeader());
          expect(tok > last).toBe(true);
          last = tok;
          await e.release();
        }
      } finally {
        await a.release();
        await b.release();
      }
    });

    it('**세션이 끊기면(KILL) 그 순간 리더가 아니다** — 주기 확인이 알아내고, 다른 쪽이 더 큰 토큰으로 쥔다', async () => {
      const a = elect('a');
      const b = elect('b');
      try {
        expect(await a.tryAcquire()).toBe(true);
        const first = BigInt(a.assertLeader());
        const lock = new MysqlLeaderLock(t.dsn);
        const owner = (await db.query('SELECT IS_USED_LOCK($1) AS id', [lock.lockName])).rows[0]?.['id'];
        expect(owner).not.toBeNull();
        await db.query(`KILL ${String(owner)}`);
        await until(() => !a.state.isLeader, 10_000);
        expect(() => a.assertLeader()).toThrow();
        expect(await b.tryAcquire()).toBe(true);
        expect(BigInt(b.assertLeader()) > first).toBe(true);
      } finally {
        await a.release();
        await b.release();
      }
    });

    it('**다른 프로세스가 쥐면 못 쥔다 — 그 프로세스가 SIGKILL 로 죽으면 쥔다**', async () => {
      const lock = new MysqlLeaderLock(t.dsn);
      const o = mysqlConfigOf(t.dsn).options as { host: string; port: number; user: string; password: string; database: string };
      // 다른 프로세스 — 같은 이름을 GET_LOCK 으로 쥐고 기다린다. 이 저장소의 코드를 싣지 않는다(드라이버 하나만).
      const script = `
        const m = require('mysql2/promise');
        (async () => {
          const c = await m.createConnection({ host: ${JSON.stringify(o.host)}, port: ${o.port}, user: ${JSON.stringify(o.user)},
            password: process.env.BARY_PW, database: ${JSON.stringify(o.database)} });
          const [r] = await c.query('SELECT GET_LOCK(?, 0) AS g', [${JSON.stringify(lock.lockName)}]);
          process.stdout.write(String(r[0].g) + '\\n');
          setInterval(() => {}, 1000);
        })().catch((e) => { process.stderr.write(String(e)); process.exit(2); });`;
      const child: ChildProcess = spawn(process.execPath, ['-e', script], {
        stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BARY_PW: o.password }, cwd: process.cwd(),
      });
      try {
        const line = await new Promise<string>((res, rej) => {
          child.stdout?.once('data', (d: Buffer) => res(d.toString().trim()));
          child.once('exit', (code) => rej(new Error(`자식이 먼저 끝났다: ${code}`)));
        });
        expect(line).toBe('1');
        const a = elect('a');
        expect(await a.tryAcquire()).toBe(false);
        expect(a.state.reason).toMatch(/다른 인스턴스가 리더다/);
        child.kill('SIGKILL');
        await until(async () => a.tryAcquire(), 15_000);
        expect(a.state.isLeader).toBe(true);
        await a.release();
      } finally {
        child.kill('SIGKILL');
      }
    });

    it('**DB 마다 잠금이 따로다** — 같은 서버의 다른 DB 는 서로의 리더를 막지 않는다', async () => {
      const other = startTestDb('mysql-boundary-other');
      const odb = openDbForTest(other.dsn);
      try {
        await odb.migrate();
        const a = elect('a');
        const x = new LeaderElection(openLeaderLockForTest(other.dsn), 'x');
        try {
          expect(await a.tryAcquire()).toBe(true);
          expect(await x.tryAcquire()).toBe(true);
        } finally {
          await a.release();
          await x.release();
        }
      } finally {
        await odb.close();
        other.stop();
      }
    });

    it('물러나면 `released_at` 을 적는다 — 깨끗이 물러난 것과 죽은 것을 가른다', async () => {
      const a = elect('a');
      expect(await a.tryAcquire()).toBe(true);
      const tok = a.assertLeader();
      await a.release();
      const r = (await db.query('SELECT released_at FROM leadership WHERE token = $1', [tok])).rows[0];
      expect(r?.['released_at']).toBeInstanceOf(Date);
    });
  });
});
