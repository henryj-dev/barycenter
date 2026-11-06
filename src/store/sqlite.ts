/**
 * SQLite 연결과 마이그레이션 (docs/adr-multi-db.md 「SQLite」)
 *
 * **`Database` 경계(`./db.ts`)의 SQLite 구현이다.** 드라이버는 Node 내장 `node:sqlite` 다 — 새 런타임
 * 의존성이 없다. 그 모듈은 **동기** API 이고 Node 22.13 / 23.4 부터 플래그 없이 열린다. 그래서
 * 정적 `import` 를 쓰지 않고 `process.getBuiltinModule` 로 **열 때** 가져온다 — PG 만 쓰는 데몬은
 * 이 모듈을 건드리지 않는다(낡은 Node 22 에서 `node:sqlite` 를 못 열어도 PG 기동은 그대로다).
 *
 * ── 연결 둘 ────────────────────────────────────────────────────────────
 *
 * - **쓰기 연결 하나.** SQLite 는 쓰기가 DB 전체에 한 줄이다. 트랜잭션은 `BEGIN IMMEDIATE` 로 연다 —
 *   PG 가 단일 행 머리를 `FOR UPDATE` 로 잠가 쓰기를 줄 세우는 자리(`config_head` · `health_cursor`)의
 *   뜻을 이것이 이미 진다. **프로세스 안의 직렬화는 비동기 뮤텍스**다. 같은 프로세스 안에서
 *   `busy_timeout` 으로 기다리면 동기 API 가 이벤트 루프를 막아 잠금을 쥔 쪽이 영영 못 끝난다.
 *   `busy_timeout` 은 **다른 프로세스**(마이그레이션 · 운영 도구)를 기다리는 몫이다.
 * - **읽기 연결 하나.** 트랜잭션 밖의 `SELECT` 는 이쪽으로 간다. WAL 이라 쓰기 트랜잭션이 열려 있어도
 *   막히지 않고 **커밋된 것만** 본다 — PG 의 READ COMMITTED 에서 풀의 다른 연결이 보는 것과 같다.
 *
 * ── 드라이버가 맞추는 것 (SQL 을 만들지 않는다) ──────────────────────────
 *
 * - **자리 표시 `$n` → `?n`.** SQLite 는 `?NNN` 을 그대로 안다(번호가 곧 인자 자리). `$n` 을 그대로 두면
 *   SQLite 는 그것을 **이름 붙은** 인자로 읽고 처음 나온 순서로 번호를 매긴다 — `$2 … $1` 이 뒤집힌다.
 *   문자열 · 따옴표 이름 · 주석 안은 건드리지 않는다. 이것은 문법 대응이지 SQL 생성이 아니다.
 * - **`now()` · `gen_random_uuid()` 를 함수로 건다.** PG 문장이 그대로 SQLite 에서 뜻이 같게 돈다.
 *   `now()` 는 PG 처럼 **트랜잭션 안에서 같은 값**이다. 형식은 하나 — `Date#toISOString()`
 *   (`YYYY-MM-DDTHH:MM:SS.sssZ`, UTC, 밀리초 셋). DDL 의 기본값은 같은 형식을 내는 내장
 *   `strftime('%Y-%m-%dT%H:%M:%fZ','now')` 를 쓴다(이 함수가 없는 도구로 열어도 삽입이 된다).
 *   **한 형식이라 문자열 비교가 시각 비교다.**
 * - **인자:** `boolean` → 1/0, `Date` → ISO, 배열 · 객체 → JSON 텍스트(pg 가 객체를 JSON 으로 보내는 것과
 *   같고, 배열은 `json_each(?)` 로 펼친다), `undefined` → NULL.
 * - **결과:** 열의 **선언 형**으로 PG 가 주는 JS 값과 같게 맞춘다 — 아래 `decode`. 선언 형은
 *   SQLite 계열 마이그레이션이 정한다(`dialects/sqlite/migrations/001_init.sql` 머리말).
 *
 * ── 크래시 시맨틱 ───────────────────────────────────────────────────────
 *
 * 연결마다 `journal_mode=WAL` · `synchronous=FULL` · `foreign_keys=ON` · `busy_timeout`. FULL 은 커밋마다
 * WAL 을 fsync 한다 — PG 의 기본(`synchronous_commit=on`)과 같은 내구성이다.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

import { DIALECTS, type Database, type Dialect, type MigrationSet, type Queryable, type Row } from './db.js';
import { runMigrations, type MigrationDriver } from './migrate.js';
import { CONFIG_MIGRATIONS } from './migration-sets.js';

/** `node:sqlite` 에서 쓰는 만큼의 모양. 타입 정의(`@types/node`)가 Node 버전마다 달라 여기 좁게 적는다. */
type SqlValue = null | number | bigint | string | Uint8Array;
type ColumnInfo = { readonly name: string; readonly type: string | null };
interface Stmt {
  all(...params: SqlValue[]): Record<string, unknown>[];
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  columns(): ColumnInfo[];
  setReadBigInts(on: boolean): void;
}
export interface SqliteConn {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
  close(): void;
  function(name: string, opts: { deterministic?: boolean; varargs?: boolean }, fn: (...a: never[]) => SqlValue): void;
}
type SqliteModule = {
  DatabaseSync: new (path: string, opts?: { timeout?: number; readOnly?: boolean; enableForeignKeyConstraints?: boolean }) => SqliteConn;
};

