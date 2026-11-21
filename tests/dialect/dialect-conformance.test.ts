/**
 * 방언 적합성 — 경계(`Database` · `LeaderLock`)가 방언마다 같은 계약을 지키는가 (docs/adr-multi-db.md)
 *
 *   BARY_TEST_DB=postgres npm run test:dialect    (기본)
 *   BARY_TEST_DB=sqlite   npm run test:dialect    (2단계)
 *   BARY_TEST_DB=mysql    npm run test:dialect    (3단계)
 *   BARY_TEST_DB=mariadb  npm run test:dialect    (3단계 — MySQL 방언)
 *
 * 여기 SQL 은 방언마다 나란히 둔다(`byDialect`) — 저장소 함수가 하는 방식과 같다. 이 묶음은 **골격**이다:
 * 방언 하나의 완료 조건은 이것에 더해 `tests/store` 묶음 전체가 그 DB 로 통과하는 것이다.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ACCOUNT_MIGRATIONS } from '../../src/accounts/migrations.js';
import { LeaderElection } from '../../src/control/leader.js';
import type { Database, DialectName } from '../../src/store/db.js';
import { CONFIG_MIGRATIONS } from '../../src/store/migration-sets.js';
import { openDbForTest, openLeaderLockForTest } from '../../src/store/open.js';
import { compareShapes, readSchemaShape, type ColumnShape, type LogicalType, type SchemaShape } from '../../src/store/schema-shape.js';
import { startTestDb, type TestDb } from './db-under-test.js';

let t: TestDb;
let db: Database;

const byDialect = <T>(m: Record<DialectName, T>): T => m[db.dialect.name];

const files = (dir: string): string[] => readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

beforeAll(async () => {
  t = startTestDb('conformance');
  db = openDbForTest(t.dsn, 'BARY_TEST_DB');
}, 180_000);

afterAll(async () => {
  await db?.close();
  t?.stop();
});

describe(`방언 적합성 (${process.env['BARY_TEST_DB'] ?? 'postgres'})`, () => {
  it('DSN 의 스킴이 시험하는 방언을 연다', () => {
    expect(db.dialect.name).toBe(t.dialect);
  });

  it('**두 계열을 같은 DB 에 적용해도 섞이지 않는다** — 다시 돌리면 아무것도 안 한다', async () => {
    expect(await db.migrate(CONFIG_MIGRATIONS)).toEqual(files(CONFIG_MIGRATIONS.dir));
    expect(await db.migrate(ACCOUNT_MIGRATIONS)).toEqual(files(ACCOUNT_MIGRATIONS.dir));
    expect(await db.migrate(CONFIG_MIGRATIONS)).toEqual([]);
    expect(await db.migrate()).toEqual([]);
    expect(await db.migrate(ACCOUNT_MIGRATIONS)).toEqual([]);
  });

  it('스키마 모양을 읽는다 — 모든 열이 논리 형으로 줄어든다(방언 사이 비교의 전제)', async () => {
    const shape = await readSchemaShape(db);
    expect(Object.keys(shape)).toEqual(expect.arrayContaining(['config_head', 'config_revisions', 'leadership', 'users']));
    const raw = Object.entries(shape).flatMap(([table, cols]) =>
      Object.entries(cols).filter(([, c]) => c.type.startsWith('raw:')).map(([col, c]) => `${table}.${col} ${c.type}`));
    expect(raw).toEqual([]);
  });

  it('**리소스 key 의 CHECK 가 세 방언에서 같은 판정을 한다** — `:` 구간 · 127 자 (034_key_segments)', async () => {
    await db.migrate();
    const pool = async (key: string): Promise<unknown> => db.query(
      `INSERT INTO pools (id, key, name, protocol_class, algorithm, created_by, updated_by, revision)
       VALUES ($1, $2, 'n', 'http', 'round_robin', 't', 't', 1)`, [randomUUID(), key]);
    for (const ok of ['web-01.dc1:shop:api:01', 'a'.repeat(127), 'plain.key-1_A']) {
      await pool(ok);
      await db.query('DELETE FROM pools WHERE key = $1', [ok]);
    }
    for (const bad of ['a::b', ':a', 'a:', 'a:-b', 'a'.repeat(128), 'a~http', 'ok\n']) {
      await expect(pool(bad), JSON.stringify(bad)).rejects.toMatchObject({ code: '23514', constraint: 'pools_key_syntax' });
    }
  });

  it('**풀 헬스체크 CHECK 가 세 방언에서 같은 판정을 한다** — http · tcp 는 받고 udp 는 막는다 (037)', async () => {
    await db.migrate();
    const pool = async (cls: string): Promise<string> => {
      const key = `hc-${cls}-${randomUUID().slice(0, 8)}`;
      await db.query(
        `INSERT INTO pools (id, key, name, protocol_class, algorithm, created_by, updated_by, revision, health_check)
         VALUES ($1, $2, 'n', $3, 'round_robin', 't', 't', 1, $4)`,
        [randomUUID(), key, cls, JSON.stringify({ mode: 'active', protocol: 'tcp_connect', intervalS: 5 })]);
      return key;
    };
    for (const ok of ['http', 'tcp']) await db.query('DELETE FROM pools WHERE key = $1', [await pool(ok)]);
    await expect(pool('udp')).rejects.toMatchObject({ code: '23514', constraint: 'pool_healthcheck_http_only' });
  });

  it('**이름 바꾸기가 세 방언에서 같은 결과를 낸다** — 참조 · 문자열 참조 · 곁 행이 따라온다', async () => {
    await db.migrate();
    const { ConfigStore } = await import('../../src/store/config-store.js');
    const store = new ConfigStore(db);
    const commit = async (patch: import('../../src/store/config-store.js').PatchOp[]): Promise<string> => {
      const cs = await store.createChangeset((await store.head()).revision, 't');
      await store.patchChangeset(cs, patch, 't');
      const plan = await store.plan(cs, 't');
      return (await store.commit(cs, plan.id, 't')).revision;
    };
    await commit([
      { op: 'put', kind: 'pool', key: 'rn-app', body: { protocolClass: 'http', algorithm: 'round_robin' } },
      { op: 'put', kind: 'backend', key: 'rn-app-1', body: { pool: 'rn-app', host: '10.0.0.1', port: 8080, weight: 1 } },
      { op: 'put', kind: 'addressSet', key: 'rn-office', body: { cidrs: ['192.0.2.0/24'] } },
      { op: 'put', kind: 'listener', key: 'rn-edge', body: {
        protocol: 'http', bind: '0.0.0.0', port: 18081, enabled: true, sourceAllow: ['@rn-office'], http: { defaultAction: { pool: 'rn-app' } } } },
      { op: 'put', kind: 'httpRoute', key: 'rn-api', body: {
        listener: 'rn-edge', hosts: ['rn.test'], priority: 0, action: { kind: 'proxy', pool: 'rn-app', websocket: false },
        sourceRules: [{ from: ['@rn-office'], action: { kind: 'proxy', pool: 'rn-app', websocket: true } }] } },
    ]);
    await db.query("INSERT INTO backend_health (backend_key, state, consecutive) VALUES ('rn-app-1', 'unhealthy', 2)");
    const rev = await commit([
      { op: 'rename', kind: 'pool', key: 'rn-app', to: 'h1:rn:app' },
      { op: 'rename', kind: 'backend', key: 'rn-app-1', to: 'h1:rn:app:01' },
      { op: 'rename', kind: 'addressSet', key: 'rn-office', to: 'site:hq' },
      { op: 'rename', kind: 'listener', key: 'rn-edge', to: 'h1:rn:edge' },
    ]);
    const m = await store.modelAt(rev);
    expect(m.backends.find((b) => b.key === 'h1:rn:app:01')?.pool).toBe('h1:rn:app');
    expect(m.listeners.find((l) => l.key === 'h1:rn:edge')?.sourceAllow).toEqual(['@site:hq']);
    const route = m.httpRoutes.find((r) => r.key === 'rn-api')!;
    expect(route.listener).toBe('h1:rn:edge');
    expect(route.sourceRules?.[0]).toMatchObject({ from: ['@site:hq'], action: { pool: 'h1:rn:app' } });
    expect((await db.query("SELECT state FROM backend_health WHERE backend_key = 'h1:rn:app:01'")).rows).toEqual([{ state: 'unhealthy' }]);
    expect((await db.query("SELECT name FROM pools WHERE key = 'h1:rn:app'")).rows).toEqual([{ name: 'h1:rn:app' }]);
  });

  it('**스키마 모양이 PG 의 모양과 같다** — 표 · 열 · 논리 형 · NULL 허용 (`schema-shape-pg.json`)', async () => {
    // 스냅숏은 PG 의 모양이다. PG 로 돌 때는 「살아 있는 PG = 스냅숏」 을, 다른 방언으로 돌 때는
    // 「그 방언 = 스냅숏」 을 잰다 — 둘이 함께 「방언 = PG」 다. PG 마이그레이션을 더하면 PG 회차가 빨개지고,
    // 스냅숏을 고치면(`node scripts/…` 없이 이 파일을 손으로) 다른 방언 회차가 그 방언의 파일을 요구한다.
    const want = pgShapeSnapshot();
    expect(compareShapes(want, await readSchemaShape(db))).toEqual([]);
  });

  describe('트랜잭션', () => {
    beforeAll(async () => {
      await db.query(byDialect({
        postgres: 'CREATE TABLE dialect_probe (k text PRIMARY KEY, n bigint NOT NULL)',
        mysql: 'CREATE TABLE dialect_probe (k varchar(64) PRIMARY KEY, n bigint NOT NULL)',
        sqlite: 'CREATE TABLE dialect_probe (k text PRIMARY KEY, n integer NOT NULL)',
      }));
    });

    const put = byDialectLater({
      postgres: 'INSERT INTO dialect_probe (k, n) VALUES ($1, $2)',
      mysql: 'INSERT INTO dialect_probe (k, n) VALUES ($1, $2)',
      sqlite: 'INSERT INTO dialect_probe (k, n) VALUES (?, ?)',
    });
    const get = byDialectLater({
      postgres: 'SELECT n FROM dialect_probe WHERE k = $1',
      mysql: 'SELECT n FROM dialect_probe WHERE k = $1',
      sqlite: 'SELECT n FROM dialect_probe WHERE k = ?',
    });
    const read = async (k: string): Promise<unknown> => (await db.query(get(), [k])).rows[0]?.['n'];

    it('커밋하면 남고, 던지면 롤백한다', async () => {
      await db.tx(async (c) => { await c.query(put(), ['kept', '1']); });
      await expect(db.tx(async (c) => {
        await c.query(put(), ['gone', '1']);
        throw new Error('되돌린다');
      })).rejects.toThrow('되돌린다');
      expect(await read('kept')).toBe('1');
      expect(await read('gone')).toBeUndefined();
    });

    it('**dryRun 은 성공해도 롤백한다** — plan 의 시뮬레이션', async () => {
      const out = await db.dryRun(async (c) => {
        await c.query(put(), ['sim', '1']);
        return (await c.query(get(), ['sim'])).rows.length;
      });
      expect(out).toBe(1);
      expect(await read('sim')).toBeUndefined();
    });

    it('**bigint 는 문자열로 온다** — 2^53 위에서 뭉개지지 않는다', async () => {
      await db.query(put(), ['big', '9007199254740993']);
      expect(await read('big')).toBe('9007199254740993');
    });
  });

  describe('리더 잠금', () => {
    it('**하나만 쥔다** · 놓으면 다른 쪽이 쥐고 토큰은 엄격히 커진다', async () => {
      const a = new LeaderElection(openLeaderLockForTest(t.dsn), 'a');
      const b = new LeaderElection(openLeaderLockForTest(t.dsn), 'b');
      try {
        expect(await a.tryAcquire()).toBe(true);
        expect(await b.tryAcquire()).toBe(false);
        expect(b.state.token).toBeUndefined();
        const first = BigInt(a.assertLeader());
        await a.release();
        expect(a.state.reason).toBe('스스로 물러났다');
        expect(await b.tryAcquire()).toBe(true);
        expect(BigInt(b.assertLeader()) > first).toBe(true);
      } finally {
        await a.release();
        await b.release();
      }
    });
  });
});

/** `schema-shape-pg.json` — `"열": "형"` 또는 `"열": "형 null"`. */
function pgShapeSnapshot(): SchemaShape {
  const raw = JSON.parse(readFileSync(join(import.meta.dirname, 'schema-shape-pg.json'), 'utf8')) as Record<string, Record<string, string>>;
  const out: Record<string, Record<string, ColumnShape>> = {};
  for (const [table, cols] of Object.entries(raw)) {
    out[table] = Object.fromEntries(Object.entries(cols).map(([col, v]) => {
      const [type, nul] = v.split(' ');
      return [col, { type: type as LogicalType, nullable: nul === 'null' }];
    }));
  }
  return out;
}

/** 시험 정의 시점에는 아직 DB 가 없다 — 문장은 부를 때 고른다. */
function byDialectLater(m: Record<DialectName, string>): () => string {
  return () => byDialect(m);
}
