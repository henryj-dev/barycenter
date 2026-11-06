/**
 * DSN 으로 저장소를 연다 (docs/adr-multi-db.md 「설정」).
 *
 * 설정 DB(`BARY_DSN`)와 계정 DB(`BARY_ACCOUNTS_DSN`)가 **각자** 이것을 부른다 — 백엔드를 따로 고른다.
 *
 * **구현이 없는 방언은 기동을 거부한다.** 조용히 PG 로 시도하면 `mysql://…` 이 PG 드라이버의
 * 엉뚱한 연결 오류로 보이고, 운영자는 원인을 DB 서버에서 찾는다. 방언의 거부는 그 방언이
 * ADR 의 완료 조건(같은 불변식 · 저장소 시험 묶음의 CI 통과)을 채운 단계에서 푼다.
 *
 * 오류에 DSN 을 싣지 않는다 — 비밀번호가 들어 있다. 스킴만 말한다.
 */
import { dbKindOf, type Database, type DbKind, type LeaderLock } from './db.js';
import { Db } from './pg.js';
import { PgLeaderLock } from './pg-leader.js';
import { SqliteDb } from './sqlite.js';
import { SqliteLeaderLock } from './sqlite-leader.js';

/** 이 빌드가 데몬에서 열 수 있는 종류 — ADR 의 완료 조건을 채운 방언(SQLite 는 2단계, 2026-11-06). */
export const SUPPORTED_DB_KINDS: readonly DbKind[] = ['postgres', 'sqlite'];

/**
 * 구현이 있는 종류. 완료 조건(저장소 시험 묶음 전체)을 채우기 전의 방언은 여기만 있고 `SUPPORTED_DB_KINDS` 에는
 * 없다 — 데몬은 열지 않고 시험(`BARY_TEST_DB`)만 `openDbForTest` 로 연다. 지금은 둘이 같다(3단계 MySQL 이 이 자리를 쓴다).
 */
export const IMPLEMENTED_DB_KINDS: readonly DbKind[] = ['postgres', 'sqlite'];

export class UnsupportedDb extends Error {
  constructor(readonly kind: DbKind, label: string) {
    super(`${label} 의 스킴이 ${kind}: 다 — 이 빌드는 아직 그 DB 를 지원하지 않는다`
      + ` (지원: ${SUPPORTED_DB_KINDS.join(', ')} · docs/adr-multi-db.md 「단계」)`);
    this.name = 'UnsupportedDb';
  }
}

/** 지원하지 않는 종류면 던진다. 연결을 만들지 않는다 — 기동 검사가 먼저 부른다. */
export function assertSupportedDsn(dsn: string, label = 'DSN'): DbKind {
  const kind = dbKindOf(dsn);
  if (!SUPPORTED_DB_KINDS.includes(kind)) throw new UnsupportedDb(kind, label);
  return kind;
}

function open(kind: DbKind, dsn: string, label: string): Database {
  switch (kind) {
    case 'postgres': return new Db(dsn);
    case 'sqlite': return new SqliteDb(dsn, label);
    case 'mysql':
    case 'mariadb':
      throw new UnsupportedDb(kind, label);
  }
}

function openLock(kind: DbKind, dsn: string, label: string): LeaderLock {
  switch (kind) {
    case 'postgres': return new PgLeaderLock(dsn);
    case 'sqlite': return new SqliteLeaderLock(dsn, label);
    case 'mysql':
    case 'mariadb':
      throw new UnsupportedDb(kind, label);
  }
}

export function openDb(dsn: string, label = 'DSN'): Database {
  return open(assertSupportedDsn(dsn, label), dsn, label);
}

/** 리더 잠금. 설정 DB 의 DSN 으로 연다 — 선출은 설정 DB 를 공유하는 인스턴스 사이의 일이다. */
export function openLeaderLock(dsn: string, label = 'DSN'): LeaderLock {
  return openLock(assertSupportedDsn(dsn, label), dsn, label);
}

const assertImplemented = (dsn: string, label: string): DbKind => {
  const kind = dbKindOf(dsn);
  if (!IMPLEMENTED_DB_KINDS.includes(kind)) throw new UnsupportedDb(kind, label);
  return kind;
};

/** **시험 전용.** 구현은 있으나 완료 조건 전인 방언(`IMPLEMENTED_DB_KINDS`)도 연다. 데몬은 부르지 않는다. */
export function openDbForTest(dsn: string, label = 'BARY_TEST_DB'): Database {
  return open(assertImplemented(dsn, label), dsn, label);
}

/** **시험 전용.** `openDbForTest` 의 리더 잠금. */
export function openLeaderLockForTest(dsn: string, label = 'BARY_TEST_DB'): LeaderLock {
  return openLock(assertImplemented(dsn, label), dsn, label);
}
