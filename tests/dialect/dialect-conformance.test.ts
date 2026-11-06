/**
 * 방언 적합성 — 경계(`Database` · `LeaderLock`)가 방언마다 같은 계약을 지키는가 (docs/adr-multi-db.md)
 *
 *   BARY_TEST_DB=postgres npm run test:dialect    (기본)
 *   BARY_TEST_DB=sqlite   npm run test:dialect    (2단계가 켠다)
 *   BARY_TEST_DB=mysql    npm run test:dialect    (3단계가 켠다)
 *
 * 여기 SQL 은 방언마다 나란히 둔다(`byDialect`) — 저장소 함수가 하는 방식과 같다. 이 묶음은 **골격**이다:
 * 방언 하나의 완료 조건은 이것에 더해 `tests/store` 묶음 전체가 그 DB 로 통과하는 것이다.
 */
import { readdirSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ACCOUNT_MIGRATIONS } from '../../src/accounts/migrations.js';
import { LeaderElection } from '../../src/control/leader.js';
import type { Database, DialectName } from '../../src/store/db.js';
import { CONFIG_MIGRATIONS } from '../../src/store/migration-sets.js';
import { openDb, openLeaderLock } from '../../src/store/open.js';
import { readSchemaShape } from '../../src/store/schema-shape.js';
import { startTestDb, type TestDb } from './db-under-test.js';

let t: TestDb;
let db: Database;

const byDialect = <T>(m: Record<DialectName, T>): T => m[db.dialect.name];

const files = (dir: string): string[] => readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

beforeAll(async () => {
  t = startTestDb('conformance');
  db = openDb(t.dsn, 'BARY_TEST_DB');
}, 180_000);

afterAll(async () => {
  await db?.close();
  t?.stop();
});

describe(`방언 적합성 (${process.env['BARY_TEST_DB'] ?? 'postgres'})`, () => {
  it('DSN 의 스킴이 시험하는 방언을 연다', () => {
    expect(db.dialect.name).toBe(t.name);
  });

  it('**두 계열을 같은 DB 에 적용해도 섞이지 않는다** — 다시 돌리면 아무것도 안 한다', async () => {
    expect(await db.migrate(CONFIG_MIGRATIONS)).toEqual(files(CONFIG_MIGRATIONS.dir));
    expect(await db.migrate(ACCOUNT_MIGRATIONS)).toEqual(files(ACCOUNT_MIGRATIONS.dir));
    expect(await db.migrate(CONFIG_MIGRATIONS)).toEqual([]);
    expect(await db.migrate()).toEqual([]);
    expect(await db.migrate(ACCOUNT_MIGRATIONS)).toEqual([]);
  });

  it('스키마 모양을 읽는다 — 모든 열이 논리 형으로 줄어든다(방언 사이 비교의 전제)', async () => {
    const shape = await readSchemaShape(db);
    expect(Object.keys(shape)).toEqual(expect.arrayContaining(['config_head', 'config_revisions', 'leadership', 'users']));
    const raw = Object.entries(shape).flatMap(([table, cols]) =>
      Object.entries(cols).filter(([, c]) => c.type.startsWith('raw:')).map(([col, c]) => `${table}.${col} ${c.type}`));
    expect(raw).toEqual([]);
  });

  describe('트랜잭션', () => {
    beforeAll(async () => {
      await db.query(byDialect({
        postgres: 'CREATE TABLE dialect_probe (k text PRIMARY KEY, n bigint NOT NULL)',
        mysql: 'CREATE TABLE dialect_probe (k varchar(64) PRIMARY KEY, n bigint NOT NULL)',
        sqlite: 'CREATE TABLE dialect_probe (k text PRIMARY KEY, n integer NOT NULL)',
      }));
    });

    const put = byDialectLater({
      postgres: 'INSERT INTO dialect_probe (k, n) VALUES ($1, $2)',
      mysql: 'INSERT INTO dialect_probe (k, n) VALUES (?, ?)',
      sqlite: 'INSERT INTO dialect_probe (k, n) VALUES (?, ?)',
    });
    const get = byDialectLater({
      postgres: 'SELECT n FROM dialect_probe WHERE k = $1',
      mysql: 'SELECT n FROM dialect_probe WHERE k = ?',
      sqlite: 'SELECT n FROM dialect_probe WHERE k = ?',
    });
    const read = async (k: string): Promise<unknown> => (await db.query(get(), [k])).rows[0]?.['n'];

    it('커밋하면 남고, 던지면 롤백한다', async () => {
      await db.tx(async (c) => { await c.query(put(), ['kept', '1']); });
      await expect(db.tx(async (c) => {
        await c.query(put(), ['gone', '1']);
        throw new Error('되돌린다');
      })).rejects.toThrow('되돌린다');
      expect(await read('kept')).toBe('1');
      expect(await read('gone')).toBeUndefined();
    });

    it('**dryRun 은 성공해도 롤백한다** — plan 의 시뮬레이션', async () => {
      const out = await db.dryRun(async (c) => {
        await c.query(put(), ['sim', '1']);
        return (await c.query(get(), ['sim'])).rows.length;
      });
      expect(out).toBe(1);
      expect(await read('sim')).toBeUndefined();
    });

    it('**bigint 는 문자열로 온다** — 2^53 위에서 뭉개지지 않는다', async () => {
      await db.query(put(), ['big', '9007199254740993']);
      expect(await read('big')).toBe('9007199254740993');
    });
  });

  describe('리더 잠금', () => {
    it('**하나만 쥔다** · 놓으면 다른 쪽이 쥐고 토큰은 엄격히 커진다', async () => {
      const a = new LeaderElection(openLeaderLock(t.dsn), 'a');
      const b = new LeaderElection(openLeaderLock(t.dsn), 'b');
      try {
        expect(await a.tryAcquire()).toBe(true);
        expect(await b.tryAcquire()).toBe(false);
        expect(b.state.token).toBeUndefined();
        const first = BigInt(a.assertLeader());
        await a.release();
        expect(a.state.reason).toBe('스스로 물러났다');
        expect(await b.tryAcquire()).toBe(true);
        expect(BigInt(b.assertLeader()) > first).toBe(true);
      } finally {
        await a.release();
        await b.release();
      }
    });
  });
});

/** 시험 정의 시점에는 아직 DB 가 없다 — 문장은 부를 때 고른다. */
function byDialectLater(m: Record<DialectName, string>): () => string {
  return () => byDialect(m);
}
