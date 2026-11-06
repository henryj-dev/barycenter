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

/** 이 빌드가 열 수 있는 종류. */
export const SUPPORTED_DB_KINDS: readonly DbKind[] = ['postgres'];

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

export function openDb(dsn: string, label = 'DSN'): Database {
  const kind = assertSupportedDsn(dsn, label);
  switch (kind) {
    case 'postgres': return new Db(dsn);
    default: throw new UnsupportedDb(kind, label);
  }
}

/** 리더 잠금. 설정 DB 의 DSN 으로 연다 — 선출은 설정 DB 를 공유하는 인스턴스 사이의 일이다. */
export function openLeaderLock(dsn: string, label = 'DSN'): LeaderLock {
  const kind = assertSupportedDsn(dsn, label);
  switch (kind) {
    case 'postgres': return new PgLeaderLock(dsn);
    default: throw new UnsupportedDb(kind, label);
  }
}