/** 최소 SQLite 버전 — `RETURNING`(3.35) · upsert(3.24) (ADR 「범위」). */
const MIN_VERSION = [3, 35, 0] as const;

/** 다른 프로세스의 쓰기를 기다리는 상한. 넘으면 `database is locked` 로 그 문장이 실패한다. */
export const BUSY_TIMEOUT_MS = 5_000;

let cached: SqliteModule | undefined;
export function sqliteModule(): SqliteModule {
  if (cached !== undefined) return cached;
  const m = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule?.('node:sqlite');
  if (m === undefined) {
    throw new Error(`이 Node(${process.version})는 node:sqlite 를 열 수 없다 — SQLite 저장소는 Node 22.13+ · 24+ 가 필요하다`);
  }
  cached = m as SqliteModule;
  return cached;
}

/**
 * `sqlite:/abs/path.db` · `sqlite:///abs/path.db` → 경로. **절대 경로만** 받는다 — 상대 경로는 데몬의 작업
 * 디렉터리에 따라 다른 파일을 열고, `:memory:` 는 연결 둘(쓰기 · 읽기)이 서로 다른 DB 를 본다.
 * 오류에 DSN 을 그대로 싣지 않는다(다른 스킴의 DSN 과 같은 규칙).
 */
export function sqlitePathOf(dsn: string, label = 'DSN'): string {
  const m = /^sqlite:(?:\/\/)?(.*)$/i.exec(dsn.trim());
  const raw = m?.[1] ?? '';
  const path = raw.split('?')[0] ?? '';
  if (path === '' || !isAbsolute(path)) {
    throw new Error(`${label} 의 sqlite: 경로는 절대 경로여야 한다 (예: sqlite:/var/lib/barycenter/bary.db)`);
  }
  return decodeURIComponent(path);
}

/**
 * `$n` → `?n`. 문자열(`'…'`) · 따옴표 이름(`"…"`) · 주석(`--` · `/* … *\/`) 안은 그대로 둔다.
 * 바꾼 결과는 캐시한다 — 같은 문장이 반복해서 온다.
 */
