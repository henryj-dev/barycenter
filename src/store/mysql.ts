/**
 * MySQL 8 · MariaDB 연결과 마이그레이션 (docs/adr-multi-db.md 「3단계 — MySQL/MariaDB」)
 *
 * **`Database` 경계(`./db.ts`)의 MySQL 구현이다.** MariaDB 는 같은 구현의 한 종류다 — 문장은 둘 다에서 도는 것만
 * 쓰고, 드라이버가 서버 종류(`VERSION()`)를 보고 오류 코드만 가른다. 드라이버는 `mysql2` 하나다. **열 때**
 * `import()` 로 가져온다 — PG 만 쓰는 데몬은 이 패키지를 건드리지 않는다(SQLite 의 `node:sqlite` 와 같은 방식).
 *
 * ── 세션 설정 (연결마다) ────────────────────────────────────────────────
 *
 * | 설정 | 값 | 이유 |
 * |---|---|---|
 * | 격리 | `READ COMMITTED` | PG 의 기본과 같다. 기본 REPEATABLE READ 는 잠그지 않은 읽기가 트랜잭션 시작 시점의 스냅샷이다 |
 * | 문자 | `utf8mb4` · `utf8mb4_bin` | 4 바이트 UTF-8. 비교는 바이트 — PG 의 `text` 처럼 대소문자를 가른다 |
 * | 시간대 | `+00:00` | `DATETIME(6)` 은 시간대가 없다. 모든 시각을 UTC 로 적고 읽는다(드라이버도 `timezone: 'Z'`) |
 * | `sql_mode` | 아래 `SQL_MODE` | 엄격 — 잘린 값 · 0 날짜 · 0 나누기가 오류다(PG 처럼). 따옴표 · `||` · 역슬래시가 PG 와 같은 뜻 |
 *
 * ── 드라이버가 맞추는 것 (SQL 을 만들지 않는다) ──────────────────────────
 *
 * - **자리 표시 `$n`.** 값을 리터럴로 그 자리에 넣는다(같은 `$n` 이 여러 번 · 어떤 순서든). 따옴표 문자열 ·
 *   따옴표 이름 · 주석 안은 건드리지 않는다. 리터럴은 `NO_BACKSLASH_ESCAPES` 아래의 표준 SQL 문자열이다 —
 *   따옴표를 두 번 쓰는 것 하나가 이스케이프의 전부라 다른 해석이 없다.
 * - **`now()`.** 트랜잭션 안에서는 그 트랜잭션의 한 값(처음 쓸 때 `UTC_TIMESTAMP(6)` 을 세션 변수에 담는다 — PG 의
 *   `now()` 처럼 트랜잭션 안에서 변하지 않는다), 밖에서는 문장의 `UTC_TIMESTAMP(6)`. 둘 다 DB 의 시계다.
 * - **`gen_random_uuid()`.** 그 자리에 v4 UUID 리터럴(`randomUUID()`). MySQL 의 `UUID()` 는 v1 이다.
 * - **예약어 이름 `key` · `before`.** PG 문장의 열 이름이 MySQL 에서 예약어다. 따옴표를 친다(`ANSI_QUOTES` 라 `"key"`).
 *   `ON DUPLICATE KEY` · `PRIMARY KEY` 처럼 문법 자리의 `KEY` 는 그대로다.
 * - **인자:** boolean → `TRUE`/`FALSE`, Date · ISO-8601 UTC 문자열(`…Z`) → `'YYYY-MM-DD HH:MM:SS.ffffff'`
 *   (`DATETIME` 은 `Z` 를 받지 않는다), 배열 · 객체 → JSON 텍스트, Buffer → `X'…'`, bigint → 수.
 * - **결과:** PG 와 같은 JS 값 — `BIGINT` · `DECIMAL` → 문자열(`bigNumberStrings`), `INT` → number,
 *   `BOOLEAN`(`TINYINT(1)`) → boolean, `DATETIME` → Date, `JSON` → 파싱한 값(MariaDB 는 확장 메타데이터로 안다),
 *   이진 → Buffer. **식에는 선언 형이 없다** — 식의 참/거짓은 `1`/`0`(MySQL 은 문자열 `'1'`, MariaDB 는 수)이다.
 * - **`rowCount`.** `UPDATE` 는 **맞은 행 수**(PG 와 같다 — 값이 같아 안 바뀐 행도 센다), 나머지는 영향 받은 행 수.
 *   `INSERT … ON DUPLICATE KEY UPDATE` 는 MySQL 의 수(넣음 1 · 바꿈 2 · 그대로 0) 그대로다 — 저장소 함수가 본다.
 * - **제약 오류 → PG SQLSTATE** (`23505` · `23503` · `23514` · `23502`) 와 `constraint`(제약 이름 — MySQL 계열은
 *   PG 와 같은 이름으로 만든다). 저장소의 409/422 갈래가 방언마다 같다.
 *
 * 맞추지 않는 것(저장소 함수가 갈래를 둔다): `RETURNING` · `ON CONFLICT` · `::형` · `interval` · `= ANY` · `jsonb` 연산 · 시퀀스.
 *
 * ── 크래시 시맨틱 ───────────────────────────────────────────────────────
 *
 * InnoDB 의 redo log. `innodb_flush_log_at_trx_commit=1` 이어야 커밋이 PG 처럼 내구적이다 — 마이그레이션(기동)이
 * 확인하고 아니면 거부한다.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { log } from '../obs/log.js';
import { DIALECTS, dbKindOf, type Database, type Dialect, type MigrationSet, type Queryable, type Row } from './db.js';
import { runMigrations, type MigrationDriver } from './migrate.js';
import { CONFIG_MIGRATIONS } from './migration-sets.js';

/** 연결마다 거는 `sql_mode`. `ANSI_QUOTES` 는 `"이름"` 을 PG 처럼 이름으로, `PIPES_AS_CONCAT` 은 `||` 를 이어 붙이기로 읽는다. */
export const SQL_MODE = [
  'STRICT_ALL_TABLES', 'NO_ZERO_IN_DATE', 'NO_ZERO_DATE', 'ERROR_FOR_DIVISION_BY_ZERO', 'NO_ENGINE_SUBSTITUTION',
  'ANSI_QUOTES', 'PIPES_AS_CONCAT', 'NO_BACKSLASH_ESCAPES',
].join(',');

