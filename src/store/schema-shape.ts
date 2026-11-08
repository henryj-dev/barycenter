/**
 * 스키마 모양 — 방언이 달라도 같은 스키마인지 잰다 (docs/adr-multi-db.md 「마이그레이션」)
 *
 * 방언마다 마이그레이션 파일을 따로 쓰므로 둘이 갈릴 수 있다. 이름이 같은 파일이 있다는 것
 * (`migrationDirFor`)만으로는 모자란다 — 열 하나를 빠뜨려도 이름은 같다. 그래서 적용한 뒤의
 * **모양**(표 → 열 → 논리 형 · NULL 허용)을 읽어 비교한다.
 *
 * 형은 **논리 형**으로 줄인다. `timestamptz` 와 `DATETIME(6)` 은 이름이 다르지만 같은 것을 담는다.
 * 줄이지 못한 형은 `raw:<이름>` 으로 둔다 — 비교에서 반드시 차이로 보인다(조용히 같다고 하지 않는다).
 *
 * PG · SQLite · MySQL(MariaDB) 의 읽기가 있다. 방언 적합성 시험이
 * 「PG 의 모양 = 그 방언의 모양」 을 단언한다(`tests/dialect/schema-shape-pg.json` 이 PG 의 모양이다).
 */
import type { Database, Queryable } from './db.js';

/**
 * `uuid` · `cidr` · `interval` · `array` 는 PG 에만 원형이 있다. 다른 방언은 그것을 담는 형(대개 텍스트 · JSON)을
 * 이 논리 형으로 **읽어 낼 때** 맞춘다 — 그 대응은 2 · 3 단계의 몫이고, 여기서 미리 `text` 로 뭉개지 않는다.
 */
export type LogicalType = 'text' | 'int' | 'bigint' | 'bool' | 'timestamp' | 'json' | 'bytes' | 'enum' | 'real'
  | 'numeric' | 'uuid' | 'cidr' | 'interval' | 'array' | `raw:${string}`;

export type ColumnShape = { readonly type: LogicalType; readonly nullable: boolean };

/** 표 이름 → 열 이름 → 모양. */
export type SchemaShape = Readonly<Record<string, Readonly<Record<string, ColumnShape>>>>;

const PG_TYPES: Readonly<Record<string, LogicalType>> = {
  'text': 'text',
  'character varying': 'text',
  'character': 'text',
  'smallint': 'int',
  'integer': 'int',
  'bigint': 'bigint',
  'boolean': 'bool',
  'timestamp with time zone': 'timestamp',
  'jsonb': 'json',
  'json': 'json',
  'bytea': 'bytes',
  'USER-DEFINED': 'enum',
  'double precision': 'real',
  'real': 'real',
  'numeric': 'numeric',
  'uuid': 'uuid',
  'cidr': 'cidr',
  'inet': 'cidr',
  'interval': 'interval',
  'ARRAY': 'array',
};

export function pgLogicalType(dataType: string): LogicalType {
  return PG_TYPES[dataType] ?? `raw:${dataType}`;
}

/**
 * 지금 스키마(`current_schema()`)의 표와 열. 기록 표(`*schema_migrations`)는 뺀다 — 실행기의 것이지
 * 스키마의 것이 아니다.
 */
export async function readPgShape(q: Queryable): Promise<SchemaShape> {
  const r = await q.query(
    `SELECT c.table_name, c.column_name, c.data_type, c.is_nullable
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = current_schema() AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name, c.ordinal_position`,
  );
  const out: Record<string, Record<string, ColumnShape>> = {};
  for (const row of r.rows) {
    const table = String(row['table_name']);
    if (table.endsWith('schema_migrations')) continue;
    (out[table] ??= {})[String(row['column_name'])] = {
      type: pgLogicalType(String(row['data_type'])),
      nullable: row['is_nullable'] === 'YES',
    };
  }
  return out;
}

