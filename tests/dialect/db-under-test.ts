/**
 * 방언 적합성 시험이 재는 DB 를 고른다 — `BARY_TEST_DB=postgres|mysql|sqlite` (docs/adr-multi-db.md 「완료 조건」)
 *
 * 같은 시험 묶음을 방언마다 돈다. 방언 하나는 이 묶음이 그 DB 로 CI 에서 통과해야 `openDb` 의 거부를 푼다.
 * postgres · sqlite 를 켠다. 3단계가 mysql 의 `start` 를 채운다.
 *
 * **모르는 값은 던진다.** 오타(`BARY_TEST_DB=sqllite`)로 아무것도 안 재고 초록이 되면 안 된다.
 * 아직 없는 방언도 던진다 — 「건너뜀」 은 CI 에서 초록으로 보인다.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dockerAvailable, pgFor, startPg, stopPg } from '../store/pg-fixture.js';

export type TestDbName = 'postgres' | 'mysql' | 'sqlite';

export type TestDb = {
  readonly name: TestDbName;
  /** 이 DB 로 가는 DSN. 스킴이 `openDb` 의 구현을 고른다. */
  readonly dsn: string;
  stop(): void;
};

export function testDbName(env: NodeJS.ProcessEnv = process.env): TestDbName {
  const v = (env['BARY_TEST_DB'] ?? 'postgres').trim();
  if (v === 'postgres' || v === 'mysql' || v === 'sqlite') return v;
  throw new Error(`BARY_TEST_DB 는 postgres | mysql | sqlite 중 하나다: ${JSON.stringify(v)}`);
}

export function startTestDb(id: string): TestDb {
  const name = testDbName();
  switch (name) {
    case 'postgres': {
      if (!dockerAvailable()) throw new Error('도커가 없다 — 방언 적합성 시험은 실물 DB 를 쓴다');
      const pg = pgFor(`dialect-${id}`);
      startPg(pg);
      return { name, dsn: pg.dsn, stop: () => stopPg(pg) };
    }
    case 'sqlite': {
      const dir = mkdtempSync(join(tmpdir(), `bary-dialect-${id}-`));
      return { name, dsn: `sqlite:${join(dir, 'bary.db')}`, stop: () => rmSync(dir, { recursive: true, force: true }) };
    }
    case 'mysql':
      throw new Error(`BARY_TEST_DB=${name} — 이 방언의 시험 DB 는 아직 없다 (ADR-MULTI-DB 3단계)`);
  }
}