/** 최소 버전 — `CHECK` 강제 · 식 기본값 · `JSON_TABLE` · `CREATE TRIGGER IF NOT EXISTS`(MySQL 8.0.29) · `SKIP LOCKED`(MariaDB 10.6). */
const MIN_MYSQL = [8, 0, 29] as const;
const MIN_MARIADB = [10, 6, 0] as const;

export type MysqlFlavor = 'mysql' | 'mariadb';

/** `mysql2/promise` 에서 쓰는 만큼의 모양. */
type OkPacket = { affectedRows: number; info?: string; insertId?: number | string };
type FieldInfo = { type: string; length: number; string(): string | null; buffer(): Buffer | null };
export interface MyConn {
  query(sql: string): Promise<[unknown, unknown]>;
  release?(): void;
  end(): Promise<void>;
  destroy(): void;
  on(ev: 'error' | 'end', fn: (e?: Error) => void): void;
  readonly connection?: { on(ev: string, fn: (e?: Error) => void): void; threadId?: number };
  readonly threadId?: number;
}
interface MyPool {
  getConnection(): Promise<MyConn & { release(): void }>;
  end(): Promise<void>;
}
type MysqlModule = {
  createPool(o: Record<string, unknown>): MyPool;
  createConnection(o: Record<string, unknown>): Promise<MyConn>;
};

let cached: Promise<MysqlModule> | undefined;
/** 열 때 가져온다 — 정적 `import` 를 두면 PG 만 쓰는 데몬도 이 패키지를 싣는다. */
export async function mysqlModule(): Promise<MysqlModule> {
  cached ??= import('mysql2/promise').then((m) => (m as unknown as { default?: MysqlModule }).default ?? (m as unknown as MysqlModule));
  return cached;
}

