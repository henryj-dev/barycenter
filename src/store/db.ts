/**
 * 저장소 경계 — 연결 · 트랜잭션 · 잠금 (docs/adr-multi-db.md)
 *
 * **SQL 을 추상하지 않는다.** 방언의 차이(`RETURNING` 유무 · upsert 의 대상 키 · 행 잠금 유무)는
 * 도우미로 감추면 쿼리 수와 잠금의 뜻이 바뀐다. 그래서 이 경계는 연결 · 트랜잭션 · 시뮬레이션
 * 롤백 · 마이그레이션 · 닫기만 감싸고, 방언별 SQL 은 저장소 함수 안에 나란히 둔다(ADR 의 (b)).
 *
 * 저장소 함수는 `db.dialect.name` 으로 자기 문장을 고른다. 구현은 PostgreSQL(`./pg.ts`) · SQLite(`./sqlite.ts`) ·
 * MySQL/MariaDB(`./mysql.ts`)다. 드라이버 패키지는 각자의 구현 파일에만 있다.
 */

export type Row = Record<string, unknown>;

export interface Queryable {
  /**
   * 이 연결의 방언. `Queryable` 만 받는 저장소 함수(트랜잭션 안의 연결)가 자기 문장을 고르는 근거다
   * (ADR 「방언을 넘기는 방법」). 실제 구현(`Database` 와 그 `tx` · `dryRun` 이 주는 연결)은 **반드시**
   * 채운다. 비어 있으면 PG 로 본다 — 시험의 가짜 연결(`{ query }`)이 그 모양이다.
   */
  readonly dialect?: Dialect;
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>;
}

/** 방언. MariaDB 는 MySQL 방언의 한 종류다(`kind` 가 가른다). */
export type DialectName = 'postgres' | 'mysql' | 'sqlite';

/** DSN 스킴이 고르는 백엔드 종류. */
export type DbKind = 'postgres' | 'mysql' | 'mariadb' | 'sqlite';

/**
 * 방언의 능력. **SQL 을 만들지 않는다** — 저장소 함수와 마이그레이션 실행기가 이 값을 보고
 * 자기 길을 고른다. 값의 근거는 ADR 의 「방언 차이」 표다.
 */
export type Dialect = {
  readonly name: DialectName;
  /** 자리 표시: `$1` 또는 `?`. */
  readonly placeholder: 'dollar' | 'question';
  /** `INSERT/UPDATE … RETURNING`. 없으면 같은 트랜잭션 안에서 다시 읽는다. */
  readonly returning: boolean;
  /** `SELECT … FOR UPDATE`. 없으면 쓰기 트랜잭션이 DB 전체를 잠근다(SQLite 의 `BEGIN IMMEDIATE`). */
  readonly rowLocks: boolean;
  /** `FOR UPDATE SKIP LOCKED`. */
  readonly skipLocked: boolean;
  /** DDL 이 트랜잭션 안에서 되돌려지는가. 아니면 마이그레이션이 반쯤 적용될 수 있다. */
  readonly transactionalDdl: boolean;
};

export const DIALECTS: Readonly<Record<DialectName, Dialect>> = {
  postgres: { name: 'postgres', placeholder: 'dollar', returning: true, rowLocks: true, skipLocked: true, transactionalDdl: true },
  mysql: { name: 'mysql', placeholder: 'question', returning: false, rowLocks: true, skipLocked: true, transactionalDdl: false },
  // SQLite 는 `?NNN` 을 안다. 드라이버(`./sqlite.ts`)가 `$n` 을 `?n` 으로 옮긴다 — 번호가 곧 인자 자리라 뜻이 같다.
  sqlite: { name: 'sqlite', placeholder: 'dollar', returning: true, rowLocks: false, skipLocked: false, transactionalDdl: true },
};

/** 연결의 방언. 비어 있으면 PG(시험의 가짜 연결). */
export function dialectOf(q: Queryable): Dialect {
  return q.dialect ?? DIALECTS.postgres;
}

/**
 * 방언마다 나란히 둔 문장(또는 값). 기본 갈래를 두지 않는다 — 방언을 더하면 이 형에 그 방언을 더하고,
 * 타입 검사가 문장을 빠뜨린 자리를 모두 가리킨다(3단계가 `mysql` 을 이렇게 더했다).
 *
 * PG 문장이 SQLite · MySQL 에서 **그대로** 뜻이 같은 자리(자리 표시 · `now()` 는 드라이버가 맞춘다)는 이것을 쓰지
 * 않고 문장 하나를 둔다. 이것을 쓰는 자리는 문법이나 뜻이 갈리는 자리다 — `FOR UPDATE` · `::형` ·
 * `= ANY($n)` · `jsonb` 연산 · `interval` · 시퀀스.
 */
