/**
 * 저장소 상태 (2026-11-20) — DB 종류 · 보존 정책 · 마지막 청소를 `GET /api/v1/system/storage` 로 말한다.
 *
 * 지키는 것: 비밀(DSN · KEK 값)을 안 싣는다 · 청소 결과가 없으면 `null` 이다(0 건으로 채우지 않는다) ·
 * 판을 못 물으면 `null` 이다 · 전역이 중계하고 CLI 가 읽는다.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

import { afterAll, describe, expect, it } from 'vitest';

import { getPath } from '../../src/cli/get.js';
import { RETENTION_TABLES, serverVersion, StorageStatus, type StorageFacts } from '../../src/control/storage-status.js';
import { RELAY_PATHS } from '../../src/global/relay.js';
import { DIALECTS } from '../../src/store/db.js';
import { daysText, dbText, everyText, generationsText, secretText, sweepText } from '../../src/web/storage-view.js';

const prefix = mkdtempSync(join(tmpdir(), 'bary-storage-'));
afterAll(() => rmSync(prefix, { recursive: true, force: true }));

const facts = (over: Partial<StorageFacts> = {}): StorageFacts => ({
  configDb: { kind: 'postgres' },
  accountsDb: null,
  secrets: { backend: 'pg' },
  retention: {
    intervalMs: 3_600_000,
    days: { health_events: 30, audit: null, plans: 7, changesets: null, operations: null, config_revisions: null },
  },
  generations: { keep: 10, prefix },
  secretGc: { enabled: true, keepPerName: 2, minAgeMs: 3_600_000, intervalMs: 3_600_000 },
  ...over,
});

const pgDb = (version: string | Error) => ({
  dialect: DIALECTS.postgres,
  query: async (sql: string) => {
    if (version instanceof Error) throw version;
    expect(sql).toContain('server_version');
    return { rows: [{ v: version }], rowCount: 1 };
  },
});

describe('StorageStatus.body', () => {
  it('청소 전에는 last 가 null 이고, 세대 디렉토리를 센다', async () => {
    mkdirSync(join(prefix, 'generations', 'r1-e1'), { recursive: true });
    writeFileSync(join(prefix, 'generations', 'r1-e1', 'nginx.conf'), 'x'.repeat(100));
    const b = await new StorageStatus(facts()).body({ db: pgDb('16.4') as never, isLeader: true });
    expect(b.configDb).toEqual({ kind: 'postgres', version: '16.4' });
    expect(b.secrets).toEqual({ backend: 'pg', encrypted: true, kekConfigured: true });
    expect(b.retention.tables.map((t) => t.table)).toEqual([...RETENTION_TABLES]);
    expect(b.retention.tables.find((t) => t.table === 'audit')?.days).toBeNull();
    expect(b.retention.last).toBeNull();
    expect(b.generations).toMatchObject({ keep: 10, count: 1, bytes: 100, last: null });
    expect(b.secretGc.last).toBeNull();
  });

  it('청소 결과를 적는다 — 표마다 건수, 실패는 메시지', async () => {
    const s = new StorageStatus(facts(), () => Date.parse('2026-11-20T01:00:00Z'));
    s.recordDbSweep({ healthEvents: 5, audit: 0, plans: 2, changesets: 0, operations: 0, revisions: 0 });
    s.recordGenerationSweep({ kept: ['a', 'b'], removed: ['c'], failed: [] });
    s.recordSecretFailure(new Error('권한 없음'));
    const b = await s.body({ db: pgDb('16.4') as never, isLeader: true });
    expect(b.retention.last).toEqual({
      at: '2026-11-20T01:00:00.000Z', ok: true, removed: 7,
      byTable: { health_events: 5, audit: 0, plans: 2, changesets: 0, operations: 0, config_revisions: 0 },
    });
    expect(b.generations.last).toEqual({ at: '2026-11-20T01:00:00.000Z', ok: true, removed: 1, kept: 2, failed: 0 });
    expect(b.secretGc.last).toEqual({ at: '2026-11-20T01:00:00.000Z', ok: false, error: '권한 없음' });
  });

  it('fs 시크릿은 암호화가 아니고 KEK 도 없다', async () => {
    const b = await new StorageStatus(facts({ secrets: { backend: 'fs' } })).body({ db: pgDb('16.4') as never, isLeader: false });
    expect(b.secrets).toEqual({ backend: 'fs', encrypted: false, kekConfigured: false });
    expect(b.isLeader).toBe(false);
  });

  it('비밀을 싣지 않는다 — 몸통에 DSN · 호스트 · KEK 자리가 없다', async () => {
    const b = await new StorageStatus(facts({ accountsDb: { kind: 'mariadb' } })).body({ db: pgDb('16.4') as never, isLeader: true });
    const text = JSON.stringify(b);
    expect(text).not.toMatch(/dsn|password|host|kekId|"kek"/i);
    expect(b.accountsDb).toEqual({ kind: 'mariadb' });
  });
});

describe('serverVersion', () => {
  it('방언마다 판을 묻고, 못 물으면 null 이다', async () => {
    expect(await serverVersion(pgDb('16.4') as never)).toBe('16.4');
    expect(await serverVersion(pgDb(new Error('permission denied')) as never)).toBeNull();
    const mysql = { dialect: DIALECTS.mysql, query: async (sql: string) => ({ rows: [{ v: sql.includes('VERSION()') ? '11.4.2-MariaDB' : '' }], rowCount: 1 }) };
    expect(await serverVersion(mysql as never)).toBe('11.4.2-MariaDB');
    const sqlite = { dialect: DIALECTS.sqlite, query: async (sql: string) => ({ rows: [{ v: sql.includes('sqlite_version') ? '3.46.0' : '' }], rowCount: 1 }) };
    expect(await serverVersion(sqlite as never)).toBe('3.46.0');
  });
});

describe('API — /api/v1/system/storage', () => {
  it('저장소가 없으면 available:false, 있으면 몸통', async () => {
    const { TokenAuth, hashToken } = await import('../../src/api/auth.js');
    const { createApi } = await import('../../src/api/server.js');
    const auth = new TokenAuth([{ name: 'r', hash: hashToken('t'), scopes: ['read'] }]);
    const election = { state: { isLeader: true, token: '1', holder: 't', since: '' } };
    const base = { db: pgDb('16.4'), store: {}, control: {}, auth, election } as never;
    for (const [opts, want] of [[{}, false], [{ storage: new StorageStatus(facts()) }, true]] as const) {
      const server = createApi({ ...(base as object), ...opts } as never);
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const r = await fetch(`${url}/api/v1/system/storage`, { headers: { authorization: 'Bearer t' } });
      expect(r.status).toBe(200);
      const body = await r.json() as Record<string, unknown>;
      expect(body['available']).toBe(want);
      if (want) expect(body['configDb']).toEqual({ kind: 'postgres', version: '16.4' });
      const anon = await fetch(`${url}/api/v1/system/storage`);
      expect(anon.status).toBe(401);
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('창구 — CLI · 전역 중계 · 화면', () => {
  it('bary get system/storage 와 전역 중계 목록', () => {
    expect(getPath('system/storage')).toBe('/api/v1/system/storage');
    expect(RELAY_PATHS).toContain('system/storage');
    const server = readFileSync(join(import.meta.dirname, '../../src/api/server.ts'), 'utf8');
    expect(server).toContain("route('GET', '/api/v1/regions/:name/system/storage', 'read', relayTo('system/storage'))");
  });

  it('상태 화면이 저장소 카드를 그린다', () => {
    const panel = readFileSync(join(import.meta.dirname, '../../gui/src/lib/ops/StatusPanel.svelte'), 'utf8');
    expect(panel).toContain('<StorageCard');
    expect(panel).toContain('desk.systemStorage()');
  });
});

describe('화면의 말 (src/web/storage-view.ts)', () => {
  it('종류 · 일수 · 주기 · 시크릿', () => {
    expect(dbText('postgres', '16.4')).toBe('PostgreSQL 16.4');
    expect(dbText('sqlite', null)).toBe('SQLite');
    expect(daysText(null)).toBe('지우지 않아요');
    expect(daysText(30)).toBe('30일 남겨요');
    expect(everyText(3_600_000)).toBe('1시간마다');
    expect(everyText(1_800_000)).toBe('30분마다');
    expect(secretText({ backend: 'fs', encrypted: false, kekConfigured: false })).toBe('파일(평문, 0400)');
    expect(generationsText({ count: 3, bytes: 2048, keep: 10 })).toBe('3개 · 2 KB · 최근 10개를 남겨요');
  });

  it('마지막 청소 — 없음 · 팔로워 · 실패 · 못 지운 것', () => {
    expect(sweepText(null, true).text).toBe('아직 안 돌았어요.');
    expect(sweepText(null, false).text).toContain('리더만');
    expect(sweepText({ at: 'x', ok: false, error: 'e' }, true)).toEqual({ tone: 'danger', text: '실패했어요: e' });
    expect(sweepText({ at: 'x', ok: true, removed: 3, kept: 2, failed: 1 }, true)).toEqual({ tone: 'warn', text: '지운 것 3개 · 남긴 것 2개 · 못 지운 것 1개' });
    expect(sweepText({ at: 'x', ok: true, removed: 0 }, true)).toEqual({ tone: 'ok', text: '지운 것 0개' });
  });
});
