/**
 * SQLite 경계의 고유한 계약 — 쓰기 직렬화 · 읽기 격리 · 리더 잠금 파일 (docs/adr-multi-db.md 「SQLite」)
 *
 * `BARY_TEST_DB` 와 무관하게 **늘 돈다.** SQLite 는 파일이라 도커가 필요 없고, 여기 재는 것(잠금 파일 ·
 * 다른 프로세스 · `BEGIN IMMEDIATE`)은 PG 에 없는 SQLite 의 손발이다. 공통 계약은 `dialect-conformance` 가 잰다.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LeaderElection } from '../../src/control/leader.js';
import type { Database } from '../../src/store/db.js';
import { openDbForTest, openLeaderLockForTest } from '../../src/store/open.js';
import { leaderLockPathOf, LEADER_WATCH_MS } from '../../src/store/sqlite-leader.js';
import { rewritePlaceholders, sqlitePathOf } from '../../src/store/sqlite.js';

let dir: string;
let dsn: string;
let db: Database;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bary-sqlite-boundary-'));
  dsn = `sqlite:${join(dir, 'bary.db')}`;
  db = openDbForTest(dsn);
  await db.migrate();
  await db.query('CREATE TABLE probe (k text NOT NULL PRIMARY KEY, n bigint NOT NULL, b boolean, j json_text, at timestamptz)');
});

afterAll(async () => {
  await db?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('SQLite 드라이버', () => {
  it('**`$n` 은 번호 그대로 `?n`** — 순서가 뒤집혀도 · 되풀이돼도 같은 인자다. 문자열 · 주석 안은 그대로', () => {
    expect(rewritePlaceholders(`SELECT $2, $1, $2, '$1', "a$1" -- $3\n/* $4 */`))
      .toBe(`SELECT ?2, ?1, ?2, '$1', "a$1" -- $3\n/* $4 */`);
    expect(rewritePlaceholders(`SELECT json_extract(x, '$.a') FROM t WHERE k = $10`))
      .toBe(`SELECT json_extract(x, '$.a') FROM t WHERE k = ?10`);
  });

  it('DSN 은 절대 경로만 — 상대 경로 · :memory: 는 거부(연결 둘이 다른 DB 를 본다)', () => {
    expect(sqlitePathOf('sqlite:/var/lib/b.db')).toBe('/var/lib/b.db');
    expect(sqlitePathOf('sqlite:///var/lib/b.db')).toBe('/var/lib/b.db');
    expect(() => sqlitePathOf('sqlite:bary.db')).toThrow(/절대 경로/);
    expect(() => sqlitePathOf('sqlite::memory:')).toThrow(/절대 경로/);
  });

  it('값이 PG 와 같은 JS 모양으로 온다 — bigint 문자열 · boolean · JSON · Date', async () => {
    await db.query('INSERT INTO probe (k, n, b, j, at) VALUES ($1, $2, $3, $4, $5)',
      ['v', '9007199254740993', true, { a: [1, 2] }, new Date('2026-01-02T03:04:05.006Z')]);
    const r = (await db.query('SELECT n, b, j, at FROM probe WHERE k = $1', ['v'])).rows[0];
    expect(r).toEqual({ n: '9007199254740993', b: true, j: { a: [1, 2] }, at: new Date('2026-01-02T03:04:05.006Z') });
  });

  it('**`now()` 는 트랜잭션 안에서 한 값**이고 형식은 `toISOString()` 하나다(문자열 비교 = 시각 비교)', async () => {
    const [a, b] = await db.tx(async (c) => {
      const x = (await c.query('SELECT now() AS t')).rows[0]?.['t'];
      await new Promise((r) => setTimeout(r, 15));
      const y = (await c.query('SELECT now() AS t')).rows[0]?.['t'];
      return [x, y];
    });
    expect(a).toBe(b);
    expect(String(a)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  it('**쓰기 트랜잭션은 한 줄로 선다** — 읽고 · 쉬고 · 쓰는 둘이 겹쳐도 갱신을 잃지 않는다(`FOR UPDATE` 의 뜻)', async () => {
    await db.query(`INSERT INTO probe (k, n) VALUES ('ctr', 0)`);
    const bump = (): Promise<void> => db.tx(async (c) => {
      const n = Number((await c.query(`SELECT n FROM probe WHERE k = 'ctr'`)).rows[0]?.['n']);
      await new Promise((r) => setTimeout(r, 5));
      await c.query(`UPDATE probe SET n = $1 WHERE k = 'ctr'`, [n + 1]);
    });
    await Promise.all(Array.from({ length: 20 }, bump));
    expect((await db.query(`SELECT n FROM probe WHERE k = 'ctr'`)).rows[0]?.['n']).toBe('20');
  });

  it('트랜잭션 밖의 읽기는 열린 쓰기 트랜잭션을 기다리지 않고 **커밋된 것만** 본다', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const w = db.tx(async (c) => {
      await c.query(`INSERT INTO probe (k, n) VALUES ('uncommitted', 1)`);
      await gate;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect((await db.query(`SELECT k FROM probe WHERE k = 'uncommitted'`)).rows).toEqual([]);
    release();
    await w;
    expect((await db.query(`SELECT k FROM probe WHERE k = 'uncommitted'`)).rows).toHaveLength(1);
  });

  it('**트랜잭션 안에서 바깥 쓰기 · 중첩 트랜잭션은 던진다** — 영영 기다리지 않는다', async () => {
    await expect(db.tx(async () => { await db.query(`DELETE FROM probe WHERE k = 'none'`); }))
      .rejects.toThrow(/트랜잭션 밖의 쓰기/);
    await expect(db.tx(async () => db.tx(async () => undefined))).rejects.toThrow(/트랜잭션을 또 열었다/);
  });
});

describe('SQLite 리더 잠금 — 잠금 파일', () => {
  /** 다른 프로세스가 잠금 파일을 쥔다 — 데몬과 같은 손발(`BEGIN EXCLUSIVE`)이다. */
  const holder = async (): Promise<ChildProcess> => {
    const lock = leaderLockPathOf(sqlitePathOf(dsn));
    const child = spawn(process.execPath, ['--no-warnings', '-e', `
      const { DatabaseSync } = require('node:sqlite');
      const c = new DatabaseSync(${JSON.stringify(lock)}, { timeout: 0 });
      c.exec('PRAGMA journal_mode = DELETE');
      c.exec('BEGIN EXCLUSIVE');
      process.stdout.write('held\\n');
      setInterval(() => {}, 1000);
    `], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((res, rej) => {
      child.stdout?.on('data', (d: Buffer) => { if (d.toString().includes('held')) res(); });
      child.on('exit', (code) => rej(new Error(`잠금을 쥘 자식이 먼저 끝났다: ${code}`)));
    });
    return child;
  };

  it('**다른 프로세스가 쥐면 못 쥐고, 그 프로세스가 죽으면(SIGKILL) 커널이 풀어 쥔다** — 시계에 기대지 않는다', async () => {
    const child = await holder();
    const e = new LeaderElection(openLeaderLockForTest(dsn), 'here');
    try {
      expect(await e.tryAcquire()).toBe(false);
      expect(e.state.reason).toMatch(/다른 인스턴스가 리더다/);
      const gone = new Promise((r) => child.on('exit', r));
      child.kill('SIGKILL');
      await gone;
      expect(await e.tryAcquire()).toBe(true);
    } finally {
      child.kill('SIGKILL');
      await e.release();
    }
  });

  it('토큰은 다시 열어도 엄격히 커진다 — 카운터는 설정 DB 에 있고 `leadership` 에 적힌다', async () => {
    const tokens: bigint[] = [];
    for (let i = 0; i < 3; i++) {
      const e = new LeaderElection(openLeaderLockForTest(dsn), `n${i}`);
      expect(await e.tryAcquire()).toBe(true);
      tokens.push(BigInt(e.assertLeader()));
      await e.release();
    }
    expect(tokens[1]! > tokens[0]! && tokens[2]! > tokens[1]!).toBe(true);
    const rows = (await db.query('SELECT token, holder, released_at FROM leadership ORDER BY token')).rows;
    expect(rows.slice(-3).map((r) => [r['holder'], r['released_at'] instanceof Date])).toEqual([['n0', true], ['n1', true], ['n2', true]]);
  });

  it('**잠금 파일이 바뀌면 그 순간 리더가 아니다** — 지워진 자리에 다른 프로세스가 새 파일을 잠글 수 있다', async () => {
    const e = new LeaderElection(openLeaderLockForTest(dsn), 'moved');
    try {
      expect(await e.tryAcquire()).toBe(true);
      const lock = leaderLockPathOf(sqlitePathOf(dsn));
      renameSync(lock, `${lock}.old`);
      await new Promise((r) => setTimeout(r, LEADER_WATCH_MS * 2.5));
      expect(e.state.isLeader).toBe(false);
      expect(e.state.reason).toMatch(/잠금 파일이 없어졌다|잠금 파일이 바뀌었다/);
      expect(() => e.assertLeader()).toThrow(/리더가 아니다/);
      rmSync(`${lock}.old`, { force: true });
    } finally {
      await e.release();
    }
  });
});
