/**
 * 검수 2026-08-22 · B-03 — **리소스를 지우는 복구가 FK 를 안 깬다**
 *
 * `importPatch` 는 `have` 맵의 삽입 순서, 즉 `pool → backend → certificate → tlsPolicy →
 * listener → route …` 순으로 delete 를 만든다. 그런데 DDL 은 반대 방향이다:
 *
 *   listeners.default_pool_id → pools           ON DELETE RESTRICT
 *   http_routes.listener_id   → listeners       ON DELETE RESTRICT
 *   backends.pool_id          → pools           ON DELETE CASCADE
 *
 * 그래서 **리소스를 지우는 `replace` import 와 `POST /restore` 가 첫 delete 에서 죽는다.**
 * CASCADE 쪽은 더 조용하다 — 풀을 먼저 지우면 백엔드가 딸려 가고, 그 다음 백엔드 delete
 * 가 "없다" 로 409 를 낸다.
 *
 * 같은 파일의 `rollbackTo` 는 라우트 → 리스너 → 풀 순서로 **정확히 반대로** 지운다.
 * 코드베이스가 올바른 순서를 알고 있는데 이 경로만 안 맞춘 것이다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ConfigStore, type PatchOp } from '../../src/store/config-store.js';
import { exportManifest, importPatch, type Manifest } from '../../src/store/manifest.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('audit-restore');

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

const EMPTY: Manifest = { schemaVersion: '1', resources: [] };

async function commitAll(ops: PatchOp[]): Promise<string> {
  const head = await store.head();
  const cs = await store.createChangeset(head.revision, 'tester');
  await store.patchChangeset(cs, ops, 'tester');
  const plan = await store.plan(cs, 'tester');
  return (await store.commit(cs, plan.id, 'tester')).revision;
}

const withListener: PatchOp[] = [
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

describe('복구의 삭제 순서 (검수 B-03)', () => {
  it('리소스를 지우는 복구가 FK 를 안 깬다', async () => {
    await commitAll(withListener);

    // 빈 매니페스트로 replace — 전부 지워져야 한다. 이게 `POST /restore` 의 경로다.
    const out = await store.importFromManifest(EMPTY, 'replace', 'restorer');
    expect(out.unchanged).toBe(false);

    const model = await store.modelAt(out.revision);
    expect(model.listeners).toEqual([]);
    expect(model.pools).toEqual([]);
    expect(model.backends).toEqual([]);
  });

  it('CASCADE 로 딸려 간 백엔드를 다시 지우려 들지 않는다', async () => {
    // `backends.pool_id` 는 CASCADE 다. 풀을 먼저 지우면 백엔드가 함께 사라지고,
    // 그 다음 백엔드 delete 가 `not_found` 로 409 를 낸다 — FK 위반과 다른 증상이라
    // 따로 잰다.
    await commitAll([
      { op: 'put', kind: 'pool', key: 'app', body: { protocolClass: 'tcp', algorithm: 'round_robin' } },
      { op: 'put', kind: 'backend', key: 'a-11', body: { pool: 'app', host: '10.0.0.1', port: 11, weight: 1 } },
      {
        op: 'put', kind: 'listener', key: 'l4', body: {
          protocol: 'tcp', bind: '0.0.0.0', port: 998, enabled: true, defaultPool: 'app',
        },
      },
    ]);

    const out = await store.importFromManifest(EMPTY, 'replace', 'restorer');
    expect((await store.modelAt(out.revision)).backends).toEqual([]);
  });

  it('삭제는 참조하는 쪽부터 나온다 — 순수 함수로 직접 잰다', () => {
    // 위 둘은 결과를 보고, 이건 **순서 자체**를 본다. DB 없이도 회귀가 잡힌다.
    const current = {
      listeners: [{
        key: 'front', protocol: 'http' as const, bind: '0.0.0.0', port: 999, enabled: true,
        http: { defaultAction: { pool: 'app' } },
      }],
      httpRoutes: [], passthroughRoutes: [],
      pools: [{ key: 'app', protocolClass: 'http' as const, algorithm: 'round_robin' as const }],
      backends: [{ key: 'a-11', pool: 'app', host: '10.0.0.1', port: 11, weight: 1 }],
      certificates: [], tlsPolicies: [], sniBindings: [],
    };
    const ops = importPatch(current, EMPTY, 'replace');
    const order = ops.map((o) => o.kind);

    expect(order.indexOf('listener')).toBeLessThan(order.indexOf('pool'));
    expect(order.indexOf('backend')).toBeLessThan(order.indexOf('pool'));
    // 지우는 것 말고는 없다.
    expect(ops.every((o) => o.op === 'delete')).toBe(true);
  });

  it('두 번째 복구는 리비전을 안 올린다', async () => {
    await commitAll(withListener);
    const manifest = exportManifest(await store.modelAt((await store.head()).revision));
    const again = await store.importFromManifest(manifest, 'replace', 'restorer');
    expect(again.unchanged).toBe(true);
  });
});