export function rewritePlaceholders(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i]!;
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      for (; j < n; j++) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) { j++; continue; }
          break;
        }
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const j = sql.indexOf('\n', i);
      const end = j === -1 ? n : j;
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const j = sql.indexOf('*/', i + 2);
      const end = j === -1 ? n : j + 2;
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '$' && /[0-9]/.test(sql[i + 1] ?? '')) {
      let j = i + 1;
      while (j < n && /[0-9]/.test(sql[j]!)) j++;
      out += `?${sql.slice(i + 1, j)}`;
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** JS 인자를 SQLite 가 받는 값으로. */
export function encodeParam(v: unknown): SqlValue {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'string') return v;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * 선언 형 → PG 가 주는 JS 값과 같은 모양. 선언 형이 없는 열(식 · 집계)은 SQLite 의 값 그대로 —
 * 다만 정수는 2^53 안이면 `number`, 넘으면 문자열이다(PG 의 `count(*)` 는 bigint 문자열인데 소비자는
 * 그것을 `Number(…)` 로 읽는다 — 둘 다 같은 값이 된다).
 *
 * | 선언 형 | JS |
 * |---|---|
 * | `int` | number (PG `integer`) |
 * | `integer` · `bigint` | **decimal string** (PG `bigint` · `bigserial` — 2^53 위에서 뭉개지지 않게) |
 * | `boolean` | boolean |
 * | `timestamptz` | Date (pg 와 같다) |
 * | `json_text` | 파싱한 값 (pg 의 `jsonb`) |
 * | `text_array` | string[] (pg 의 `text[]`) |
 * | `blob` | Buffer (pg 의 `bytea`) |
 * | 그 밖(`text` · `uuid` · `enum_text` · `cidr` · `numeric` · `real`) | 그대로 |
 */
export function decode(type: string | null, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  switch (type?.toLowerCase()) {
    case 'int':
      return typeof v === 'bigint' ? Number(v) : v;
    case 'integer':
    case 'bigint':
      return typeof v === 'bigint' || typeof v === 'number' ? String(v) : v;
    case 'boolean':
      return v === 1 || v === 1n || v === true || v === '1' || v === 'true';
    case 'timestamptz':
      return typeof v === 'string' ? new Date(v) : v;
    case 'json_text':
    case 'text_array':
      return typeof v === 'string' ? JSON.parse(v) : v;
    case 'blob':
      return v instanceof Uint8Array ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : v;
    case 'real':
    case 'numeric':
      return typeof v === 'bigint' ? Number(v) : v;
    default:
      if (typeof v === 'bigint') return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : String(v);
      return v;
  }
}

/** 비동기 뮤텍스 — 프로세스 안의 쓰기를 한 줄로. */
class Mutex {
  #tail: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.#tail;
    let done!: () => void;
    this.#tail = new Promise((r) => { done = r; });
    await prev;
    try {
      return await fn();
    } finally {
      done();
    }
  }
}

const isRead = (sql: string): boolean => {
  const head = sql.replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, '').slice(0, 16).toUpperCase();
  if (head.startsWith('SELECT') || head.startsWith('VALUES')) return true;
  if (head.startsWith('WITH')) return !/\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql);
  return false;
};

/** 연결 하나를 연다 — PRAGMA · 함수 · 버전 검사. */
export function openConn(path: string, opts: { readOnly?: boolean; now?: () => string } = {}): SqliteConn {
  const { DatabaseSync } = sqliteModule();
  const c = new DatabaseSync(path, { timeout: BUSY_TIMEOUT_MS, ...(opts.readOnly === true ? { readOnly: true } : {}) });
  try {
    const v = String((c.prepare('SELECT sqlite_version() AS v').all()[0] ?? {})['v'] ?? '0');
    const parts = v.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      const a = parts[i] ?? 0;
      const b = MIN_VERSION[i] ?? 0;
      if (a > b) break;
      if (a < b) throw new Error(`SQLite ${v} 는 너무 낮다 — ${MIN_VERSION.join('.')}+ 가 필요하다 (RETURNING · upsert)`);
    }
    if (opts.readOnly !== true) c.exec('PRAGMA journal_mode = WAL');
    c.exec('PRAGMA synchronous = FULL');
    c.exec('PRAGMA foreign_keys = ON');
    c.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    const now = opts.now ?? ((): string => new Date().toISOString());
    c.function('now', { deterministic: false }, () => now());
    c.function('gen_random_uuid', { deterministic: false }, () => randomUUID());
    return c;
  } catch (e) {
    c.close();
    throw e;
  }
}

type Result = { rows: Row[]; rowCount: number | null };

/**
 * SQLite 의 제약 오류에 **PG 의 SQLSTATE** 를 단다 — `code` · `constraint` · `detail`.
 *
 * 저장소 함수는 제약 위반을 PG 코드로 가른다(`23505` 유일 → 409, `23503` FK · `23514` CHECK → 422 —
 * `config-store.ts` 의 `translate`). 그 갈래를 방언마다 다시 쓰면 한쪽을 잊는다. 그래서 드라이버가
 * 맞춘다. 원래 코드(`ERR_SQLITE_ERROR`)는 `sqliteCode`, 확장 결과 코드는 `errcode` 에 남는다.
 *
 * `constraint` 는 SQLite 가 말하는 만큼이다: CHECK 는 제약 이름, UNIQUE 는 `표.열`, FK 는 이름이 없다.
 */
