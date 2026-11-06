/**
 * 마이그레이션 실행기 — 계열 × 방언 (docs/adr-multi-db.md 「마이그레이션」)
 *
 * 실물 PG 의 잠금 · 트랜잭션은 `tests/store/audit-migrate-lock.test.ts` 와 방언 적합성 시험이 잰다.
 * 여기는 방언과 무관한 순서 — 잠금 안에서 돈다 · 한 파일씩 · 이름 순 · 한 것은 건너뛴다 · 방언 계열은
 * PG 계열과 이름이 같아야 한다 — 를 손발을 갈아 끼워 잰다.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DIALECTS, type Dialect, type MigrationSet } from '../../src/store/db.js';
import { migrationDirFor, runMigrations, type MigrationDriver } from '../../src/store/migrate.js';
import { compareShapes, pgLogicalType } from '../../src/store/schema-shape.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function series(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'bary-mig-'));
  dirs.push(dir);
  for (const [n, sql] of Object.entries(files)) writeFileSync(join(dir, n), sql);
  return dir;
}

function fake(dialect: Dialect, done: string[] = []): MigrationDriver & { log: string[] } {
  const log: string[] = [];
  let held = false;
  return {
    dialect,
    log,
    async withMigrationLock(lock, fn) {
      log.push(`lock ${lock.join(',')}`);
      held = true;
      try {
        return await fn();
      } finally {
        held = false;
        log.push('unlock');
      }
    },
    async ensureTable(t) { expect(held).toBe(true); log.push(`ensure ${t}`); },
    async appliedNames() { return new Set(done); },
    async applyOne(t, name, sql) {
      expect(held).toBe(true);
      if (sql.includes('BOOM')) throw new Error('깨졌다');
      log.push(`apply ${t} ${name}`);
    },
  };
}

describe('runMigrations', () => {
  it('**잠금 안에서** 이름 순으로 한 파일씩 적용하고, 한 것은 건너뛴다', async () => {
    const dir = series({ '002_b.sql': 'b', '001_a.sql': 'a', '003_c.sql': 'c', 'README': 'x' });
    const d = fake(DIALECTS.postgres, ['002_b.sql']);
    const set: MigrationSet = { dir, table: 'schema_migrations', lock: [1, 2] };
    expect(await runMigrations(d, set)).toEqual(['001_a.sql', '003_c.sql']);
    expect(d.log).toEqual(['lock 1,2', 'ensure schema_migrations',
      'apply schema_migrations 001_a.sql', 'apply schema_migrations 003_c.sql', 'unlock']);
  });

  it('깨지면 거기서 멈추고 **잠금을 놓는다**', async () => {
    const dir = series({ '001_a.sql': 'a', '002_b.sql': 'BOOM', '003_c.sql': 'c' });
    const d = fake(DIALECTS.postgres);
    await expect(runMigrations(d, { dir, table: 't', lock: [1, 2] })).rejects.toThrow('깨졌다');
    expect(d.log).toEqual(['lock 1,2', 'ensure t', 'apply t 001_a.sql', 'unlock']);
  });

  it('기록 표 이름이 이상하면 잠금 전에 거부한다', async () => {
    const d = fake(DIALECTS.postgres);
    await expect(runMigrations(d, { dir: series({}), table: 'x; DROP', lock: [1, 2] })).rejects.toThrow(/이상하다/);
    expect(d.log).toEqual([]);
  });
});

describe('방언 계열', () => {
  it('**PG 계열과 이름이 다르면 적용 전에 거부한다** — 방언 하나만 마이그레이션을 더한 경우', async () => {
    const pg = series({ '001_a.sql': 'a', '002_b.sql': 'b' });
    const lite = series({ '001_a.sql': 'a', '009_x.sql': 'x' });
    const set: MigrationSet = { dir: pg, table: 't', lock: [1, 2], dialectDirs: { sqlite: lite } };
    expect(() => migrationDirFor(set, DIALECTS.sqlite)).toThrow(/빠진 것: 002_b\.sql — PG 에 없는 것: 009_x\.sql/);
    const d = fake(DIALECTS.sqlite);
    await expect(runMigrations(d, set)).rejects.toThrow(/PG 계열과 다르다/);
    expect(d.log).not.toContain('apply t 001_a.sql');
  });

  it('자리가 없는 방언은 거부한다', () => {
    expect(() => migrationDirFor({ dir: series({}), table: 't', lock: [1, 2] }, DIALECTS.mysql)).toThrow(/mysql 파일 자리가 없다/);
  });

  it('이름이 같으면 그 방언의 파일을 읽는다', async () => {
    const pg = series({ '001_a.sql': 'pg' });
    const lite = series({ '001_a.sql': 'lite' });
    const set: MigrationSet = { dir: pg, table: 't', lock: [1, 2], dialectDirs: { sqlite: lite } };
    expect(migrationDirFor(set, DIALECTS.sqlite)).toBe(lite);
    expect(migrationDirFor(set, DIALECTS.postgres)).toBe(pg);
    expect(await runMigrations(fake(DIALECTS.sqlite), set)).toEqual(['001_a.sql']);
  });

  it('저장소의 방언 자리는 비어 있다 — 2 · 3 단계가 채운다', async () => {
    const { CONFIG_MIGRATIONS } = await import('../../src/store/migration-sets.js');
    const { ACCOUNT_MIGRATIONS } = await import('../../src/accounts/migrations.js');
    for (const set of [CONFIG_MIGRATIONS, ACCOUNT_MIGRATIONS]) {
      for (const dialect of [DIALECTS.sqlite, DIALECTS.mysql]) {
        expect(set.dialectDirs?.[dialect.name as 'sqlite' | 'mysql']).toBeDefined();
        expect(() => migrationDirFor(set, dialect)).toThrow(/빠진 것: 001_/);
      }
    }
  });
});

describe('스키마 모양', () => {
  it('논리 형으로 줄이고, 못 줄인 형은 차이로 보인다', () => {
    expect(pgLogicalType('timestamp with time zone')).toBe('timestamp');
    expect(pgLogicalType('jsonb')).toBe('json');
    expect(pgLogicalType('uuid')).toBe('uuid');
    expect(pgLogicalType('tsvector')).toBe('raw:tsvector');
  });

  it('**빠진 표 · 빠진 열 · 형 · NULL 허용 · 더 있는 것** 을 모두 말한다', () => {
    const want = {
      a: { id: { type: 'bigint', nullable: false }, note: { type: 'text', nullable: true } },
      b: { id: { type: 'int', nullable: false } },
    } as const;
    const have = {
      a: { id: { type: 'int', nullable: false }, note: { type: 'text', nullable: false }, extra: { type: 'text', nullable: true } },
      c: { id: { type: 'int', nullable: false } },
    } as const;
    expect(compareShapes(want, have)).toEqual([
      'a.id 형이 다르다: bigint ≠ int',
      'a.note NULL 허용이 다르다: true ≠ false',
      'a.extra 열이 더 있다',
      '표 b 가 없다',
      '표 c 가 더 있다',
    ]);
    expect(compareShapes(want, want)).toEqual([]);
  });
});
