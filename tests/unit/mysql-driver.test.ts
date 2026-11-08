/**
 * MySQL 드라이버의 순수한 부분 — 문장 옮기기 · 리터럴 · 오류 옮기기 · 문장 가르기 (src/store/mysql.ts)
 *
 * 서버 없이 돈다. 서버에 붙어 재는 것은 `tests/dialect/mysql-boundary.test.ts` 다.
 */
import { describe, expect, it } from 'vitest';

import {
  flavorOf, literal, lockNameFor, mapMysqlError, mysqlConfigOf, rewriteMysql, rowCountOf, splitStatements,
} from '../../src/store/mysql.js';

describe('rewriteMysql', () => {
  it('**`$n` 은 번호 그대로의 인자다** — 뒤집혀도 · 되풀이돼도. 문자열 · 따옴표 이름 · 주석 안은 그대로', () => {
    expect(rewriteMysql(`SELECT $2, $1, $2, '$1', "a$1" -- $3\n/* $4 */`, ['a', 'b']).sql)
      .toBe(`SELECT 'b', 'a', 'b', '$1', "a$1" -- $3\n/* $4 */`);
    expect(rewriteMysql(`SELECT JSON_EXTRACT(x, '$.a') FROM t WHERE k = $10`, Array.from({ length: 10 }, (_, i) => i + 1)).sql)
      .toBe(`SELECT JSON_EXTRACT(x, '$.a') FROM t WHERE k = 10`);
  });

  it('인자가 모자라면 던진다 — 조용히 NULL 을 넣지 않는다', () => {
    expect(() => rewriteMysql('SELECT $2', ['a'])).toThrow(/\$2/);
  });

  it('**리터럴에 이스케이프는 따옴표 두 번 하나뿐** — 역슬래시 · 따옴표 · 주석 문자가 문장을 깨지 못한다', () => {
    expect(literal("a'b")).toBe("'a''b'");
    expect(literal("x\\'; DROP TABLE t; --")).toBe("'x\\''; DROP TABLE t; --'");
    expect(rewriteMysql('SELECT $1', ["'); --"]).sql).toBe("SELECT '''); --'");
  });

  it('값의 모양 — boolean · Date · ISO UTC 문자열 · 객체 · Buffer · bigint · NULL', () => {
    expect(literal(true)).toBe('TRUE');
    expect(literal(null)).toBe('NULL');
    expect(literal(undefined)).toBe('NULL');
    expect(literal(new Date('2026-01-02T03:04:05.006Z'))).toBe("'2026-01-02 03:04:05.006'");
    expect(literal('2026-01-02T03:04:05.006Z')).toBe("'2026-01-02 03:04:05.006'");
    expect(literal('2026-01-02T03:04:05+09:00')).toBe("'2026-01-02T03:04:05+09:00'");
    expect(literal({ a: ["x'y"] })).toBe(`'{"a":["x''y"]}'`);
    expect(literal(['a', 'b'])).toBe(`'["a","b"]'`);
    expect(literal(Buffer.from('hi'))).toBe("X'6869'");
    expect(literal(9007199254740993n)).toBe('9007199254740993');
    expect(() => literal(Number.NaN)).toThrow();
  });

  it('**`now()` — 트랜잭션 안은 그 트랜잭션의 한 값, 밖은 문장의 UTC 시각**', () => {
    expect(rewriteMysql('SELECT now(), NOW ( )').sql).toBe('SELECT UTC_TIMESTAMP(6), UTC_TIMESTAMP(6)');
    const r = rewriteMysql('UPDATE t SET a = now()', [], { inTx: true });
    expect(r.sql).toBe('UPDATE t SET a = CAST(@bary_now AS DATETIME(6))');
    expect(r.usesNow).toBe(true);
    expect(rewriteMysql("SELECT 'now()', known()").sql).toBe("SELECT 'now()', known()");
  });

  it('`gen_random_uuid()` 은 v4 리터럴', () => {
    expect(rewriteMysql('INSERT INTO t (id) VALUES (gen_random_uuid())').sql)
      .toMatch(/^INSERT INTO t \(id\) VALUES \('[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'\)$/);
  });

  it('**예약어 이름 `key` · `before` 에 따옴표** — 문법 자리의 KEY 와 한정 이름 · 문자열은 가린다', () => {
    expect(rewriteMysql('SELECT key, p.key, before FROM pools p WHERE key = $1', ['a']).sql)
      .toBe(`SELECT "key", p."key", "before" FROM pools p WHERE "key" = 'a'`);
    expect(rewriteMysql('INSERT INTO t (key) VALUES ($1) ON DUPLICATE KEY UPDATE key = VALUES(key)', ['a']).sql)
      .toBe(`INSERT INTO t ("key") VALUES ('a') ON DUPLICATE KEY UPDATE "key" = VALUES("key")`);
    expect(rewriteMysql("SELECT JSON_VALUE(x, '$.key'), monkey, keys FROM t").sql)
      .toBe("SELECT JSON_VALUE(x, '$.key'), monkey, keys FROM t");
  });
});

