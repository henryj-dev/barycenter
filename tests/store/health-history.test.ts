/**
 * 헬스 기록 — `health_events` 를 읽는다 (2026-11-20).
 *
 * `health_events` 는 판정이 바뀔 때마다 쓰였지만 **읽는 곳이 없었다.** 지금 정상인 백엔드가 언제 흔들렸는지 알 길이 없었다.
 * 여기서 재는 것:
 *
 *   · 최근 것부터, `before` 커서로 쪽을 넘긴다 — 쪽 경계에서 빠지거나 겹치는 기록이 없다
 *   · `from` 은 같은 백엔드의 바로 앞 판정이다. 쪽 경계를 넘어서도 맞고, 앞 기록이 없으면 `null` 이다
 *   · 풀은 소속 백엔드와 출처에서 받은 백엔드(`disc~<풀>~`)만 본다 — 키의 `_` 가 다른 풀을 끌어오지 않는다
 *   · API: 없는 리소스는 404, 잘못된 커서는 400, 지역 중계 목록에 있다
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';

import { createApi } from '../../src/api/server.js';
import { ConfigStore, type PatchOp } from '../../src/store/config-store.js';
import { ControlPlane } from '../../src/control/plane.js';
import { TokenAuth } from '../../src/api/auth.js';
import { LeaderElection } from '../../src/control/leader.js';
import type { DataplaneDriver } from '../../src/dp/driver.js';
import { healthHistory } from '../../src/control/health.js';
import { RELAY_PATHS } from '../../src/global/relay.js';
import { getPath } from '../../src/cli/get.js';
import { openLeaderLockForTest } from '../../src/store/open.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('health-history');
const TOKEN = 'health-history-token';
let db: Db;
let store: ConfigStore;
let server: import('node:http').Server;
let base = '';

const driver: DataplaneDriver = new Proxy({} as DataplaneDriver, {
  get: (_t, prop) => () => {
    throw new Error(`이 테스트는 데이터 플레인을 안 태운다 (호출됨: ${String(prop)})`);
  },
});

async function get(path: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  return { status: r.status, body: await r.json().catch(() => null) };
}

const PUT = (kind: PatchOp extends { kind: infer K } ? K : never, key: string, body: unknown): PatchOp =>
  ({ op: 'put', kind, key, body } as PatchOp);

async function commitAll(patch: PatchOp[]): Promise<void> {
  const head = await store.head();
  const id = await store.createChangeset(head.revision, 't');
  await store.patchChangeset(id, patch, 't');
  const plan = await store.plan(id, 't');
  await store.commit(id, plan.id, 't');
}

/** 순번을 정해 기록을 넣는다. 시각은 DB 기본값(지금)이다 — 순서는 순번이 정한다. */
async function event(seq: number, key: string, state: 'healthy' | 'unhealthy', detail?: string): Promise<void> {
  await db.query('INSERT INTO health_events (seq, backend_key, state, detail) VALUES ($1,$2,$3,$4)',
    [String(seq), key, state, detail ?? null]);
}

/** 시각은 ISO 문자열이고 지금 근처다 — 방언마다 시각 표현이 달라도 같은 모양으로 나와야 한다. */
const isNowish = (iso: string | undefined): boolean =>
  iso !== undefined && /Z$/.test(iso) && Math.abs(Date.parse(iso) - Date.now()) < 10 * 60_000;

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 실물 DB 를 쓴다');
  startPg(PG);
  db = new Db(PG.dsn);
  await db.migrate();
  store = new ConfigStore(db, { streamRealip: false });
  const election = new LeaderElection(openLeaderLockForTest(PG.dsn), 'health-history-test');
  if (!(await election.tryAcquire())) throw new Error('리더 획득 실패');
  const control = new ControlPlane(db, store, driver, election,
    { prefix: '/tmp/bary-health-history-test', adminSocket: '/tmp/bary-health-history.sock' });
  const hash = (await import('node:crypto')).createHash('sha256').update(TOKEN).digest('hex');
  const auth = new TokenAuth([{ name: 'tester', hash: `sha256:${hash}`, scopes: ['read'] }]);
  server = createApi({ db, store, control, auth, election });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 180_000);

afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  await db?.close();
  stopPg(PG);
});

