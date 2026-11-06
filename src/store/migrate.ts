/**
 * 마이그레이션 실행기 — 계열 × 방언 (docs/adr-multi-db.md 「마이그레이션」)
 *
 * 순서와 규칙은 방언과 무관하다: 계열 잠금을 **기다려서** 쥐고, 기록 표를 만들고, 아직 안 한 파일을
 * 이름 순으로 하나씩 적용하고 기록한다. 방언마다 다른 것은 손발(`MigrationDriver`)이다 —
 * 잠금의 종류, 기록 표의 DDL, 파일 하나가 한 트랜잭션인가(MySQL 의 DDL 은 아니다).
 *
 * **PG 계열 파일은 지금 자리 그대로다**(`MigrationSet.dir`). 다른 방언은 `dialectDirs` 에 **같은
 * 이름**의 파일을 둔다 — 이름이 곧 버전이다. 이름이 PG 계열과 다르면 적용 전에 거부한다:
 * 방언 하나만 마이그레이션을 더하고 다른 방언을 잊으면 두 DB 의 스키마가 갈린다.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Dialect, MigrationSet } from './db.js';

/** 방언의 손발. 실행기가 순서를 정하고, 이것이 문장을 낸다. */
export interface MigrationDriver {
  readonly dialect: Dialect;
  /** 계열 잠금을 **기다려서** 쥔 채 `fn` 을 돈다. 끝나면(던져도) 놓는다. */
  withMigrationLock<T>(lock: MigrationSet['lock'], fn: () => Promise<T>): Promise<T>;
  ensureTable(table: string): Promise<void>;
  appliedNames(table: string): Promise<Set<string>>;
  /** 파일 하나를 적용하고 기록한다. 트랜잭션 DDL 이 되는 방언은 둘을 한 트랜잭션으로. */
  applyOne(table: string, name: string, sql: string): Promise<void>;
}

const sqlFiles = (dir: string): string[] => readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

/** 이 방언이 읽을 디렉터리. 다른 방언의 계열이 PG 계열과 이름이 다르면 던진다. */
export function migrationDirFor(set: MigrationSet, dialect: Dialect): string {
  if (dialect.name === 'postgres') return set.dir;
  const dir = set.dialectDirs?.[dialect.name];
  if (dir === undefined) throw new Error(`마이그레이션 계열 ${set.table} 에 ${dialect.name} 파일 자리가 없다`);
  const want = sqlFiles(set.dir);
  const have = new Set(sqlFiles(dir));
  const missing = want.filter((n) => !have.has(n));
  const extra = [...have].filter((n) => !want.includes(n));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`마이그레이션 계열 ${set.table} 의 ${dialect.name} 파일이 PG 계열과 다르다`
      + (missing.length > 0 ? ` — 빠진 것: ${missing.join(', ')}` : '')
      + (extra.length > 0 ? ` — PG 에 없는 것: ${extra.join(', ')}` : ''));
  }
  return dir;
}

/**
 * 스키마를 최신으로. **한 번에 하나만 돈다** (검수 D15 — 근거는 `Db.migrate` 의 주석).
 *
 * 마이그레이션 하나가 한 트랜잭션인 것은 **부분 적용**을 막는다. 동시 실행은 계열 잠금이 막는다.
 */
export async function runMigrations(d: MigrationDriver, set: MigrationSet): Promise<string[]> {
  if (!/^[a-z_]+$/.test(set.table)) throw new Error(`마이그레이션 기록 테이블 이름이 이상하다: ${set.table}`);
  return d.withMigrationLock(set.lock, async () => {
    await d.ensureTable(set.table);
    const done = await d.appliedNames(set.table);
    const dir = migrationDirFor(set, d.dialect);
    const applied: string[] = [];
    for (const name of sqlFiles(dir)) {
      if (done.has(name)) continue;
      await d.applyOne(set.table, name, readFileSync(join(dir, name), 'utf8'));
      applied.push(name);
    }
    return applied;
  });
}
