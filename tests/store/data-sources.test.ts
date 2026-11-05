/**
 * 데이터 공급 — 저장소 · API (2026-11-05).
 *
 *   · **옛 저장값** — 033 전에 쓰인 `address_sets.source = 'cloudflare'` 행이 그대로 읽히고, 옵션 칸이 안 생긴다
 *   · 풀의 `discovery` · 집합의 `sourceOptions` 가 저장 → 읽기를 왕복한다
 *   · 주기 갱신은 **바뀐 때만 커밋한다** — 같은 집합(순서만 다름)이면 리비전이 안 생긴다. 바뀌면 `address-source` 가
 *     커밋하고 감사에 남는다. 받기가 실패하면 집합은 그대로이고 기록에 사유가 남는다
 *   · API — `POST /address-sets/:id/refresh` · `GET /address-sets/refresh-status` · `GET /pools/:id/discovery`
 *
 *   npm run test:store     (도커 필요)
 */
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { TokenAuth } from '../../src/api/auth.js';
import { createApi } from '../../src/api/server.js';
import { refreshAddressSet, refreshRows } from '../../src/control/address-sources/refresh.js';
import type { AddressSources } from '../../src/control/address-sources/registry.js';
import type { AddressFetchResult } from '../../src/control/address-sources/source.js';
import { LeaderElection } from '../../src/control/leader.js';
import { ControlPlane } from '../../src/control/plane.js';
import type { DataplaneDriver } from '../../src/dp/driver.js';
import { ConfigStore, type PatchOp } from '../../src/store/config-store.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('data-sources');
/** 시험의 가짜 토큰 — 실행 중에 만든다. */
const TOKEN = ['data', 'sources', 'test'].join('-');

let db: Db;
let store: ConfigStore;
let server: import('node:http').Server;
let base = '';
/** API 가 쓰는 출처 — 시험마다 답을 바꾼다. */
let answer: AddressFetchResult = { ok: false, reason: 'unavailable', detail: '아직' };
const sources: AddressSources = (kind) => ({ kind: kind as 'cloudflare', fetch: async () => answer });

const driver: DataplaneDriver = new Proxy({} as DataplaneDriver, {
  get: (_t, prop) => () => { throw new Error(`이 테스트는 데이터 플레인을 안 태운다 (호출됨: ${String(prop)})`); },
});

const PUT = (kind: PatchOp extends { kind: infer K } ? K : never, key: string, body: unknown): PatchOp =>
  ({ op: 'put', kind, key, body } as PatchOp);

async function commitAll(ops: PatchOp[]): Promise<string> {
  const head = await store.head();
  const cs = await store.createChangeset(head.revision, 't');
  await store.patchChangeset(cs, ops, 't');
  const plan = await store.plan(cs, 't');
  return (await store.commit(cs, plan.id, 't')).revision;
}

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return { status: r.status, body: text === '' ? null : JSON.parse(text) };
}

const seed: PatchOp[] = [
  PUT('pool', 'app', { protocolClass: 'http', algorithm: 'round_robin', discovery: { source: 'consul', query: 'api', emptyMeans: 'empty' } }),
  PUT('backend', 'app-1', { pool: 'app', host: '10.0.0.1', port: 8080, weight: 1 }),
  PUT('addressSet', 'cf', { cidrs: ['173.245.48.0/20', '2400:cb00::/32'], source: 'cloudflare' }),
  PUT('addressSet', 'aws-cf', {
    cidrs: ['13.32.0.0/15'], source: 'aws', sourceOptions: { services: ['CLOUDFRONT'], family: 'ipv4' },
  }),
  PUT('listener', 'edge', {
    protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true, sourceAllow: ['@cf', '@aws-cf'],
    http: { defaultAction: { pool: 'app' } },
  }),
];

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 실물 PG 를 쓴다');
  startPg(PG);
  db = new Db(PG.dsn);
  await db.migrate();
  store = new ConfigStore(db, { streamRealip: false });
  const election = new LeaderElection(PG.dsn, 'data-sources-test');
  if (!(await election.tryAcquire())) throw new Error('리더 획득 실패');
  const control = new ControlPlane(db, store, driver, election, { prefix: '/tmp/bary-ds-test', adminSocket: '/tmp/bary-ds.sock' });
  const hash = createHash('sha256').update(TOKEN).digest('hex');
  const auth = new TokenAuth([{ name: 'tester', hash: `sha256:${hash}`, scopes: ['read', 'write', 'apply'] }]);
  server = createApi({
    db, store, control, auth, election, addressSources: sources,
    discovery: {
      enabled: true, intervalMs: 30_000,
      views: () => [],
      view: (p) => (p === 'app'
        ? { pool: 'app', source: 'consul', query: 'api', state: 'ok', advertised: true, endpoints: [{ host: '10.1.0.1', port: 8080 }] }
        : undefined),
    },
  });
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
});

