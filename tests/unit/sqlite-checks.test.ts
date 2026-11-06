/**
 * SQLite 배치 검사 · 드라이버의 순수 함수 (docs/adr-multi-db.md 「SQLite」)
 */
import { describe, expect, it } from 'vitest';

import { NETWORK_FS, sqliteDeploymentProblems, type HostProbe } from '../../src/store/sqlite-checks.js';
import { decode, encodeParam, mapSqliteError, rewritePlaceholders } from '../../src/store/sqlite.js';

const probe = (over: Partial<HostProbe> = {}): HostProbe => ({
  platform: 'linux',
  fsType: () => 0xef53, // ext4
  localAddresses: () => new Set(['127.0.0.1', '::1', '10.1.2.3']),
  resolve: async (h) => (h === 'here.example' ? ['10.1.2.3'] : h === 'away.example' ? ['10.9.9.9'] : []),
  ...over,
});

const SQ = 'sqlite:/var/lib/barycenter/bary.db';
const SQA = 'sqlite:/var/lib/barycenter/accounts.db';
const PG = 'postgres://u@db/bary';

describe('SQLite 배치 검사', () => {
  it('PG 만이면 아무것도 보지 않는다', async () => {
    expect(await sqliteDeploymentProblems({ dsn: PG, accountsDsn: PG, cluster: true, regionApis: ['https://away.example'] }, probe())).toEqual([]);
  });

  it('**클러스터 모드는 SQLite 를 거부한다** — 설정 DB 든 계정 DB 든', async () => {
    expect(await sqliteDeploymentProblems({ dsn: SQ, accountsDsn: '', cluster: true }, probe()))
      .toEqual([expect.stringMatching(/BARY_CLUSTER=1 인데 BARY_DSN 가 SQLite/)]);
    expect(await sqliteDeploymentProblems({ dsn: PG, accountsDsn: SQA, cluster: true }, probe()))
      .toEqual([expect.stringMatching(/BARY_ACCOUNTS_DSN 가 SQLite/)]);
  });

  it('**네트워크 파일시스템 위의 파일은 거부한다**(리눅스) — 다른 OS 는 이 검사를 하지 않는다', async () => {
    const nfs = probe({ fsType: () => 0x6969 });
    expect(NETWORK_FS[0x6969]).toBe('nfs');
    expect(await sqliteDeploymentProblems({ dsn: SQ, accountsDsn: '', cluster: false }, nfs))
      .toEqual([expect.stringMatching(/네트워크 파일시스템\(nfs\)/)]);
    expect(await sqliteDeploymentProblems({ dsn: SQ, accountsDsn: '', cluster: false }, { ...nfs, platform: 'darwin' })).toEqual([]);
  });

  it('**전역 화면 + SQLite 계정 DB 는 모든 지역이 이 호스트여야 한다** — 루프백 · 이 호스트의 주소만', async () => {
    const ok = { dsn: SQ, accountsDsn: SQA, cluster: false, regionApis: ['https://127.0.0.1:9443', 'https://here.example', 'https://[::1]:9444'] };
    expect(await sqliteDeploymentProblems(ok, probe())).toEqual([]);
    const bad = { ...ok, regionApis: ['https://here.example', 'https://away.example:443'] };
    expect(await sqliteDeploymentProblems(bad, probe()))
      .toEqual([expect.stringMatching(/지역 API away\.example\(10\.9\.9\.9\)가 이 호스트가 아니다/)]);
  });

  it('계정 DB 만 PG 면 지역이 어디 있어도 된다 — 설정 DB 만 SQLite 인 갈래', async () => {
    expect(await sqliteDeploymentProblems({ dsn: SQ, accountsDsn: PG, cluster: false, regionApis: ['https://away.example'] }, probe())).toEqual([]);
  });

  it('상대 경로 DSN 은 거부한다', async () => {
    await expect(sqliteDeploymentProblems({ dsn: 'sqlite:bary.db', accountsDsn: '', cluster: false }, probe())).rejects.toThrow(/절대 경로/);
  });
});

describe('SQLite 드라이버의 순수 함수', () => {
  it('`$n` → `?n` — 문자열 · 따옴표 이름 · 주석은 그대로', () => {
    expect(rewritePlaceholders(`UPDATE t SET a = $2 WHERE b = $1 AND c = 'it''s $3' -- $9`))
      .toBe(`UPDATE t SET a = ?2 WHERE b = ?1 AND c = 'it''s $3' -- $9`);
  });

  it('인자와 결과의 모양 — PG 가 주는 JS 값과 같다', () => {
    expect([true, false, new Date('2026-01-01T00:00:00.000Z'), ['a'], { k: 1 }, undefined].map(encodeParam))
      .toEqual([1, 0, '2026-01-01T00:00:00.000Z', '["a"]', '{"k":1}', null]);
    expect(decode('bigint', 9007199254740993n)).toBe('9007199254740993');
    expect(decode('INTEGER', 5n)).toBe('5');
    expect(decode('INT', 5n)).toBe(5);
    expect(decode('boolean', 0n)).toBe(false);
    expect(decode('timestamptz', '2026-01-01T00:00:00.000Z')).toEqual(new Date('2026-01-01T00:00:00.000Z'));
    expect(decode('json_text', '{"a":[1]}')).toEqual({ a: [1] });
    expect(decode('text_array', '["x","y"]')).toEqual(['x', 'y']);
    expect(decode(null, 7n)).toBe(7);
    expect(decode(null, 2n ** 60n)).toBe(String(2n ** 60n));
  });

  it('**제약 오류에 PG 의 SQLSTATE 를 단다** — 저장소의 409/422 갈래가 방언마다 같다', () => {
    const e = (errcode: number, message: string): Record<string, unknown> =>
      mapSqliteError(Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR', errcode })) as Record<string, unknown>;
    expect(e(2067, 'UNIQUE constraint failed: pools.key')).toMatchObject({ code: '23505', constraint: 'pools.key', sqliteCode: 'ERR_SQLITE_ERROR' });
    expect(e(275, 'CHECK constraint failed: pool_hash_key_iff')).toMatchObject({ code: '23514', constraint: 'pool_hash_key_iff' });
    expect(e(787, 'FOREIGN KEY constraint failed')).toMatchObject({ code: '23503' });
    expect(e(787, 'FOREIGN KEY constraint failed')['constraint']).toBeUndefined();
    expect(e(5, 'database is locked')).toMatchObject({ code: 'ERR_SQLITE_ERROR' });
  });
});