beforeEach(async () => {
  await reset(db);
  await db.query('DELETE FROM health_events');
  await commitAll([
    PUT('pool', 'p_1', { protocolClass: 'tcp', algorithm: 'round_robin' }),
    PUT('pool', 'pX1', { protocolClass: 'tcp', algorithm: 'round_robin' }),
    PUT('backend', 'a', { pool: 'p_1', host: '127.0.0.1', port: 9001, weight: 1 }),
    PUT('backend', 'b', { pool: 'p_1', host: '127.0.0.1', port: 9002, weight: 1 }),
    PUT('backend', 'c', { pool: 'pX1', host: '127.0.0.1', port: 9003, weight: 1 }),
  ]);
});

describe('헬스 기록 읽기', () => {
  it('최근 것부터, `from` 은 바로 앞 판정, 쪽 경계를 넘어도 맞다', async () => {
    await event(1, 'a', 'healthy');
    await event(2, 'a', 'unhealthy', 'TCP 127.0.0.1:9001 에 연결하지 못했다');
    await event(3, 'b', 'healthy');
    await event(4, 'a', 'healthy');

    const first = await healthHistory(db, { backendKeys: ['a'], limit: 2 });
    expect(first.events.map((e) => [e.seq, e.from, e.to])).toEqual([['4', 'unhealthy', 'healthy'], ['2', 'healthy', 'unhealthy']]);
    expect(first.events[1]?.detail).toBe('TCP 127.0.0.1:9001 에 연결하지 못했다');
    expect(first.next).toBe('2');

    const second = await healthHistory(db, { backendKeys: ['a'], limit: 2, before: first.next! });
    expect(second.events.map((e) => [e.seq, e.from, e.to])).toEqual([['1', null, 'healthy']]);
    expect(second.next).toBeUndefined();
    expect(isNowish(second.events[0]?.at)).toBe(true);
  });

  it('풀은 소속 백엔드와 `disc~<풀>~` 만 — `_` 가 다른 풀을 끌어오지 않는다', async () => {
    await event(1, 'a', 'unhealthy');
    await event(2, 'c', 'unhealthy');
    await event(3, 'disc~p_1~10.0.0.1~80', 'healthy');
    await event(4, 'disc~pX1~10.0.0.2~80', 'healthy');
    const page = await healthHistory(db, { backendKeys: ['a', 'b'], prefix: 'disc~p_1~', limit: 50 });
    expect(page.events.map((e) => e.backendKey)).toEqual(['disc~p_1~10.0.0.1~80', 'a']);
  });

  it('볼 백엔드가 없으면 빈 쪽이다', async () => {
    await event(1, 'a', 'healthy');
    expect(await healthHistory(db, { backendKeys: [], limit: 10 })).toEqual({ events: [] });
  });
});

describe('헬스 기록 API', () => {
  it('백엔드 · 풀 기록을 준다', async () => {
    await event(1, 'a', 'unhealthy', '이유');
    await event(2, 'b', 'unhealthy');
    await event(3, 'c', 'unhealthy');
    const b = await get('/api/v1/backends/a/health-history');
    expect(b.status).toBe(200);
    expect(b.body.events).toHaveLength(1);
    expect(b.body.events[0]).toMatchObject({ seq: '1', backendKey: 'a', from: null, to: 'unhealthy', detail: '이유' });
    expect(isNowish(b.body.events[0].at)).toBe(true);
    expect(b.body.next).toBeUndefined();
    const p = await get('/api/v1/pools/p_1/health-history?limit=1');
    expect(p.status).toBe(200);
    expect(p.body.events.map((e: { backendKey: string }) => e.backendKey)).toEqual(['b']);
    expect(p.body.next).toBe('2');
    const p2 = await get(`/api/v1/pools/p_1/health-history?limit=1&before=${p.body.next}`);
    expect(p2.body.events.map((e: { backendKey: string }) => e.backendKey)).toEqual(['a']);
  });

  it('없는 백엔드 · 풀은 404, 순번이 아닌 커서는 400', async () => {
    expect((await get('/api/v1/backends/없는것/health-history')).status).toBe(404);
    expect((await get('/api/v1/pools/없는것/health-history')).status).toBe(404);
    expect((await get('/api/v1/backends/a/health-history?before=1;DROP')).status).toBe(400);
    expect((await get('/api/v1/backends/a/health-history?before=0')).status).toBe(400);
  });

  it('지역 중계 목록과 CLI 에 있다', () => {
    expect(RELAY_PATHS).toContain('backends/:id/health-history');
    expect(RELAY_PATHS).toContain('pools/:id/health-history');
    expect(getPath('backends/web:api:01/health-history')).toBe('/api/v1/backends/web%3Aapi%3A01/health-history');
    expect(getPath('pools/p/health-history')).toBe('/api/v1/pools/p/health-history');
  });
});