describe('오류 → PG SQLSTATE', () => {
  const err = (errno: number, sqlMessage: string): Record<string, unknown> => ({ errno, code: 'ER_X', sqlMessage, message: sqlMessage });

  it('유일 · 기본 키 · FK · CHECK · NOT NULL', () => {
    expect(mapMysqlError(err(1062, "Duplicate entry 'a' for key 'pools.pools_key_key'"), 'mysql'))
      .toMatchObject({ code: '23505', constraint: 'pools_key_key', mysqlCode: 'ER_X' });
    expect(mapMysqlError(err(1062, "Duplicate entry 'a' for key 'pools_key_key'"), 'mariadb'))
      .toMatchObject({ code: '23505', constraint: 'pools_key_key' });
    expect(mapMysqlError(err(1062, "Duplicate entry 'x' for key 'pools.PRIMARY'"), 'mysql'))
      .toMatchObject({ code: '23505', constraint: 'pools_pkey' });
    expect(mapMysqlError(err(1452, 'Cannot add or update a child row: a foreign key constraint fails (`b`.`backends`, CONSTRAINT `backends_pool_id_fkey` FOREIGN KEY (`pool_id`) REFERENCES `pools` (`id`))'), 'mysql'))
      .toMatchObject({ code: '23503', constraint: 'backends_pool_id_fkey' });
    expect(mapMysqlError(err(3819, "Check constraint 'pools_key_syntax' is violated."), 'mysql'))
      .toMatchObject({ code: '23514', constraint: 'pools_key_syntax' });
    expect(mapMysqlError(err(4025, 'CONSTRAINT `pools_key_syntax` failed for `bary`.`pools`'), 'mariadb'))
      .toMatchObject({ code: '23514', constraint: 'pools_key_syntax' });
    expect(mapMysqlError(err(1048, "Column 'k' cannot be null"), 'mysql')).toMatchObject({ code: '23502' });
  });

  it('**MySQL 의 4025 는 CHECK 가 아니다** — MariaDB 일 때만 옮긴다', () => {
    expect(mapMysqlError(err(4025, 'something else'), 'mysql')).toMatchObject({ code: 'ER_X' });
  });

  it('교착 · 잠금 대기 · 잘못된 값', () => {
    expect(mapMysqlError(err(1213, 'Deadlock found'), 'mysql')).toMatchObject({ code: '40P01' });
    expect(mapMysqlError(err(1205, 'Lock wait timeout'), 'mysql')).toMatchObject({ code: '55P03' });
    expect(mapMysqlError(err(1265, "Data truncated for column 'state'"), 'mysql')).toMatchObject({ code: '22P02' });
  });
});

describe('연결 설정 · 그 밖', () => {
  it('DSN → 옵션. DB 이름은 꼭 있어야 하고, 오류에 DSN 을 싣지 않는다', () => {
    const pw = ['p@ss', 'w0rd'].join('/');
    const c = mysqlConfigOf(`mysql://bary:${encodeURIComponent(pw)}@db.internal:3307/bary_prod`);
    expect(c.database).toBe('bary_prod');
    expect(c.options).toMatchObject({ user: 'bary', password: pw, host: 'db.internal', port: 3307, timezone: 'Z', bigNumberStrings: true });
    expect(mysqlConfigOf('mariadb://u@h/d').options).toMatchObject({ host: 'h', port: 3306 });
    expect(mysqlConfigOf('mysql://u@h/d?socket=/run/mysqld/mysqld.sock').options).toMatchObject({ socketPath: '/run/mysqld/mysqld.sock' });
    let msg = '';
    try { mysqlConfigOf(`mysql://bary:${encodeURIComponent(pw)}@h:3306/`); } catch (e) { msg = String(e); }
    expect(msg).toMatch(/DB 이름/);
    expect(msg).not.toContain('w0rd');
  });

  it('`rowCount` — UPDATE 는 맞은 행(PG 와 같다), 나머지는 영향 받은 행', () => {
    expect(rowCountOf({ affectedRows: 0, info: 'Rows matched: 3  Changed: 0  Warnings: 0' })).toBe(3);
    expect(rowCountOf({ affectedRows: 2, info: '' })).toBe(2);
  });

  it('버전 — 종류와 하한', () => {
    expect(flavorOf('8.4.13')).toBe('mysql');
    expect(flavorOf('11.8.9-MariaDB-ubu2404')).toBe('mariadb');
    expect(() => flavorOf('8.0.28')).toThrow(/너무 낮다/);
    expect(() => flavorOf('10.5.20-MariaDB')).toThrow(/너무 낮다/);
  });

  it('**잠금 이름은 DB 에 묶인다** — 이름 잠금은 서버 전체에 하나다. 64 자를 넘지 않는다', () => {
    expect(lockNameFor('a', 'leader')).not.toBe(lockNameFor('b', 'leader'));
    expect(lockNameFor('x'.repeat(64), 'leader').length).toBeLessThanOrEqual(64);
  });

  it('마이그레이션 파일 가르기 — `;` · 주석 · 문자열 · 트리거 몸(`BEGIN … END`, 안의 CASE)', () => {
    const sql = `-- 머리 ; 주석\nCREATE TABLE a (x int); INSERT INTO a VALUES (';');\n`
      + `CREATE TRIGGER IF NOT EXISTS t AFTER DELETE ON a FOR EACH ROW\nBEGIN\n  DELETE FROM b WHERE y = CASE WHEN OLD.x = 1 THEN 1 END;\n  DELETE FROM c;\nEND;\n-- 꼬리`;
    const s = splitStatements(sql);
    expect(s).toHaveLength(3);
    expect(s[1]).toBe("INSERT INTO a VALUES (';')");
    expect(s[2]).toMatch(/^CREATE TRIGGER[\s\S]*DELETE FROM c;\nEND$/);
    expect(splitStatements('-- 주석뿐\n')).toEqual([]);
  });
});
