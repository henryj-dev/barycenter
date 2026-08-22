/**
 * 검수 2026-08-22 · B-04 + B-10 — **드레인은 풀 수 있어야 하고, 저절로도 풀려야 한다**
 *
 * `backend_drain` 에 행을 넣는 코드는 있는데 **지우는 코드가 없었다.** API 에도 CLI 에도
 * undrain 이 없다. 한번 드레인한 백엔드는 DB 를 손으로 고치기 전까지 영원히 멤버십에서
 * 빠진다 — 운영 중에 백엔드를 잠깐 빼는 것이 **되돌릴 수 없는 조작**이었다.
 *
 * `deadline_s` 는 API 가 받아서 `deadline_at` 에 저장하는데 **읽는 코드가 없었다.**
 * 만료돼도 아무 일이 안 일어난다 — 이 저장소가 반복해서 잡는 *"필드는 있는데 아무도
 * 안 읽는다"* 의 또 한 판이다.
 *
 * 그리고 표에 FK 가 없어서(B-10 은 `backend_health` 도 같다) 백엔드를 지웠다 **같은 key
 * 로 다시 만들면 드레인과 옛 헬스 판정이 조용히 되살아난다.**
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';

import { createApi } from '../../src/api/server.js';
import { ConfigStore, type PatchOp } from '../../src/store/config-store.js';
import { ControlPlane } from '../../src/control/plane.js';
import { TokenAuth } from '../../src/api/auth.js';
import { LeaderElection } from '../../src/control/leader.js';
import { drainKeys, isDraining, startDrain } from '../../src/control/drain.js';
import type { DataplaneDriver } from '../../src/dp/driver.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('audit-drain');
const TOKEN = 'audit-drain-token';

let db: Db;
let store: ConfigStore;
let server: import('node:http').Server;
let base = '';

/** 드레인 경로는 `projectHealth` 를 부른다 — 멤버십 평면이 꺼져 있으면 바로 돌아온다. */
const driver: DataplaneDriver = new Proxy({} as DataplaneDriver, {
  get: (_t, prop) => () => {
    throw new Error(`이 테스트는 데이터 플레인을 안 태운다 (호출됨: ${String(prop)})`);
  },
});

async function req(method: string, path: string, body?: unknown): Promise<{
  status: number; body: unknown;
}> {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  if (text === '') return { status: r.status, body: null };
  try { return { status: r.status, body: JSON.parse(text) as unknown }; } catch {
    return { status: r.status, body: text };
  }
}

const model: PatchOp[] = [
  { op: 'put', kind: 'pool', key: 'app', body: { protocolClass: 'http', algorithm: 'round_robin' } },
  { op: 'put', kind: 'backend', key: 'a-11', body: { pool: 'app', host: '10.0.0.1', port: 11, weight: 1 } },
  {
    op: 'put', kind: 'listener', key: 'front',
    body: {
      protocol: 'http', bind: '0.0.0.0', port: 999, enabled: true,
      http: { defaultAction: { pool: 'app' } },
    },
  },
];

async function commitAll(ops: PatchOp[]): Promise<void> {
  const head = await store.head();
  const cs = await store.createChangeset(head.revision, 't');
  await store.patchChangeset(cs, ops, 't');
  const plan = await store.plan(cs, 't');
  await store.commit(cs, plan.id, 't');
}

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 실물 PG 를 쓴다');
  startPg(PG);
  db = new Db(PG.dsn);
  await db.migrate();
  store = new ConfigStore(db, { streamRealip: false });

  const election = new LeaderElection(PG.dsn, 'audit-drain-test');
  if (!(await election.tryAcquire())) throw new Error('리더 획득 실패');
  const control = new ControlPlane(db, store, driver, election,
    { prefix: '/tmp/bary-audit-drain', adminSocket: '/tmp/bary-admin-test.sock' });
  const auth = new TokenAuth([{
    name: 'tester',
    hash: `sha256:${createHash('sha256').update(TOKEN).digest('hex')}`,
    scopes: ['read', 'write', 'apply'],
  }]);

  server = createApi({ db, store, control, auth, election });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 180_000);

afterAll(async () => {
  await new Promise<void>((r) => { server?.close(() => { r(); }); });
  await db?.close();
  stopPg(PG);
});

beforeEach(async () => {
  await reset(db);
  await commitAll(model);
});

describe('드레인 수명 (검수 B-04 · B-10)', () => {
  it('드레인을 풀 수 있고 만료되면 저절로 풀린다', async () => {
    // ① 시작 — 여기까지는 전에도 됐다.
    expect((await req('POST', '/api/v1/backends/a-11/drain')).status).toBe(200);
    expect(await isDraining(db, 'a-11')).toBe(true);
    expect([...await drainKeys(db)]).toEqual(['a-11']);

    // ② **푼다.** 이 경로가 아예 없었다.
    expect((await req('DELETE', '/api/v1/backends/a-11/drain')).status).toBe(200);
    expect(await isDraining(db, 'a-11')).toBe(false);
    expect([...await drainKeys(db)]).toEqual([]);

    // ③ **만료.** deadline 을 받아 저장만 하고 아무도 안 읽고 있었다.
    await startDrain(db, 'a-11', 'tester', 3600);
    expect([...await drainKeys(db)]).toEqual(['a-11']);
    await db.query(`UPDATE backend_drain SET deadline_at = now() - interval '1 second'`);
    expect([...await drainKeys(db)]).toEqual([]);
    // 만료된 드레인은 "드레인 중" 이 아니다 — 두 판정이 갈리면 안 된다.
    expect(await isDraining(db, 'a-11')).toBe(false);
  });

  it('없는 드레인을 푸는 것은 404 다', async () => {
    // 빈 성공으로 답하면 "풀렸다" 와 "원래 없었다" 가 같아진다.
    expect((await req('DELETE', '/api/v1/backends/a-11/drain')).status).toBe(404);
    // 없는 백엔드는 그것대로 404 다.
    expect((await req('DELETE', '/api/v1/backends/nope/drain')).status).toBe(404);
  });

  it('백엔드를 지우면 드레인과 헬스 판정이 함께 사라진다', async () => {
    await startDrain(db, 'a-11', 'tester');
    await db.query(
      `INSERT INTO backend_health (backend_key, state, probe_start_seq, consecutive, last_ok)
       VALUES ('a-11','unhealthy',7,3,false)`);

    // 백엔드를 지운다 — 리스너가 풀을 참조하므로 라우팅부터 걷어낸다.
    await commitAll([
      { op: 'delete', kind: 'listener', key: 'front' },
      { op: 'delete', kind: 'backend', key: 'a-11' },
      { op: 'delete', kind: 'pool', key: 'app' },
    ]);

    // **잔존 행이 남으면 같은 key 로 만든 새 백엔드가 처음부터 빠진다.**
    expect((await db.query('SELECT 1 FROM backend_drain WHERE backend_key=$1', ['a-11'])).rows)
      .toEqual([]);
    expect((await db.query('SELECT 1 FROM backend_health WHERE backend_key=$1', ['a-11'])).rows)
      .toEqual([]);
  });
});
