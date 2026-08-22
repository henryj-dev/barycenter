/**
 * 검수 2026-08-22 · B-11 — **깨진 입력은 500 이 아니다**
 *
 * 500 은 "우리 잘못이다" 라는 뜻이다. 클라이언트가 보낸 것이 틀렸는데 500 을 주면
 * 호출자는 재시도하고, 운영자는 서버 로그를 뒤진다. 세 자리가 그랬다.
 *
 *   ① `decodeURIComponent(hit.m[i+1])` 가 `try` 블록 **밖**에 있었다
 *      → `GET /api/v1/plans/%` 는 `URIError` 로 500
 *   ② `/audit?limit=-5` → `Math.min(-5, 1000)` → PG 가 `LIMIT must not be negative`
 *   ③ `rollbackTo` 가 숫자 아닌 `to_revision` 을 그대로 bigint 컬럼에 물었다
 *
 * 셋 다 §5.1 의 4분할에서 **400**(타입·구문 오류)이거나, 정상 범위로 접히는 값이다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';

import { createApi } from '../../src/api/server.js';
import { ConfigStore } from '../../src/store/config-store.js';
import { ControlPlane } from '../../src/control/plane.js';
import { TokenAuth } from '../../src/api/auth.js';
import { LeaderElection } from '../../src/control/leader.js';
import type { DataplaneDriver } from '../../src/dp/driver.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('audit-status');
const TOKEN = 'audit-status-token';

let db: Db;
let store: ConfigStore;
let server: import('node:http').Server;
let base = '';

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

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 실물 PG 를 쓴다');
  startPg(PG);
  db = new Db(PG.dsn);
  await db.migrate();
  store = new ConfigStore(db, { streamRealip: false });

  const election = new LeaderElection(PG.dsn, 'audit-status-test');
  if (!(await election.tryAcquire())) throw new Error('리더 획득 실패');
  const control = new ControlPlane(db, store, driver, election,
    { prefix: '/tmp/bary-audit-status', adminSocket: '/tmp/bary-admin-test.sock' });
  const auth = new TokenAuth([{
    name: 'tester',
    hash: `sha256:${createHash('sha256').update(TOKEN).digest('hex')}`,
    scopes: ['read', 'write', 'apply', 'admin'],
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
});

describe('깨진 입력의 상태 코드 (검수 B-11)', () => {
  it('깨진 입력은 500 이 아니다', async () => {
    // ① 경로 파라미터가 유효한 퍼센트 인코딩이 아니다.
    const bad = await req('GET', '/api/v1/plans/%');
    expect(bad.status).toBe(400);

    // ② 음수 limit. PG 가 거절하는 값이 그대로 내려가고 있었다.
    const neg = await req('GET', '/api/v1/audit?limit=-5');
    expect(neg.status).toBe(200);
    expect(Array.isArray(neg.body)).toBe(true);

    // ③ 숫자가 아닌 리비전.
    const rb = await req('POST', '/api/v1/rollback', { to_revision: 'abc' });
    expect(rb.status).toBe(400);

    // ④ 같은 부류가 하나 더 있었다 — `plans.id` 는 uuid 컬럼이라 uuid 가 아닌
    //    경로 파라미터가 PG 의 22P02 로 500 이 됐다. 그 자리도 400 이다.
    const notUuid = await req('GET', '/api/v1/plans/does-not-exist');
    expect(notUuid.status).toBe(400);
    const notUuidCs = await req('GET', '/api/v1/changesets/nope');
    expect(notUuidCs.status).toBe(400);
  });

  it('정상 입력은 그대로다', async () => {
    // 넓히다가 멀쩡한 것까지 막으면 안 된다.
    const ok = await req('GET', '/api/v1/audit?limit=5');
    expect(ok.status).toBe(200);

    // **모양이 맞는데 없는 것**은 404 다 — 400 과 구분돼야 한다.
    const missing = await req('GET', '/api/v1/plans/00000000-0000-4000-8000-000000000000');
    expect(missing.status).toBe(404);

    const gone = await req('POST', '/api/v1/rollback', { to_revision: '999999' });
    expect(gone.status).toBe(404);
  });

  it('퍼센트 인코딩된 정상 키는 해독된다', async () => {
    // 파라미터 해독을 try 안으로 옮기면서 해독 자체를 빼먹으면 안 된다.
    const r = await req('GET', '/api/v1/pools/a%20b/backends');
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).toContain('a b');
  });
});