export type ByDialect<T> = { readonly postgres: T; readonly sqlite: T; readonly mysql: T };

export function byDialect<T>(q: Queryable, m: ByDialect<T>): T {
  const d = dialectOf(q).name;
  switch (d) {
    case 'postgres': return m.postgres;
    case 'sqlite': return m.sqlite;
    case 'mysql': return m.mysql;
  }
}

/**
 * DSN 의 스킴으로 종류를 고른다.
 *
 * **넷 중 하나가 아니면 PG 다.** 지금 받는 DSN — `postgres://` 뿐 아니라 키워드 형식
 * (`host=… dbname=…`)과 `socket:` — 이 그대로 PG 로 가야 한다. 별도 종류 변수(`BARY_DB_KIND`)는
 * 두지 않는다: DSN 과 어긋나는 반쪽 설정을 만들 수 없게 한다.
 */
export function dbKindOf(dsn: string): DbKind {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(dsn.trim());
  switch (m?.[1]?.toLowerCase()) {
    case 'mysql': return 'mysql';
    case 'mariadb': return 'mariadb';
    case 'sqlite': return 'sqlite';
    default: return 'postgres';
  }
}

/**
 * 마이그레이션 계열. 설정 DB 가 기본이고, 계정 DB(`account-migrations`)가 둘째 계열이다.
 *
 * **계열마다 기록 테이블과 잠금 키가 다르다.** 같은 PG 서버의 다른 DB 에 두는 것이 권장이지만
 * 같은 DB 에 둬도 섞이지 않아야 한다 — 기록 테이블을 나누지 않으면 한쪽의 `001_…` 이
 * 다른 쪽의 `001_…` 을 「이미 했다」로 건너뛴다.
 *
 * `dir` 은 **PG 의 파일**이다(지금 자리 그대로). 다른 방언은 `dialectDirs` 에 같은 이름의 파일을 둔다.
 */
export type MigrationSet = {
  dir: string;
  table: string;
  lock: readonly [number, number];
  dialectDirs?: Partial<Record<Exclude<DialectName, 'postgres'>, string>>;
};

/**
 * 저장소 하나. 설정 DB 와 계정 DB 가 각각 하나씩 연다.
 */
export interface Database extends Queryable {
  readonly dialect: Dialect;
  /** 트랜잭션. 콜백이 던지면 롤백한다. */
  tx<T>(fn: (c: Queryable) => Promise<T>): Promise<T>;
  /** 콜백 결과와 무관하게 **항상 롤백**한다. plan 의 시뮬레이션 전용. */
  dryRun<T>(fn: (c: Queryable) => Promise<T>): Promise<T>;
  /** 스키마를 최신으로. 한 번에 하나만 돈다. 적용한 파일 이름을 돌려준다. */
  migrate(set?: MigrationSet): Promise<string[]>;
  close(): Promise<void>;
}

/**
 * 리더 잠금 (DESIGN.md §3.5). **잠금이 정본이다.**
 *
 * 한 번 시도한다 — 기다리지 않는다(스탠바이는 읽기로 서비스하면서 대기한다). 쥐면 그 뒤에
 * 엄격 단조 토큰을 발급한 세션을 돌려준다. 세션이 끊기면 `onLost` 가 불린다 — 그 순간부터
 * 리더가 아니다.
 */
export interface LeaderLock {
  tryAcquire(holder: string): Promise<LeaderAttempt>;
}

export type LeaderAttempt =
  | { readonly ok: true; readonly session: LeaderSession }
  | { readonly ok: false; readonly reason: string };

export interface LeaderSession {
  /** 엄격 단조 decimal string. */
  readonly token: string;
  /** ISO 시각. */
  readonly since: string;
  /**
   * 세션이 끊기면 부른다. 사유는 사람이 읽는다.
   *
   * `error` 는 연결 오류(사유를 덮는다), `end` 는 연결이 닫힌 것(앞선 사유가 있으면 그것을 둔다).
   * 둘 다 올 수 있다 — 오류 뒤에 닫힘이 온다.
   */
  onLost(fn: (kind: 'error' | 'end', reason: string) => void): void;
  /** 물러난다. 깨끗이 물러났다는 기록을 남기고 세션을 닫는다. 던지지 않는다. */
  release(): Promise<void>;
}
