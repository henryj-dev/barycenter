/**
 * 주소 집합 — 저장소 (#114)
 *
 *   · 같은 변경 안에서 집합을 먼저, 리스너를 나중에 넣으면 저장된다
 *   · **집합만 바꿔도 그 집합을 쓰는 리스너가 영향 목록에 오른다** — 리스너는 그대로인데
 *     렌더가 바뀌기 때문이다. 안 쓰는 리스너는 안 오른다
 *   · 참조하는 리스너가 있는 집합은 지울 수 없다 (plan 이 막는다)
 *   · 롤백이 집합을 되돌린다
 *
 *   npm run test:store     (도커 필요)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ConfigStore, type PatchOp } from '../../src/store/config-store.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('address-sets');

let db: Db;
let store: ConfigStore;

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 이 스위트는 실물 PG 를 쓴다');
  startPg(PG);
  db = new Db(PG.dsn);
  await db.migrate();
  store = new ConfigStore(db);
}, 180_000);

afterAll(async () => {
  await db?.close();
  stopPg(PG);
});

beforeEach(async () => {
  await reset(db);
});

const PUT = (kind: PatchOp extends { kind: infer K } ? K : never, key: string, body: unknown): PatchOp =>
  ({ op: 'put', kind, key, body });

const base: PatchOp[] = [
  PUT('pool', 'app', { protocolClass: 'http', algorithm: 'round_robin' }),
  PUT('backend', 'app-1', { pool: 'app', host: '10.0.0.1', port: 8080, weight: 1 }),
  PUT('addressSet', 'cloudflare', { cidrs: ['173.245.48.0/20', '2400:cb00::/32'], source: 'cloudflare' }),
  PUT('listener', 'edge', {
    protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true,
    sourceAllow: ['@cloudflare'],
    realIpFromHeader: { header: 'CF-Connecting-IP', trustedCidrs: ['@cloudflare'] },
    http: { defaultAction: { pool: 'app' } },
  }),
  PUT('listener', 'open', {
    protocol: 'http', bind: '0.0.0.0', port: 8080, enabled: true,
    http: { defaultAction: { pool: 'app' } },
  }),
];

async function commitAll(ops: PatchOp[]): Promise<string> {
  const head = await store.head();
  const cs = await store.createChangeset(head.revision, 't');
  await store.patchChangeset(cs, ops, 't');
  const plan = await store.plan(cs, 't');
  return (await store.commit(cs, plan.id, 't')).revision;
}

async function planOf(ops: PatchOp[]): Promise<Awaited<ReturnType<ConfigStore['plan']>>> {
  const head = await store.head();
  const cs = await store.createChangeset(head.revision, 't');
  await store.patchChangeset(cs, ops, 't');
  return store.plan(cs, 't');
}

describe('주소 집합', () => {
  it('저장하고 그대로 읽는다 — 참조는 문자열 그대로', async () => {
    const rev = await commitAll(base);
    const m = await store.modelAt(rev);
    expect(m.addressSets).toEqual([{ key: 'cloudflare', cidrs: ['173.245.48.0/20', '2400:cb00::/32'], source: 'cloudflare' }]);
    expect(m.listeners.find((l) => l.key === 'edge')?.sourceAllow).toEqual(['@cloudflare']);
  });

  it('**집합만 바꿔도 그것을 쓰는 리스너가 영향받는다** — 안 쓰는 리스너는 아니다', async () => {
    await commitAll(base);
    const plan = await planOf([
      PUT('addressSet', 'cloudflare', { cidrs: ['173.245.48.0/20', '2400:cb00::/32', '103.21.244.0/22'], source: 'cloudflare' }),
    ]);
    expect(plan.impact.affectedListeners.map((a) => a.key)).toEqual(['edge']);
  });

  it('참조하는 리스너가 있는 집합은 지울 수 없다', async () => {
    await commitAll(base);
    await expect(planOf([{ op: 'delete', kind: 'addressSet', key: 'cloudflare' }]))
      .rejects.toThrow(/cloudflare/);
  });

  it('롤백이 집합을 되돌린다', async () => {
    const first = await commitAll(base);
    await commitAll([PUT('addressSet', 'cloudflare', { cidrs: ['10.0.0.0/8'] })]);
    const back = await store.rollbackTo(first, 't');
    const m = await store.modelAt(back.revision);
    expect(m.addressSets?.[0]?.cidrs).toEqual(['173.245.48.0/20', '2400:cb00::/32']);
  });
});
