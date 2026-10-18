/**
 * 계정 DB 의 마이그레이션 계열. 설정 DB(`schema_migrations`)와 기록 테이블·잠금 키가 다르다.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { MigrationSet } from '../store/pg.js';

export const ACCOUNT_MIGRATIONS: MigrationSet = {
  dir: join(dirname(fileURLToPath(import.meta.url)), '..', 'store', 'account-migrations'),
  table: 'account_schema_migrations',
  lock: [0x62_61, 0x61_63], // 'ba' 'ac' — 설정 DB 마이그레이션('mg')·리더 선출과 다른 키
};
