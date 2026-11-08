/**
 * 저장소 경계 — DSN 스킴이 백엔드를 고른다. 넷 모두 데몬이 연다(3단계, 2026-11-06) (docs/adr-multi-db.md)
 */
import { describe, expect, it } from 'vitest';

import { DIALECTS, dbKindOf } from '../../src/store/db.js';
import { assertSupportedDsn, openDb, openLeaderLock, SUPPORTED_DB_KINDS } from '../../src/store/open.js';

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
  it('**데몬은 넷 모두 연다** — 완료 조건(dialect · store 묶음이 그 DB 로 통과)을 채운 뒤에 풀었다', () => {
    expect([...SUPPORTED_DB_KINDS].sort()).toEqual(['mariadb', 'mysql', 'postgres', 'sqlite']);
    expect(assertSupportedDsn('sqlite:/tmp/x.db', 'BARY_DSN')).toBe('sqlite');
    expect(assertSupportedDsn('mysql://u@h/db', 'BARY_DSN')).toBe('mysql');
    expect(assertSupportedDsn('mariadb://u@h/db', 'BARY_ACCOUNTS_DSN')).toBe('mariadb');
  });

  it('**mysql: · mariadb: 는 MySQL 구현을 연다** (연결은 첫 쿼리에서 맺는다) — 리더 잠금도', async () => {
    for (const dsn of ['mysql://u@127.0.0.1:1/bary', 'mariadb://u@127.0.0.1:1/bary']) {
      const db = openDb(dsn, 'BARY_DSN');
      expect(db.dialect.name).toBe('mysql');
      expect(db.dialect.transactionalDdl).toBe(false);
      await db.close();
      expect(openLeaderLock(dsn, 'BARY_DSN')).toBeDefined();
    }
  });

  it('잘못된 mysql: DSN 은 무엇이 빠졌는지만 말한다 — DSN(비밀번호)은 싣지 않는다', () => {
    const pw = ['not', 'a', 'secret'].join('-');
    let msg = '';
    try {
      openDb(`mysql://u:${pw}@h:3306/`, 'BARY_DSN');
    } catch (e) {
      msg = String(e);
    }
    expect(msg).toMatch(/BARY_DSN 의 mysql: DSN 에 DB 이름이 없다/);
    expect(msg).not.toContain(pw);
  });

  it('PG DSN 은 PG 구현을 연다 (연결은 첫 쿼리에서 맺는다)', async () => {
    const db = openDb('postgres://u@127.0.0.1:1/none');
    expect(db.dialect.name).toBe('postgres');
    await db.close();
  });
});
