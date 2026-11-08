/**
 * 방언 적합성 시험이 재는 DB 를 고른다 — `BARY_TEST_DB=postgres|mysql|mariadb|sqlite` (docs/adr-multi-db.md 「완료 조건」)
 *
 * 같은 시험 묶음을 방언마다 돈다. 방언 하나는 이 묶음이 그 DB 로 CI 에서 통과해야 `openDb` 의 거부를 푼다.
 * 넷 모두 켠다. MariaDB 는 MySQL 방언이다(`name` 은 종류, 방언은 `dialect`).
 *
 * **모르는 값은 던진다.** 오타(`BARY_TEST_DB=sqllite`)로 아무것도 안 재고 초록이 되면 안 된다.
 * 아직 없는 방언도 던진다 — 「건너뜀」 은 CI 에서 초록으로 보인다.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dockerAvailable, pgFor, startPg, stopPg } from '../store/pg-fixture.js';

export type TestDbName = 'postgres' | 'mysql' | 'mariadb' | 'sqlite';

export type TestDb = {
  readonly name: TestDbName;
  /** 방언 — MariaDB 는 `mysql`. */
  readonly dialect: 'postgres' | 'mysql' | 'sqlite';
  /** 이 DB 로 가는 DSN. 스킴이 `openDb` 의 구현을 고른다. */
  readonly dsn: string;
  stop(): void;
};

export function testDbName(env: NodeJS.ProcessEnv = process.env): TestDbName {
  const v = (env['BARY_TEST_DB'] ?? 'postgres').trim();
  if (v === 'postgres' || v === 'mysql' || v === 'mariadb' || v === 'sqlite') return v;
  throw new Error(`BARY_TEST_DB 는 postgres | mysql | mariadb | sqlite 중 하나다: ${JSON.stringify(v)}`);
}

export function startTestDb(id: string): TestDb {
  const name = testDbName();
  switch (name) {
    case 'postgres': {
      if (!dockerAvailable()) throw new Error('도커가 없다 — 방언 적합성 시험은 실물 DB 를 쓴다');
      const pg = pgFor(`dialect-${id}`);
      startPg(pg);
      return { name, dialect: 'postgres', dsn: pg.dsn, stop: () => stopPg(pg) };
    }
    case 'sqlite': {
      const dir = mkdtempSync(join(tmpdir(), `bary-dialect-${id}-`));
      return { name, dialect: 'sqlite', dsn: `sqlite:${join(dir, 'bary.db')}`, stop: () => rmSync(dir, { recursive: true, force: true }) };
    }
    case 'mysql':
    case 'mariadb': {
      // 저장소 묶음과 같은 서버 컨테이너(`pg-fixture` 의 `pgFor`) — 이 시험의 DB 하나만 만들고 지운다.
      if (!dockerAvailable()) throw new Error('도커가 없다 — 방언 적합성 시험은 실물 DB 를 쓴다');
      const h = pgFor(`dialect-${id}`);
      startPg(h);
      return { name, dialect: 'mysql', dsn: h.dsn, stop: () => stopPg(h) };
    }
  }
}