const SQLSTATE: Readonly<Record<number, string>> = {
  2067: '23505', // SQLITE_CONSTRAINT_UNIQUE
  1555: '23505', // SQLITE_CONSTRAINT_PRIMARYKEY
  787: '23503', // SQLITE_CONSTRAINT_FOREIGNKEY
  275: '23514', // SQLITE_CONSTRAINT_CHECK
  1299: '23502', // SQLITE_CONSTRAINT_NOTNULL
};

export function mapSqliteError(e: unknown): unknown {
  if (typeof e !== 'object' || e === null) return e;
  const err = e as { code?: string; errcode?: number; message?: string; sqliteCode?: string; constraint?: string; detail?: string };
  const state = err.errcode === undefined ? undefined : SQLSTATE[err.errcode];
  if (state === undefined) return e;
  const msg = String(err.message ?? '');
  const m = /constraint failed: (.+)$/i.exec(msg);
  if (err.code !== undefined) err.sqliteCode = err.code;
  err.code = state;
  if (m !== null && state !== '23503') err.constraint = (m[1] ?? '').trim();
  err.detail = msg;
  return e;
}

/** 연결 하나에 문장 하나. 준비한 문장은 캐시한다. */
class Runner {
  readonly #cache = new Map<string, Stmt>();
  constructor(readonly conn: SqliteConn) {}

  run(text: string, values?: readonly unknown[]): Result {
    let st = this.#cache.get(text);
    if (st === undefined) {
      st = this.conn.prepare(rewritePlaceholders(text));
      st.setReadBigInts(true);
      if (this.#cache.size > 512) this.#cache.clear();
      this.#cache.set(text, st);
    }
    const params = (values ?? []).map(encodeParam);
    const cols = st.columns();
    if (cols.length === 0) {
      let r: { changes: number | bigint };
      try {
        r = st.run(...params);
      } catch (e) {
        throw mapSqliteError(e);
      }
      return { rows: [], rowCount: Number(r.changes) };
    }
    let raw: Record<string, unknown>[];
    try {
      raw = st.all(...params);
    } catch (e) {
      throw mapSqliteError(e);
    }
    const rows = raw.map((r) => {
      const o: Row = {};
      for (const c of cols) o[c.name] = decode(c.type, r[c.name]);
      return o;
    });
    return { rows, rowCount: rows.length };
  }

  close(): void {
    this.#cache.clear();
    this.conn.close();
  }
}

export class SqliteDb implements Database {
  readonly dialect: Dialect = DIALECTS.sqlite;
  readonly path: string;
  readonly #writer: Runner;
  readonly #reader: Runner;
  readonly #lock = new Mutex();
  /** 지금 이 비동기 흐름이 이 DB 의 트랜잭션 안인가. 안에서 바깥 쓰기를 부르면 영영 기다린다 — 그 전에 던진다. */
  readonly #inTx = new AsyncLocalStorage<true>();
  /** 트랜잭션 안의 `now()` — PG 처럼 트랜잭션 시작 시각 하나. */
  #txNow: string | undefined;

  constructor(dsn: string, label = 'DSN') {
    this.path = sqlitePathOf(dsn, label);
    const now = (): string => this.#txNow ?? new Date().toISOString();
    this.#writer = new Runner(openConn(this.path, { now }));
    try {
      this.#reader = new Runner(openConn(this.path, { now }));
    } catch (e) {
      this.#writer.close();
      throw e;
    }
  }

  async query(text: string, values?: readonly unknown[]): Promise<Result> {
    if (isRead(text)) return this.#reader.run(text, values);
    if (this.#inTx.getStore() === true) {
      throw new Error('SQLite: 트랜잭션 안에서 트랜잭션 밖의 쓰기를 불렀다 — 쓰기는 한 줄이라 영영 기다린다 (트랜잭션의 연결로 쓴다)');
    }
    return this.#lock.run(async () => this.#writer.run(text, values));
  }

