/**
 * 저장소 경계 — DSN 스킴이 백엔드를 고르고, 구현이 없는 방언은 기동을 거부한다 (docs/adr-multi-db.md)
 */
import { describe, expect, it } from 'vitest';

import { DIALECTS, dbKindOf } from '../../src/store/db.js';
import { assertSupportedDsn, openDb, UnsupportedDb } from '../../src/store/open.js';

describe('DSN 스킴 → 종류', () => {
  it('넷 중 하나를 고른다', () => {
    expect(dbKindOf('postgres://u@h/db')).toBe('postgres');
    expect(dbKindOf('postgresql://u@h/db')).toBe('postgres');
    expect(dbKindOf('mysql://u@h/db')).toBe('mysql');
    expect(dbKindOf('MariaDB://u@h/db')).toBe('mariadb');
    expect(dbKindOf('sqlite:/var/lib/barycenter/config.db')).toBe('sqlite');
  });

  it('**넷이 아니면 PG 다** — 지금 받는 DSN 이 그대로 PG 로 간다', () => {
    expect(dbKindOf('host=/run/postgresql dbname=bary')).toBe('postgres');
    expect(dbKindOf('socket:/run/postgresql?db=bary')).toBe('postgres');
    expect(dbKindOf('  postgres://u@h/db')).toBe('postgres');
  });

  it('방언 능력은 ADR 의 표와 같다', () => {
    expect(DIALECTS.mysql.returning).toBe(false);
    expect(DIALECTS.sqlite.rowLocks).toBe(false);
    expect(DIALECTS.postgres).toMatchObject({ placeholder: 'dollar', returning: true, skipLocked: true, transactionalDdl: true });
  });
});

describe('openDb', () => {
  it('**구현이 없는 방언은 거부한다** — 스킴만 말하고 DSN(비밀번호)은 싣지 않는다', () => {
    const pw = ['not', 'a', 'secret'].join('-');
    for (const dsn of [`mysql://u:${pw}@h/db`, `mariadb://u:${pw}@h/db`, 'sqlite:/tmp/x.db']) {
      let err: unknown;
      try {
        openDb(dsn, 'BARY_DSN');
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(UnsupportedDb);
      expect(String((err as Error).message)).toContain('BARY_DSN');
      expect(String((err as Error).message)).not.toContain(pw);
    }
    expect(() => assertSupportedDsn('sqlite:/tmp/x.db', 'BARY_ACCOUNTS_DSN')).toThrow(/BARY_ACCOUNTS_DSN 의 스킴이 sqlite:/);
  });

  it('PG DSN 은 PG 구현을 연다 (연결은 첫 쿼리에서 맺는다)', async () => {
    const db = openDb('postgres://u@127.0.0.1:1/none');
    expect(db.dialect.name).toBe('postgres');
    await db.close();
  });
});