describe('저장 · 호환', () => {
  it('옛 cloudflare 행이 그대로 읽힌다 — 033 전에 쓰인 모양', async () => {
    await commitAll(seed);
    // 033 전의 쓰기를 흉내 낸다: source_options 없이, source 만.
    await db.query(`UPDATE address_sets SET source_options = NULL WHERE key = 'cf'`);
    const model = await store.modelAt((await store.head()).revision);
    const cf = model.addressSets?.find((s) => s.key === 'cf');
    expect(cf).toEqual({ key: 'cf', cidrs: ['173.245.48.0/20', '2400:cb00::/32'], source: 'cloudflare' });
  });

  it('풀의 discovery · 집합의 sourceOptions 가 왕복한다', async () => {
    const rev = await commitAll(seed);
    const model = await store.modelAt(rev);
    expect(model.pools.find((p) => p.key === 'app')?.discovery).toEqual({ source: 'consul', query: 'api', emptyMeans: 'empty' });
    expect(model.addressSets?.find((s) => s.key === 'aws-cf')).toEqual({
      key: 'aws-cf', cidrs: ['13.32.0.0/15'], source: 'aws', sourceOptions: { services: ['CLOUDFRONT'], family: 'ipv4' },
    });
    // head 행(표)에서 다시 읽어도 같다 — 스냅샷만 맞고 표가 틀린 것을 잡는다.
    const row = (await db.query(`SELECT discovery FROM pools WHERE key='app'`)).rows[0];
    expect(row?.['discovery']).toEqual({ source: 'consul', query: 'api', emptyMeans: 'empty' });
  });

  it('DB 도 모르는 모양의 출처 이름을 막는다', async () => {
    await commitAll(seed);
    await expect(db.query(`UPDATE address_sets SET source = 'Bad Name' WHERE key = 'cf'`)).rejects.toThrow(/address_set_source/);
    await expect(db.query(`UPDATE address_sets SET source = NULL WHERE key = 'aws-cf'`)).rejects.toThrow(/address_set_source_options/);
  });
});