export type MysqlConfig = { readonly options: Readonly<Record<string, unknown>>; readonly database: string };

/**
 * `mysql://user:pass@host:3306/db` · `mariadb://…` → mysql2 의 연결 옵션. 인자: `socket=/path`(유닉스 소켓) ·
 * `ssl=true`(시스템 CA 로 검증) · `sslca=/path/ca.pem`. **DB 이름은 꼭 있어야 한다** — 리더 잠금의 이름과 표가
 * 그 DB 에 묶인다. 오류에 DSN 을 싣지 않는다(비밀번호가 들어 있다).
 */
export function mysqlConfigOf(dsn: string, label = 'DSN'): MysqlConfig {
  let u: URL;
  try {
    u = new URL(dsn.trim().replace(/^mariadb:/i, 'mysql:'));
  } catch {
    throw new Error(`${label} 의 mysql: DSN 을 읽을 수 없다 (예: mysql://bary:…@db.internal:3306/bary)`);
  }
  const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (database === '' || database.includes('/')) throw new Error(`${label} 의 mysql: DSN 에 DB 이름이 없다 (…:3306/<db>)`);
  const options: Record<string, unknown> = {
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database,
    timezone: 'Z',
    dateStrings: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    // utf8mb4 · utf8mb4_bin — 리터럴끼리의 비교도 바이트 비교다.
    charset: 'UTF8MB4_BIN',
    // FOUND_ROWS 를 끈다 — `ON DUPLICATE KEY UPDATE` 의 「그대로」 가 0 이어야 PG 의 `DO NOTHING` 과 같은 수가 된다.
    // `UPDATE` 의 「맞은 행」 은 OK 패킷의 info 에서 읽는다(`rowCountOf`).
    flags: ['-FOUND_ROWS'],
    multipleStatements: false,
    typeCast,
  };
  const socket = u.searchParams.get('socket');
  if (socket !== null && socket !== '') options['socketPath'] = socket;
  else {
    options['host'] = u.hostname === '' ? '127.0.0.1' : u.hostname.replace(/^\[|\]$/g, '');
    options['port'] = u.port === '' ? 3306 : Number(u.port);
  }
  const ssl = u.searchParams.get('ssl');
  const sslca = u.searchParams.get('sslca');
  if (sslca !== null && sslca !== '') options['ssl'] = { ca: readFileSync(sslca, 'utf8'), rejectUnauthorized: true };
  else if (ssl === 'true' || ssl === 'require' || ssl === '1') options['ssl'] = { rejectUnauthorized: true };
  return { options, database };
}

/** `BOOLEAN`(`TINYINT(1)`) → boolean. 나머지는 mysql2 의 기본(위 옵션)이다. */
function typeCast(field: FieldInfo, next: () => unknown): unknown {
  if (field.type === 'TINY' && field.length === 1) {
    const v = field.string();
    return v === null ? null : v !== '0';
  }
  return next();
}

/** 세션을 PG 와 맞춘다. 새 연결마다 한 번. */
export async function initSession(c: MyConn): Promise<void> {
  await c.query(`SET SESSION time_zone = '+00:00', SESSION sql_mode = '${SQL_MODE}'`);
  await c.query('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED');
}

// ── 문장 옮기기 ────────────────────────────────────────────────────────────

/** `'…'` 리터럴. `NO_BACKSLASH_ESCAPES` 아래에서는 따옴표를 두 번 쓰는 것 하나가 이스케이프의 전부다. */
const quote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

const ISO_UTC = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d{1,6})?Z$/;

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
/** Date → `DATETIME(6)` 리터럴의 속(UTC). */
export function datetimeText(d: Date): string {
  if (Number.isNaN(d.getTime())) throw new Error('MySQL: 잘못된 Date 를 인자로 받았다');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
    + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
}