  #txQueryable(): Queryable {
    return {
      dialect: this.dialect,
      query: async (text, values) => this.#writer.run(text, values),
    };
  }

  async #inWriteTx<T>(fn: (c: Queryable) => Promise<T>, commit: boolean): Promise<T> {
    if (this.#inTx.getStore() === true) {
      throw new Error('SQLite: 트랜잭션 안에서 트랜잭션을 또 열었다 — 쓰기는 한 줄이라 영영 기다린다');
    }
    return this.#lock.run(async () => this.#inTx.run(true, async () => {
      this.#writer.conn.exec('BEGIN IMMEDIATE');
      this.#txNow = new Date().toISOString();
      try {
        const out = await fn(this.#txQueryable());
        // 미뤄 둔 FK 검사(`defer_foreign_keys`)는 COMMIT 에서 깨진다 — 같은 SQLSTATE 로 옮긴다.
        if (commit) {
          try { this.#writer.conn.exec('COMMIT'); } catch (e) { throw mapSqliteError(e); }
        } else this.#writer.conn.exec('ROLLBACK');
        return out;
      } catch (e) {
        try { this.#writer.conn.exec('ROLLBACK'); } catch { /* 이미 끝난 트랜잭션 */ }
        throw e;
      } finally {
        this.#txNow = undefined;
      }
    }));
  }

  /** 트랜잭션. 콜백이 던지면 롤백한다. `BEGIN IMMEDIATE` — 시작할 때 쓰기 잠금을 쥔다. */
  async tx<T>(fn: (c: Queryable) => Promise<T>): Promise<T> {
    return this.#inWriteTx(fn, true);
  }

  /** 콜백 결과와 무관하게 **항상 롤백**한다. plan 의 시뮬레이션 전용. */
  async dryRun<T>(fn: (c: Queryable) => Promise<T>): Promise<T> {
    return this.#inWriteTx(fn, false);
  }

  /**
   * 스키마를 최신으로. 계열 하나를 **한 쓰기 트랜잭션**으로 돈다 — `BEGIN IMMEDIATE` 가 다른 프로세스의
   * 마이그레이션 · 쓰기를 막는다(PG 의 advisory 계열 잠금 자리). 파일 하나는 SAVEPOINT 하나다.
   * 중간 파일이 깨지면 계열 전체가 롤백된다 — 반쯤 적용된 스키마가 남지 않는다.
   */
  async migrate(set: MigrationSet = CONFIG_MIGRATIONS): Promise<string[]> {
    return runMigrations(this.#migrationDriver(), set);
  }

  #migrationDriver(): MigrationDriver {
    const w = this.#writer;
    return {
      dialect: this.dialect,
      withMigrationLock: async (_lock, fn) => this.#lock.run(async () => {
        w.conn.exec('BEGIN IMMEDIATE');
        try {
          const out = await fn();
          w.conn.exec('COMMIT');
          return out;
        } catch (e) {
          try { w.conn.exec('ROLLBACK'); } catch { /* 이미 끝났다 */ }
          throw e;
        }
      }),
      ensureTable: async (table) => {
        w.conn.exec(`CREATE TABLE IF NOT EXISTS ${table} (
          name text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`);
      },
      appliedNames: async (table) => new Set(w.run(`SELECT name FROM ${table}`).rows.map((r) => String(r['name']))),
      applyOne: async (table, name, sql) => {
        w.conn.exec('SAVEPOINT bary_migration');
        try {
          w.conn.exec(sql);
          w.run(`INSERT INTO ${table} (name) VALUES ($1)`, [name]);
          w.conn.exec('RELEASE bary_migration');
        } catch (e) {
          try { w.conn.exec('ROLLBACK TO bary_migration'); w.conn.exec('RELEASE bary_migration'); } catch { /* 바깥 롤백이 치운다 */ }
          throw new Error(`마이그레이션 ${name} 이 실패했다: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    };
  }

  async close(): Promise<void> {
    await this.#lock.run(async () => {
      this.#reader.close();
      this.#writer.close();
    });
  }
}