/**
 * SQLite 의 선언 형 → 논리 형. 선언 형은 SQLite 계열 마이그레이션(`dialects/sqlite/migrations/001_init.sql`
 * 머리말)이 정하고, 드라이버(`./sqlite.ts` 의 `decode`)가 같은 표로 JS 값을 맞춘다.
 *
 * `integer` 는 `INTEGER PRIMARY KEY`(rowid 별칭 — PG 의 `bigserial`)에만 쓴다. 그래서 `bigint` 다.
 * PG 의 `integer`(int4)는 SQLite 에서 `int` 로 선언한다.
 */
const SQLITE_TYPES: Readonly<Record<string, LogicalType>> = {
  'text': 'text',
  'int': 'int',
  'integer': 'bigint',
  'bigint': 'bigint',
  'boolean': 'bool',
  'timestamptz': 'timestamp',
  'json_text': 'json',
  'blob': 'bytes',
  'enum_text': 'enum',
  'real': 'real',
  'numeric': 'numeric',
  'uuid': 'uuid',
  'cidr': 'cidr',
  'inet': 'cidr',
  'text_array': 'array',
};

export function sqliteLogicalType(declared: string): LogicalType {
  return SQLITE_TYPES[declared.toLowerCase()] ?? `raw:${declared}`;
}

/**
 * SQLite 의 표와 열. 기록 표(`*schema_migrations`)와 시퀀스 대신의 카운터 표(`bary_sequences` — PG 에는
 * `SEQUENCE` 라 표가 아니다)는 뺀다.
 *
 * **NULL 허용은 선언 그대로 읽는다.** SQLite 는 `INTEGER` 가 아닌 기본 키에 NULL 을 받는다(오래된 버그를
 * 호환으로 남겼다) — 그래서 SQLite 계열은 기본 키에도 `NOT NULL` 을 적고, 이 읽기는 그것을 잰다.
 * `INTEGER PRIMARY KEY` 만은 NULL 을 넣으면 새 rowid 가 되므로 NULL 일 수 없다.
 */
export async function readSqliteShape(q: Queryable): Promise<SchemaShape> {
  const tables = await q.query(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  );
  const out: Record<string, Record<string, ColumnShape>> = {};
  for (const t of tables.rows) {
    const table = String(t['name']);
    if (table.endsWith('schema_migrations') || table === 'bary_sequences') continue;
    const cols = await q.query(`SELECT name, type, "notnull" AS nn, pk FROM pragma_table_info($1) ORDER BY cid`, [table]);
    const shape: Record<string, ColumnShape> = {};
    for (const c of cols.rows) {
      const declared = String(c['type']);
      const rowid = Number(c['pk']) > 0 && declared.toLowerCase() === 'integer';
      shape[String(c['name'])] = { type: sqliteLogicalType(declared), nullable: Number(c['nn']) === 0 && !rowid };
    }
    out[table] = shape;
  }
  return out;
}

/**
 * MySQL · MariaDB 의 열 형 → 논리 형. MySQL 계열 마이그레이션(`dialects/mysql/migrations/001_init.sql` 머리말)이
 * 정한 대응을 읽어 낸다.
 *
 * - `char(36)` 은 uuid 에만 쓴다. `tinyint(1)` 은 `BOOLEAN` 이다.
 * - JSON 을 담는 열(MySQL `json` · MariaDB 는 `longtext` 별칭)은 **열 주석**이 논리 형을 말한다 — `bary:json` · `bary:array`
 *   (PG 의 `jsonb` · `text[]`). MariaDB 는 `JSON` 을 `longtext` 로 보이므로 주석 없이는 텍스트와 가를 수 없다.
 */
export function mysqlLogicalType(dataType: string, columnType: string, comment: string): LogicalType {
  const c = /^bary:([a-z]+)$/.exec(comment.trim())?.[1];
  if (c === 'json' || c === 'array' || c === 'uuid') return c;
  const dt = dataType.toLowerCase();
  const ct = columnType.toLowerCase();
  if (dt === 'char' && ct === 'char(36)') return 'uuid';
  if (dt === 'tinyint' && /^tinyint\(1\)/.test(ct)) return 'bool';
  return MYSQL_TYPES[dt] ?? `raw:${columnType}`;
}