/** JS 인자 → SQL 리터럴. */
export function literal(v: unknown): string {
  if (v === undefined || v === null) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`MySQL: 유한하지 않은 수를 인자로 받았다: ${v}`);
    return String(v);
  }
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'string') {
    const m = ISO_UTC.exec(v);
    return m === null ? quote(v) : quote(`${m[1]} ${m[2]}${m[3] ?? ''}`);
  }
  if (v instanceof Date) return quote(datetimeText(v));
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return `X'${Buffer.from(v).toString('hex')}'`;
  if (typeof v === 'object') return quote(JSON.stringify(v));
  return quote(String(v));
}

/** 따옴표를 쳐야 하는 이름 — PG 문장의 열 이름인데 MySQL 의 예약어다(스키마의 이름을 두 서버에 넣어 보고 골랐다). */
const RESERVED_IDENTS = new Set(['key', 'before']);
/** 바로 앞 낱말이 이것이면 `KEY` 는 문법이다. */
const KEY_SYNTAX_BEFORE = new Set(['duplicate', 'primary', 'foreign', 'unique']);

/**
 * PG 문장 → MySQL 문장. `$n` 에 리터럴을 넣고, `now()` · `gen_random_uuid()` · 예약어 이름을 옮긴다.
 * `inTx` 면 `now()` 가 그 트랜잭션의 한 값(`@bary_now`)이다 — 쓰였는지(`usesNow`)를 돌려준다.
 */
export function rewriteMysql(sql: string, values: readonly unknown[] = [], opts: { inTx?: boolean } = {}): { sql: string; usesNow: boolean } {
  let out = '';
  let usesNow = false;
  let prevWord = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i]!;
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      for (; j < n; j++) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) { j++; continue; }
          break;
        }
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
      prevWord = '';
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
      const k = Number(sql.slice(i + 1, j));
      if (k < 1 || k > values.length) throw new Error(`MySQL: 문장의 $${k} 에 줄 인자가 없다 (인자 ${values.length} 개)`);
      out += literal(values[k - 1]);
      i = j;
      prevWord = '';
      continue;
    }
    if (/[A-Za-z_]/.test(ch) && !/[A-Za-z0-9_$.]/.test(sql[i - 1] ?? ' ')) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j]!)) j++;
      const word = sql.slice(i, j);
      const lower = word.toLowerCase();
      const call = /^\s*\(\s*\)/.exec(sql.slice(j));
      if (lower === 'now' && call !== null) {
        if (opts.inTx === true) { out += 'CAST(@bary_now AS DATETIME(6))'; usesNow = true; } else out += 'UTC_TIMESTAMP(6)';
        i = j + call[0].length;
        prevWord = '';
        continue;
      }
      if (lower === 'gen_random_uuid' && call !== null) {
        out += quote(randomUUID());
        i = j + call[0].length;
        prevWord = '';
        continue;
      }
      // `t.key` 처럼 점 뒤의 이름도 예약어다 — 앞 글자가 점이어도 따옴표를 친다.
      if (RESERVED_IDENTS.has(lower) && !(lower === 'key' && KEY_SYNTAX_BEFORE.has(prevWord))) out += `"${word}"`;
      else out += word;
      prevWord = lower;
      i = j;
      continue;
    }
    if (ch === '.' && /[A-Za-z_]/.test(sql[i + 1] ?? '') && /[A-Za-z0-9_"`]/.test(sql[i - 1] ?? ' ')) {
      // 한정 이름(`a.key`) — 점 뒤의 낱말을 이름으로 본다.
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j]!)) j++;
      const word = sql.slice(i + 1, j);
      out += RESERVED_IDENTS.has(word.toLowerCase()) ? `."${word}"` : `.${word}`;
      i = j;
      prevWord = '';
      continue;
    }
    if (!/\s/.test(ch)) prevWord = '';
    out += ch;
    i++;
  }
  return { sql: out, usesNow };
}

// ── 오류 ───────────────────────────────────────────────────────────────────

