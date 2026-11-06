/**
 * 설정 DB 의 마이그레이션 계열 (docs/adr-multi-db.md 「마이그레이션」). 계정 DB 의 계열은
 * `src/accounts/migrations.ts` 다.
 *
 * PG 파일은 지금 자리 그대로다(`./migrations`). 다른 방언은 `./dialects/<방언>/migrations` 에
 * **같은 이름**으로 둔다 — 지금은 비어 있다(2 · 3 단계가 채운다).
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { MigrationSet } from './db.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 방언 계열의 자리. `series` 는 PG 쪽 디렉터리 이름(`migrations` · `account-migrations`)과 같다. */
export function dialectDirsOf(series: 'migrations' | 'account-migrations'): NonNullable<MigrationSet['dialectDirs']> {
  return {
    sqlite: join(HERE, 'dialects', 'sqlite', series),
    mysql: join(HERE, 'dialects', 'mysql', series),
  };
}

/**
 * 잠금 키는 리더 선출(`'ba' 'ry'`)과도 계정 계열(`'ba' 'ac'`)과도 다르다 (검수 D15) — 근거는
 * `Db.MIGRATE_LOCK` 의 주석.
 */
export const CONFIG_MIGRATIONS: MigrationSet = {
  dir: join(HERE, 'migrations'),
  table: 'schema_migrations',
  lock: [0x62_61, 0x6d_67], // 'ba' 'mg'
  dialectDirs: dialectDirsOf('migrations'),
};