const MYSQL_TYPES: Readonly<Record<string, LogicalType>> = {
  'varchar': 'text',
  'char': 'text',
  'text': 'text',
  'mediumtext': 'text',
  'longtext': 'text',
  'smallint': 'int',
  'int': 'int',
  'bigint': 'bigint',
  'datetime': 'timestamp',
  'json': 'json',
  'blob': 'bytes',
  'mediumblob': 'bytes',
  'longblob': 'bytes',
  'varbinary': 'bytes',
  'enum': 'enum',
  'double': 'real',
  'float': 'real',
  'decimal': 'numeric',
};

/**
 * MySQL 의 표와 열(지금 DB — `DATABASE()`). 기록 표 · 카운터 표(`bary_sequences`)는 뺀다. **생성 열은 뺀다** — PG 의
 * 부분 유일 색인(`WHERE …`)을 MySQL 은 생성 열 + 유일 색인으로 옮겼다(그 열은 스키마의 열이 아니라 색인의 손발이다).
 */
export async function readMysqlShape(q: Queryable): Promise<SchemaShape> {
  const r = await q.query(
    `SELECT c.TABLE_NAME AS table_name, c.COLUMN_NAME AS column_name, c.DATA_TYPE AS data_type,
            c.COLUMN_TYPE AS column_type, c.IS_NULLABLE AS is_nullable, c.COLUMN_COMMENT AS column_comment,
            c.EXTRA AS extra
       FROM information_schema.COLUMNS c
       JOIN information_schema.TABLES t
         ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
      WHERE c.TABLE_SCHEMA = DATABASE() AND t.TABLE_TYPE = 'BASE TABLE'
      ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`,
  );
  const out: Record<string, Record<string, ColumnShape>> = {};
  for (const row of r.rows) {
    const table = String(row['table_name']);
    if (table.endsWith('schema_migrations') || table === 'bary_sequences') continue;
    if (/(VIRTUAL|STORED|PERSISTENT) GENERATED/i.test(String(row['extra'] ?? ''))) continue;
    (out[table] ??= {})[String(row['column_name'])] = {
      type: mysqlLogicalType(String(row['data_type']), String(row['column_type']), String(row['column_comment'] ?? '')),
      nullable: row['is_nullable'] === 'YES',
    };
  }
  return out;
}

/** 저장소의 스키마 모양. */
export async function readSchemaShape(db: Database): Promise<SchemaShape> {
  switch (db.dialect.name) {
    case 'postgres': return readPgShape(db);
    case 'sqlite': return readSqliteShape(db);
    case 'mysql': return readMysqlShape(db);
  }
}

/** 두 모양의 차이. 같으면 빈 배열. 사람이 읽는 문장이다. */
export function compareShapes(want: SchemaShape, have: SchemaShape): string[] {
  const diff: string[] = [];
  for (const table of Object.keys(want).sort()) {
    const w = want[table] ?? {};
    const h = have[table];
    if (h === undefined) {
      diff.push(`표 ${table} 가 없다`);
      continue;
    }
    for (const col of Object.keys(w).sort()) {
      const wc = w[col];
      const hc = h[col];
      if (wc === undefined) continue;
      if (hc === undefined) diff.push(`${table}.${col} 열이 없다`);
      else if (hc.type !== wc.type) diff.push(`${table}.${col} 형이 다르다: ${wc.type} ≠ ${hc.type}`);
      else if (hc.nullable !== wc.nullable) diff.push(`${table}.${col} NULL 허용이 다르다: ${wc.nullable} ≠ ${hc.nullable}`);
    }
    for (const col of Object.keys(h).sort()) {
      if (w[col] === undefined) diff.push(`${table}.${col} 열이 더 있다`);
    }
  }
  for (const table of Object.keys(have).sort()) {
    if (want[table] === undefined) diff.push(`표 ${table} 가 더 있다`);
  }
  return diff;
}