type MyErr = { errno?: number; code?: string | number; sqlMessage?: string; message?: string; mysqlCode?: string; constraint?: string; detail?: string; table?: string };

/**
 * MySQL 계열의 오류에 **PG 의 SQLSTATE** 를 단다 — `code` · `constraint` · `detail`. 원래 코드(`ER_DUP_ENTRY` 류)는
 * `mysqlCode`, 번호는 `errno` 에 남는다. 제약 이름은 MySQL 계열이 PG 와 같은 이름으로 만들었으므로 그대로 같다
 * (기본 키는 `<표>_pkey` 로 옮긴다).
 */
export function mapMysqlError(e: unknown, flavor: MysqlFlavor, sql?: string): unknown {
  if (typeof e !== 'object' || e === null) return e;
  const err = e as MyErr;
  const msg = String(err.sqlMessage ?? err.message ?? '');
  let state: string | undefined;
  let constraint: string | undefined;
  switch (err.errno) {
    case 1062: { // ER_DUP_ENTRY — "Duplicate entry 'x' for key 'tbl.name'" (MariaDB 는 'name')
      state = '23505';
      const m = /for key '([^']+)'$/.exec(msg);
      const raw = m?.[1] ?? '';
      const dot = raw.lastIndexOf('.');
      const name = dot >= 0 ? raw.slice(dot + 1) : raw;
      // MariaDB 는 표 이름 없이 'PRIMARY' 라고만 한다 — 문장의 대상 표로 채운다.
      const table = dot >= 0 ? raw.slice(0, dot) : targetTableOf(sql);
      constraint = name === 'PRIMARY' && table !== undefined ? `${table}_pkey` : name === 'PRIMARY' ? undefined : name;
      break;
    }
    case 1451: case 1452: case 1216: case 1217: { // FK
      state = '23503';
      const m = /CONSTRAINT [`"]([^`"]+)[`"] FOREIGN KEY/.exec(msg);
      constraint = m?.[1];
      break;
    }
    case 3819: { // MySQL CHECK — "Check constraint 'name' is violated."
      state = '23514';
      constraint = /constraint '([^']+)'/i.exec(msg)?.[1];
      break;
    }
    case 4025: { // MariaDB ER_CONSTRAINT_FAILED — "CONSTRAINT `name` failed for `db`.`t`" (MySQL 의 4025 는 다른 뜻이다)
      if (flavor === 'mariadb') {
        state = '23514';
        constraint = /CONSTRAINT [`"]([^`"]+)[`"] failed/.exec(msg)?.[1];
      }
      break;
    }
    case 1048: case 1364: state = '23502'; break; // NOT NULL · 기본값 없음
    case 1406: state = '22001'; break; // 너무 긴 값
    case 1265: case 1366: state = '22P02'; break; // 잘못된 값(enum 밖 등)
    case 1292: state = '22007'; break; // 잘못된 시각
    case 1213: state = '40P01'; break; // 교착
    case 1205: case 3572: state = '55P03'; break; // 잠금 대기 초과 · NOWAIT
    default: break;
  }
  if (state === undefined) return e;
  if (err.code !== undefined) err.mysqlCode = String(err.code);
  err.code = state;
  if (constraint !== undefined) err.constraint = constraint;
  err.detail = msg;
  return e;
}

