/**
 * **변경 초안 · 최근 전환** (2026-11-21).
 *
 * GUI 의 「저장」 은 한 번에 commit 까지 하고, 실패하면 changeset 을 버렸다. 그래서 남이 먼저 커밋해서
 * 실패한 변경도 사라졌다. 이제 충돌이면 초안으로 남기고, 초안 화면이 그것을 읽어 다시 계획한다.
 * 적용 · 롤백이 남긴 전환(오퍼레이션)도 화면이 읽고, 끝나지 않은 것은 취소한다.
 *
 * 이 파일이 재는 것:
 *   · `GET /api/v1/changesets` — open · sealed 만, 새 것부터. `state=` 로 거른다. 모르는 state 는 400
 *   · 줄의 `etag` 이 `GET /changesets/:id` 의 ETag 와 같다 — 전역 중계는 응답 헤더를 넘기지 않는다
 *   · head 가 움직이면 `stale` 이 참이 된다. 그대로 커밋하면 PLAN_STALE 이다
 *   · `GET /api/v1/operations` · `/operations/:id` — 시각 · 누가 · 종단 여부를 싣는다
 *
 *   npm run test:store     (도커 필요 — PG · MySQL. SQLite 는 BARY_TEST_DB=sqlite)
 */
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { TokenAuth, hashToken } from '../../src/api/auth.js';
import { createApi } from '../../src/api/server.js';
import type { LeaderElection } from '../../src/control/leader.js';
import { ControlPlane } from '../../src/control/plane.js';
import { ConfigStore, type PatchOp } from '../../src/store/config-store.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('ops-drafts');
const TOKEN = 'ops-drafts-token';
const CAPS = { httpLua: true, streamLua: true, streamRealip: false, sslConfCommand: true };

let db: Db;
let config: ConfigStore;
let server: Server | undefined;
let base = '';

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 실물 DB 를 쓴다');
  startPg(PG);
  db = new Db(PG.dsn);
  await db.migrate();
  config = new ConfigStore(db as unknown as never, CAPS);
  // 전환 목록은 `ControlPlane.operations` 의 SQL 만 잰다 — 드라이버 · 선거는 필요 없다.
  const control = Object.assign(Object.create(ControlPlane.prototype) as ControlPlane, { db });
  server = createApi({
    db: db as unknown as never,
    store: config,
    control,
    auth: new TokenAuth([{ name: 'w', hash: hashToken(TOKEN), scopes: ['read', 'write'] }]),
    election: { state: { isLeader: true } } as unknown as LeaderElection,
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 240_000);

afterAll(async () => {
  server?.closeAllConnections?.();
  await new Promise<void>((r) => (server === undefined ? r() : server.close(() => r())));
  await db?.close();
  stopPg(PG);
});

beforeEach(async () => {
  await reset(db);
});

const put = (key: string): PatchOp[] => [{ op: 'put', kind: 'addressSet', key, body: { cidrs: ['10.0.0.0/8'] } }];

type Res = { status: number; body: unknown; etag: string | null };
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: r.status === 204 ? {} : await r.json().catch(() => ({})), etag: r.headers.get('etag') };
}

async function draft(key: string): Promise<string> {
  const head = await config.head();
  const cs = await config.createChangeset(head.revision, 'w');
  await config.patchChangeset(cs, put(key), 'w');
  return cs;
}

async function commitNow(key: string): Promise<void> {
  const cs = await draft(key);
  const plan = await config.plan(cs, 'w');
  await config.commit(cs, plan.id, 'w');
}

type Row = { id: string; state: string; ops: number; stale: boolean; etag: string; baseRevision: string; patch: unknown[] };