describe('다시 받기는 바뀐 때만 커밋한다', () => {
  const opts = (fetched: AddressFetchResult) => ({
    db, store, by: 'address-source', sources: ((kind: string) => ({ kind, fetch: async () => fetched })) as unknown as AddressSources,
  });

  it('같은 집합(순서만 다름)이면 리비전이 안 생긴다 · 기록은 남는다', async () => {
    const rev = await commitAll(seed);
    const out = await refreshAddressSet(opts({ ok: true, cidrs: ['2400:cb00::/32', '173.245.48.0/20'] }), 'cf');
    expect(out).toEqual({ key: 'cf', outcome: 'unchanged', count: 2 });
    expect((await store.head()).revision).toBe(rev);
    const [row] = await refreshRows(db, ['cf']);
    expect(row).toMatchObject({ key: 'cf', ok: true, by: 'address-source' });
    expect(row?.refreshedAt).toBeDefined();
  });

  it('바뀌면 시스템이 커밋하고 감사에 남는다 · 출처 · 옵션을 지킨다', async () => {
    const rev = await commitAll(seed);
    const out = await refreshAddressSet(opts({ ok: true, cidrs: ['13.32.0.0/15', '13.35.0.0/16'] }), 'aws-cf');
    expect(out).toMatchObject({ key: 'aws-cf', outcome: 'committed', count: 2 });
    const head = await store.head();
    expect(BigInt(head.revision)).toBe(BigInt(rev) + 1n);
    const set = (await store.modelAt(head.revision)).addressSets?.find((s) => s.key === 'aws-cf');
    expect(set).toEqual({
      key: 'aws-cf', cidrs: ['13.32.0.0/15', '13.35.0.0/16'], source: 'aws', sourceOptions: { services: ['CLOUDFRONT'], family: 'ipv4' },
    });
    const audit = (await db.query(`SELECT principal FROM audit WHERE action = 'changeset.commit' ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(audit?.['principal']).toBe('address-source');
    const [row] = await refreshRows(db, ['aws-cf']);
    expect(row).toMatchObject({ ok: true, revision: head.revision });
  });

  it('받기가 실패하면 집합은 그대로 · 기록에 사유 · 마지막 갱신은 앞의 성공 그대로', async () => {
    const rev = await commitAll(seed);
    await refreshAddressSet(opts({ ok: true, cidrs: ['173.245.48.0/20', '2400:cb00::/32'] }), 'cf');
    const [before] = await refreshRows(db, ['cf']);
    const out = await refreshAddressSet(opts({ ok: false, reason: 'unavailable', detail: '503' }), 'cf');
    expect(out).toEqual({ key: 'cf', outcome: 'failed', reason: 'unavailable', detail: '503' });
    expect((await store.head()).revision).toBe(rev);
    const [after] = await refreshRows(db, ['cf']);
    expect(after).toMatchObject({ ok: false, reason: 'unavailable', detail: '503', refreshedAt: before?.refreshedAt });
  });
});

describe('API', () => {
  it('POST /address-sets/:id/refresh — 바뀌면 커밋, 같으면 unchanged, 실패는 502, 출처 없음 409', async () => {
    await commitAll([...seed, PUT('addressSet', 'manual', { cidrs: ['10.0.0.0/8'] })]);
    answer = { ok: true, cidrs: ['173.245.48.0/20', '2400:cb00::/32', '103.21.244.0/22'] };
    const changed = await req('POST', '/api/v1/address-sets/cf/refresh', {});
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ key: 'cf', outcome: 'committed', count: 3 });
    expect((await req('POST', '/api/v1/address-sets/cf/refresh', {})).body).toMatchObject({ outcome: 'unchanged' });

    answer = { ok: false, reason: 'unavailable', detail: '닿지 못했다' };
    const failed = await req('POST', '/api/v1/address-sets/cf/refresh', {});
    expect(failed).toEqual({ status: 502, body: { error: 'address_source_failed', reason: 'unavailable', message: '닿지 못했다' } });
    expect((await req('POST', '/api/v1/address-sets/manual/refresh', {})).status).toBe(409);
    expect((await req('POST', '/api/v1/address-sets/none/refresh', {})).status).toBe(404);

    const status = await req('GET', '/api/v1/address-sets/refresh-status');
    expect(status.body.map((r: { key: string; ok: boolean }) => [r.key, r.ok])).toEqual([['cf', false]]);
    expect(status.body[0].refreshedAt).toBeDefined();
  });

  it('GET /pools/:id/discovery — 러너의 것 · 정적이면 source null · 없으면 404', async () => {
    await commitAll([...seed, PUT('pool', 'other', { protocolClass: 'http', algorithm: 'round_robin' }),
      PUT('backend', 'o-1', { pool: 'other', host: '10.0.0.2', port: 80, weight: 1 })]);
    expect((await req('GET', '/api/v1/pools/app/discovery')).body).toMatchObject({ state: 'ok', advertised: true });
    expect((await req('GET', '/api/v1/pools/other/discovery')).body).toEqual({ pool: 'other', source: null });
    expect((await req('GET', '/api/v1/pools/none/discovery')).status).toBe(404);
    expect((await req('GET', '/api/v1/discovery')).body).toEqual({ enabled: true, intervalMs: 30_000, pools: [] });
  });
});