/** 쓰기 문장의 대상 표(`INSERT INTO t` · `UPDATE t`). 모르면 undefined. */
function targetTableOf(sql: string | undefined): string | undefined {
  const m = /^\s*(?:INSERT\s+(?:IGNORE\s+)?INTO|REPLACE\s+INTO|UPDATE)\s+[`"]?([A-Za-z_][A-Za-z0-9_]*)/i.exec(sql ?? '');
  return m?.[1];
}

// ── 결과 ───────────────────────────────────────────────────────────────────

type Result = { rows: Row[]; rowCount: number | null };

/** OK 패킷 → PG 의 `rowCount`. `UPDATE` 는 「맞은 행」(info), 나머지는 영향 받은 행. */
export function rowCountOf(ok: OkPacket): number {
  const m = /Rows matched:\s*(\d+)/.exec(ok.info ?? '');
  return m !== null ? Number(m[1]) : ok.affectedRows;
}

const toResult = (r: unknown): Result => {
  if (Array.isArray(r)) return { rows: r as Row[], rowCount: r.length };
  return { rows: [], rowCount: rowCountOf(r as OkPacket) };
};

/** 버전 문자열 → 종류 · 최소 버전 검사. */
export function flavorOf(version: string): MysqlFlavor {
  const flavor: MysqlFlavor = /mariadb/i.test(version) ? 'mariadb' : 'mysql';
  const parts = (/^(\d+)\.(\d+)\.(\d+)/.exec(version) ?? []).slice(1).map(Number);
  const min = flavor === 'mariadb' ? MIN_MARIADB : MIN_MYSQL;
  for (let i = 0; i < 3; i++) {
    const a = parts[i] ?? 0;
    const b = min[i] ?? 0;
    if (a > b) break;
    if (a < b) throw new Error(`${flavor === 'mariadb' ? 'MariaDB' : 'MySQL'} ${version} 은 너무 낮다 — ${min.join('.')}+ 가 필요하다`);
  }
  return flavor;
}

/**
 * 서버 전체에 하나인 이름(`GET_LOCK`)을 이 DB 에 묶는다. PG 의 advisory lock 은 DB 마다 따로지만 MySQL 의 이름 잠금은
 * **서버 전체**다 — 한 서버의 두 DB(두 배포 · 시험 DB 여럿)가 같은 이름을 쓰면 서로의 리더를 막는다. 64 자 상한.
 */
export function lockNameFor(database: string, what: string): string {
  const plain = `bary.${what}.${database}`;
  if (plain.length <= 64) return plain;
  return `bary.${what}.${createHash('sha256').update(database).digest('hex').slice(0, 32)}`;
}

/** 연결 하나 위의 실행기 — 문장을 옮기고, 오류를 PG 코드로 옮긴다. */
export class MyRunner {
  #nowSet = false;
  constructor(readonly conn: MyConn, readonly flavor: MysqlFlavor, readonly inTx: boolean) {}

  async run(text: string, values?: readonly unknown[]): Promise<Result> {
    const { sql, usesNow } = rewriteMysql(text, values ?? [], { inTx: this.inTx });
    try {
      if (usesNow && !this.#nowSet) {
        await this.conn.query('SET @bary_now = UTC_TIMESTAMP(6)');
        this.#nowSet = true;
      }
      const [r] = await this.conn.query(sql);
      return toResult(r);
    } catch (e) {
      throw mapMysqlError(e, this.flavor, sql);
    }
  }
}

/**
 * 마이그레이션 파일 → 문장들. `;` 로 가른다(따옴표 · 주석 안은 빼고). `CREATE TRIGGER … BEGIN … END;` 는 몸 안의
 * `;` 에서 가르지 않는다(`BEGIN`/`CASE` 와 `END` 를 센다). 주석만 남은 조각은 버린다.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  let i = 0;
  const n = sql.length;
  const isTrigger = (): boolean => /^\s*CREATE\s+(?:DEFINER\s*=\s*\S+\s+)?TRIGGER\b/i.test(stripComments(cur));
  while (i < n) {
    const ch = sql[i]!;
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      for (; j < n; j++) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) { j++; continue; }
          break;
        }
      }
      cur += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const j = sql.indexOf('\n', i);
      const end = j === -1 ? n : j;
      cur += sql.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const j = sql.indexOf('*/', i + 2);
      const end = j === -1 ? n : j + 2;
      cur += sql.slice(i, end);
      i = end;
      continue;
    }
    if (/[A-Za-z]/.test(ch) && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? ' ')) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(sql[j]!)) j++;
      const w = sql.slice(i, j).toUpperCase();
      if ((w === 'BEGIN' || w === 'CASE') && isTrigger()) depth++;
      else if (w === 'END' && depth > 0) depth--;
      cur += sql.slice(i, j);
      i = j;
      continue;
    }
    if (ch === ';' && depth === 0) {
      if (stripComments(cur).trim() !== '') out.push(cur.trim());
      cur = '';
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (stripComments(cur).trim() !== '') out.push(cur.trim());
  return out;
}

const stripComments = (s: string): string => s.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

/** 마이그레이션 잠금을 기다리는 한 번의 상한(초). 넘으면 다시 기다린다 — 다른 노드의 마이그레이션이 끝날 때까지. */
const MIGRATE_LOCK_WAIT_S = 10;

export class MysqlDb implements Database {
  readonly dialect: Dialect = DIALECTS.mysql;
  readonly #cfg: MysqlConfig;
  #pool: Promise<MyPool> | undefined;
  #flavor: MysqlFlavor | undefined;
  readonly #ready = new WeakSet<object>();
  #closed = false;

  constructor(dsn: string, label = 'DSN') {
    const kind = dbKindOf(dsn);
    if (kind !== 'mysql' && kind !== 'mariadb') throw new Error(`${label} 의 스킴이 mysql: · mariadb: 이 아니다`);
    this.#cfg = mysqlConfigOf(dsn, label);
  }

  /** 서버 종류. 첫 연결 뒤에 안다. */
  get flavor(): MysqlFlavor | undefined { return this.#flavor; }
  get database(): string { return this.#cfg.database; }

  async #getPool(): Promise<MyPool> {
    if (this.#closed) throw new Error('MySQL: 닫힌 저장소다');
    // 쉬던 연결이 끊기면 mysql2 의 풀이 그 연결을 버린다(연결마다 `error` 처리기를 단다) — 프로세스가 죽지 않는다.
    this.#pool ??= mysqlModule().then((m) => m.createPool({ ...this.#cfg.options, connectionLimit: 8, waitForConnections: true }));
    return this.#pool;
  }

  /** 풀에서 연결 하나 — 처음 보는 연결이면 세션을 맞춘다. */
  async #conn(): Promise<MyConn & { release(): void }> {
    const pool = await this.#getPool();
    const c = await pool.getConnection();
    const key = (c.connection ?? c) as object;
    if (!this.#ready.has(key)) {
      try {
        await initSession(c);
        if (this.#flavor === undefined) {
          const [rows] = await c.query('SELECT VERSION() AS v');
          this.#flavor = flavorOf(String((rows as Row[])[0]?.['v'] ?? ''));
        }
      } catch (e) {
        c.destroy();
        throw e;
      }
      this.#ready.add(key);
    }
    return c;
  }

  async query(text: string, values?: readonly unknown[]): Promise<Result> {
    const c = await this.#conn();
    try {
      return await new MyRunner(c, this.#flavor ?? 'mysql', false).run(text, values);
    } finally {
      c.release();
    }
  }

  async #inTx<T>(fn: (c: Queryable) => Promise<T>, commit: boolean): Promise<T> {
    const c = await this.#conn();
    const r = new MyRunner(c, this.#flavor ?? 'mysql', true);
    try {
      await c.query('START TRANSACTION');
      const out = await fn({ dialect: this.dialect, query: async (text, values) => r.run(text, values) });
      if (commit) {
        try { await c.query('COMMIT'); } catch (e) { throw mapMysqlError(e, this.#flavor ?? 'mysql'); }
      } else await c.query('ROLLBACK');
      return out;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  /** 트랜잭션. 콜백이 던지면 롤백한다. */
  async tx<T>(fn: (c: Queryable) => Promise<T>): Promise<T> {
    return this.#inTx(fn, true);
  }

  /** 콜백 결과와 무관하게 **항상 롤백**한다. plan 의 시뮬레이션 전용. DDL 은 암묵 커밋이라 여기서 쓰면 안 된다. */
  async dryRun<T>(fn: (c: Queryable) => Promise<T>): Promise<T> {
    return this.#inTx(fn, false);
  }

  /**
   * 스키마를 최신으로. **MySQL 의 DDL 은 트랜잭션이 아니다**(문장마다 암묵 커밋) — 파일 하나가 중간에 깨지면 반쯤
   * 적용된다. 그래서 MySQL 계열의 파일은 **다시 돌려도 안전하게** 쓴다(`IF NOT EXISTS` · 씨앗 행은
   * `ON DUPLICATE KEY UPDATE`). 실행기는 문장을 차례로 돌고, 모두 성공한 뒤에 기록한다 — 깨진 파일은 기록이 없으니
   * 다음 기동이 그 파일을 처음부터 다시 돈다. 동시 실행은 `GET_LOCK`(기다림)이 막는다.
   */
  async migrate(set: MigrationSet = CONFIG_MIGRATIONS): Promise<string[]> {
    const c = await this.#conn();
    try {
      await assertDurable(c);
      return await runMigrations(this.#migrationDriver(c), set);
    } finally {
      c.release();
    }
  }

  #migrationDriver(c: MyConn): MigrationDriver {
    const flavor = (): MysqlFlavor => this.#flavor ?? 'mysql';
    const raw = async (sql: string): Promise<unknown> => {
      try {
        return (await c.query(sql))[0];
      } catch (e) {
        throw mapMysqlError(e, flavor());
      }
    };
    return {
      dialect: this.dialect,
      withMigrationLock: async (lock, fn) => {
        const name = lockNameFor(this.#cfg.database, `mg.${lock[0].toString(16)}.${lock[1].toString(16)}`);
        // **기다린다** — 진 쪽이 낡은 스키마로 서비스를 시작하면 안 된다(`./pg.ts` 와 같은 계약).
        for (;;) {
          const rows = await raw(`SELECT GET_LOCK(${literal(name)}, ${MIGRATE_LOCK_WAIT_S}) AS got`) as Row[];
          if (String(rows[0]?.['got']) === '1') break;
          log.info('mysql.migrate_lock_wait', { lock: name });
        }
        try {
          return await fn();
        } finally {
          await raw(`SELECT RELEASE_LOCK(${literal(name)})`).catch(() => undefined);
        }
      },
      ensureTable: async (table) => {
        await raw(`CREATE TABLE IF NOT EXISTS ${table} (
          name varchar(255) NOT NULL PRIMARY KEY,
          applied_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`);
      },
      appliedNames: async (table) => new Set((await raw(`SELECT name FROM ${table}`) as Row[]).map((r) => String(r['name']))),
      applyOne: async (table, name, sql) => {
        const stmts = splitStatements(sql);
        for (const [k, s] of stmts.entries()) {
          try {
            await raw(s);
          } catch (e) {
            throw new Error(`마이그레이션 ${name} 의 ${k + 1}/${stmts.length} 번째 문장이 실패했다 — 앞 문장들은 이미 적용됐다`
              + ` (MySQL 의 DDL 은 트랜잭션이 아니다. 파일은 다시 돌려도 안전하게 썼으니 원인을 고치고 다시 띄운다): `
              + `${e instanceof Error ? e.message : String(e)}`);
          }
        }
        await raw(`INSERT INTO ${table} (name) VALUES (${literal(name)})`);
      },
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const p = this.#pool;
    if (p !== undefined) await (await p).end().catch(() => undefined);
  }
}

/** 커밋이 내구적인가 — `innodb_flush_log_at_trx_commit=1`. 아니면 커밋한 리비전 · 리더 토큰이 서버 크래시에 사라질 수 있다. */
async function assertDurable(c: MyConn): Promise<void> {
  const [rows] = await c.query('SELECT @@innodb_flush_log_at_trx_commit AS f');
  const f = String((rows as Row[])[0]?.['f'] ?? '');
  if (f !== '1') {
    throw new Error(`MySQL 의 innodb_flush_log_at_trx_commit 이 ${f} 다 — 1 이어야 커밋이 서버 크래시에도 남는다 (docs/runbook-install.md)`);
  }
}