describe('변경 초안 — GET /api/v1/changesets', () => {
  it('open · sealed 만, 새 것부터. 커밋한 것 · 버린 것은 없다', async () => {
    await commitNow('done');
    const gone = await draft('gone');
    await config.discardChangeset(gone, 'w');
    const open = await draft('open-one');
    await new Promise((r) => setTimeout(r, 15));
    const sealed = await draft('sealed-one');
    await config.plan(sealed, 'w');

    const r = await call('GET', '/api/v1/changesets');
    expect(r.status).toBe(200);
    const rows = r.body as Row[];
    expect(rows.map((x) => x.id)).toEqual([sealed, open]);
    expect(rows.map((x) => x.state)).toEqual(['sealed', 'open']);
    expect(rows[1]).toMatchObject({ ops: 1, stale: false, patch: put('open-one') });

    const onlySealed = (await call('GET', '/api/v1/changesets?state=sealed')).body as Row[];
    expect(onlySealed.map((x) => x.id)).toEqual([sealed]);
    expect((await call('GET', '/api/v1/changesets?state=committed')).status).toBe(400);
  });

  it('줄의 etag 이 상세의 ETag 와 같고, 상세 본문에도 실린다', async () => {
    const cs = await draft('e');
    const row = ((await call('GET', '/api/v1/changesets')).body as Row[])[0]!;
    const one = await call('GET', `/api/v1/changesets/${cs}`);
    expect(one.etag).toBe(row.etag);
    expect((one.body as { etag: string }).etag).toBe(row.etag);
    // 남이 먼저 고쳤으면(etag 이 바뀌었으면) 412 다.
    await config.patchChangeset(cs, put('e2'), 'other');
    const stale = await call('PATCH', `/api/v1/changesets/${cs}`, { patch: put('e3') }, { 'if-match': row.etag });
    expect(stale.status).toBe(412);
    expect((stale.body as { code: string }).code).toBe('precondition_failed');
  });

  it('head 가 움직이면 stale 이고, 그대로 커밋하면 PLAN_STALE 이다', async () => {
    const cs = await draft('late');
    const plan = await config.plan(cs, 'w');
    await commitNow('first');
    const row = ((await call('GET', '/api/v1/changesets')).body as Row[]).find((x) => x.id === cs)!;
    expect(row.stale).toBe(true);
    const r = await call('POST', `/api/v1/changesets/${cs}/commit`, { plan_id: plan.id });
    expect(r.status).toBe(409);
    expect((r.body as { code: string }).code).toBe('PLAN_STALE');
    // 초안은 그대로 남는다(sealed) — 화면이 「최신 head 로 다시 계획」 을 한다.
    expect(((await call('GET', '/api/v1/changesets')).body as Row[]).some((x) => x.id === cs)).toBe(true);
  });
});

describe('최근 전환 — GET /api/v1/operations', () => {
  async function operation(phase: string, detail: unknown): Promise<string> {
    const cs = await draft(`op-${phase}`);
    const plan = await config.plan(cs, 'w');
    const head = await config.head();
    const id = randomUUID();
    await db.query(
      `INSERT INTO operations (id, plan_id, revision, activation_epoch, generation, phase, detail, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, plan.id, head.revision, '1', `r${head.revision}-e1`, phase, JSON.stringify(detail), 'w'],
    );
    return id;
  }

  it('새 것부터 · 시각 · 누가 · 종단 여부를 싣는다', async () => {
    const done = await operation('activated', { planes: ['http'], reload: true });
    await new Promise((r) => setTimeout(r, 15));
    const live = await operation('reload_intent', { planes: ['http'] });

    const r = await call('GET', '/api/v1/operations?limit=10');
    expect(r.status).toBe(200);
    const rows = r.body as { id: string; terminal: boolean; createdBy: string; createdAt: string; detail: unknown }[];
    expect(rows.map((x) => x.id)).toEqual([live, done]);
    expect(rows.map((x) => x.terminal)).toEqual([false, true]);
    expect(rows[0]?.createdBy).toBe('w');
    expect(Number.isNaN(Date.parse(rows[0]?.createdAt ?? ''))).toBe(false);
    expect(rows[1]?.detail).toEqual({ planes: ['http'], reload: true });

    const one = await call('GET', `/api/v1/operations/${live}`);
    expect(one.body).toMatchObject({ id: live, phase: 'reload_intent', terminal: false, createdBy: 'w' });
    expect((await call('GET', `/api/v1/operations/${randomUUID()}`)).status).toBe(404);
  });
});
