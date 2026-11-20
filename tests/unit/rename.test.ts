/**
 * 리소스 이름 바꾸기 (2026-11-20) — patch 의 `rename`.
 *
 * 저장소는 id 로 이어져 있어 key 만 바꾸면 참조가 따라온다. 그것을 실물(SQLite)로 잰다:
 * 참조하는 리소스가 새 이름을 보는가, key 로 묶인 곁 행(헬스 · 드레인)이 따라오는가,
 * `@주소집합` 참조(문자열)가 옮겨지는가, plan 이 「이름 변경」 으로만 말하는가.
 *
 * 모델 쪽 `renameInModel` 은 화면의 「연결된 리소스」(`edgesOf`)와 같은 참조를 따라야 한다 —
 * 모든 간선을 가진 모델로 두 함수를 맞대어 본다.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ConfigStore, StoreError, type PatchOp } from '../../src/store/config-store.js';
import type { Database } from '../../src/store/db.js';
import { openDbForTest } from '../../src/store/open.js';
import { renameInModel, type RenameKind } from '../../src/model/rename.js';
import { edgesOf } from '../../src/web/resources.js';
import type { Model } from '../../src/model/provisional.js';

const PUT = (kind: PatchOp['kind'], key: string, body: unknown): PatchOp => ({ op: 'put', kind, key, body });
const RENAME = (kind: PatchOp['kind'], key: string, to: string): PatchOp => ({ op: 'rename', kind, key, to });

const base: PatchOp[] = [
  PUT('pool', 'app', { protocolClass: 'http', algorithm: 'round_robin' }),
  PUT('backend', 'app-1', { pool: 'app', host: '10.0.0.1', port: 8080, weight: 1 }),
  PUT('addressSet', 'office', { cidrs: ['192.0.2.0/24'] }),
  PUT('listener', 'edge', {
    protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true,
    sourceAllow: ['@office', '10.0.0.0/8'],
    http: { defaultAction: { pool: 'app' } },
  }),
  PUT('httpRoute', 'api', {
    listener: 'edge', hosts: ['a.test'], priority: 0,
    action: { kind: 'proxy', pool: 'app', websocket: false },
    sourceRules: [{ from: ['@office'], action: { kind: 'proxy', pool: 'app', websocket: true } }],
  }),
];

let dir: string;
let db: Database;
let store: ConfigStore;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bary-rename-'));
  db = openDbForTest(`sqlite:${join(dir, 'bary.db')}`);
  await db.migrate();
  store = new ConfigStore(db);
});
afterAll(async () => {
  await db?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function planOf(ops: PatchOp[]): Promise<{ cs: string; plan: Awaited<ReturnType<ConfigStore['plan']>> }> {
  const head = await store.head();
  const cs = await store.createChangeset(head.revision, 't');
  await store.patchChangeset(cs, ops, 't');
  return { cs, plan: await store.plan(cs, 't') };
}
async function commitAll(ops: PatchOp[]): Promise<Model> {
  const { cs, plan } = await planOf(ops);
  const out = await store.commit(cs, plan.id, 't');
  return store.modelAt(out.revision);
}

describe('rename — 저장소 (SQLite)', () => {
  let current: Model;
  beforeEach(async () => {
    // 매번 깨끗한 상태로: 있던 것을 지우고 base 를 다시 넣는다.
    const m = await store.modelAt((await store.head()).revision);
    const del: PatchOp[] = [
      ...m.httpRoutes.map((r) => ({ op: 'delete' as const, kind: 'httpRoute' as const, key: r.key })),
      ...m.listeners.map((l) => ({ op: 'delete' as const, kind: 'listener' as const, key: l.key })),
      ...(m.addressSets ?? []).map((a) => ({ op: 'delete' as const, kind: 'addressSet' as const, key: a.key })),
      ...m.backends.map((b) => ({ op: 'delete' as const, kind: 'backend' as const, key: b.key })),
      ...m.pools.map((p) => ({ op: 'delete' as const, kind: 'pool' as const, key: p.key })),
    ];
    if (del.length > 0) await commitAll(del);
    current = await commitAll(base);
  });

  it('풀 이름을 바꾸면 백엔드 · 리스너 기본 동작 · 라우트 · 출발지 규칙이 새 이름을 본다', async () => {
    const m = await commitAll([RENAME('pool', 'app', 'web-01.dc1:shop:api')]);
    expect(m.pools.map((p) => p.key)).toEqual(['web-01.dc1:shop:api']);
    expect(m.backends[0]?.pool).toBe('web-01.dc1:shop:api');
    const edge = m.listeners.find((l) => l.key === 'edge') as unknown as { http: { defaultAction: { pool: string } } };
    expect(edge.http.defaultAction.pool).toBe('web-01.dc1:shop:api');
    const api = m.httpRoutes[0]!;
    expect((api.action as { pool: string }).pool).toBe('web-01.dc1:shop:api');
    expect((api.sourceRules?.[0]?.action as { pool: string }).pool).toBe('web-01.dc1:shop:api');
    expect(current.pools[0]?.key).toBe('app');
  });

  it('리스너 이름을 바꾸면 라우트가 따라오고, plan 은 「이름 변경」 으로만 말한다', async () => {
    const { plan } = await planOf([RENAME('listener', 'edge', 'edge:main')]);
    expect(plan.impact.renames).toEqual([{ kind: 'listener', from: 'edge', to: 'edge:main' }]);
    expect(plan.impact.affectedListeners).toEqual([]);
    expect(plan.impact.socketChanges).toEqual({ added: [], removed: [] });
    expect(plan.model.httpRoutes[0]?.listener).toBe('edge:main');
  });

  it('주소 집합 이름을 바꾸면 리스너 · 라우트 안의 `@이름` 이 옮겨진다', async () => {
    const m = await commitAll([RENAME('addressSet', 'office', 'site:hq:v4')]);
    expect(m.addressSets?.map((a) => a.key)).toEqual(['site:hq:v4']);
    expect(m.listeners.find((l) => l.key === 'edge')?.sourceAllow).toEqual(['@site:hq:v4', '10.0.0.0/8']);
    expect(m.httpRoutes[0]?.sourceRules?.[0]?.from).toEqual(['@site:hq:v4']);
  });

  it('백엔드 이름을 바꾸면 헬스 · 드레인 상태가 따라온다', async () => {
    await db.query(`INSERT INTO backend_health (backend_key, state, consecutive) VALUES ('app-1', 'unhealthy', 3)`);
    await commitAll([RENAME('backend', 'app-1', 'web-01.dc1:shop:api:01')]);
    const rows = (await db.query('SELECT backend_key, state FROM backend_health')).rows;
    expect(rows).toEqual([{ backend_key: 'web-01.dc1:shop:api:01', state: 'unhealthy' }]);
  });

  it('바꾼 이름을 같은 changeset 에서 바로 쓸 수 있다', async () => {
    const m = await commitAll([
      RENAME('pool', 'app', 'app:v2'),
      PUT('backend', 'app-2', { pool: 'app:v2', host: '10.0.0.2', port: 8080, weight: 1 }),
    ]);
    expect(m.backends.map((b) => [b.key, b.pool])).toEqual([['app-1', 'app:v2'], ['app-2', 'app:v2']]);
  });

  it('새 이름이 이미 있으면 409 · 없는 이름이면 409 · 규칙 밖 이름 · engine · 같은 이름은 400', async () => {
    await expect(planOf([RENAME('listener', 'edge', 'edge')])).rejects.toMatchObject({ status: 400 });
    await expect(planOf([RENAME('pool', 'app', 'a::b')])).rejects.toMatchObject({ status: 400 });
    await expect(planOf([RENAME('engine', 'engine', 'x')])).rejects.toMatchObject({ status: 400 });
    await expect(planOf([PUT('pool', 'other', { protocolClass: 'http', algorithm: 'round_robin' }), RENAME('pool', 'app', 'other')]))
      .rejects.toMatchObject({ status: 409, code: 'key_taken' });
    await expect(planOf([RENAME('pool', 'nope', 'x')])).rejects.toMatchObject({ status: 409, code: 'not_found' });
    await expect(planOf([{ op: 'move', kind: 'pool', key: 'app' } as unknown as PatchOp])).rejects.toBeInstanceOf(StoreError);
  });
});

describe('renameInModel — 화면의 참조(edgesOf)와 같은 것을 따른다', () => {
  /** 모든 간선을 가진 모델. 모양 검사를 지나지 않는다 — 참조를 따르는지만 본다. */
  const full = {
    pools: [{ key: 'P', upstreamTls: { enabled: true, caBundle: 'C' } }],
    backends: [{ key: 'B', pool: 'P' }],
    certificates: [{ key: 'C' }],
    tlsPolicies: [{ key: 'T' }],
    addressSets: [{ key: 'S', cidrs: ['192.0.2.0/24'] }],
    listeners: [
      {
        key: 'L', http: { defaultAction: { pool: 'P' } }, defaultPool: 'P', onUnmatchedSni: { pool: 'P' }, onNoSni: { pool: 'P' },
        tls: { policy: 'T', defaultCertificate: 'C' },
        sourceAllow: ['@S'], acceptProxyProtocol: { trustedCidrs: ['@S'] }, realIpFromHeader: { trustedCidrs: ['@S'] },
      },
    ],
    httpRoutes: [{ key: 'H', listener: 'L', action: { kind: 'proxy', pool: 'P' }, sourceRules: [{ from: ['@S'], action: { pool: 'P' } }] }],
    passthroughRoutes: [{ key: 'R', listener: 'L', action: { kind: 'proxy', pool: 'P' }, sourceRules: [{ from: ['@S'], action: { pool: 'P' } }] }],
    sniBindings: [{ key: 'N', listener: 'L', certificate: 'C' }],
  } as unknown as Model;

  const targets = new Map<RenameKind, string>([
    ['pool', 'P'], ['backend', 'B'], ['certificate', 'C'], ['tlsPolicy', 'T'], ['addressSet', 'S'],
    ['listener', 'L'], ['httpRoute', 'H'], ['passthroughRoute', 'R'], ['sniBinding', 'N'],
  ]);

  for (const [kind, key] of targets) {
    it(`${kind} — 옛 이름을 가리키는 간선이 남지 않고, 같은 수가 새 이름을 가리킨다`, () => {
      const before = edgesOf(full as never).filter((e) => e.to.kind === kind && e.to.key === key).length;
      const after = edgesOf(renameInModel(full, { kind, from: key, to: `${key}:new` }) as never);
      expect(after.filter((e) => e.to.kind === kind && e.to.key === key)).toEqual([]);
      expect(after.filter((e) => e.to.kind === kind && e.to.key === `${key}:new`)).toHaveLength(before);
      // 간선 수는 그대로다 — 다른 참조를 건드리지 않았다.
      expect(after).toHaveLength(edgesOf(full as never).length);
    });
  }

  it('들어온 모델은 바꾸지 않는다', () => {
    const copy = structuredClone(full);
    renameInModel(full, { kind: 'pool', from: 'P', to: 'Q' });
    expect(full).toEqual(copy);
  });
});

describe('CLI · 화면의 이름 바꾸기 조각', () => {
  it('`bary rename` 의 종류 이름이 patch 의 종류가 된다 — 모르는 종류는 쓸 수 있는 것을 말한다', async () => {
    const { renameKindOf } = await import('../../src/cli/rename.js');
    expect(renameKindOf('http-route')).toBe('httpRoute');
    expect(renameKindOf('address-set')).toBe('addressSet');
    expect(() => renameKindOf('engine')).toThrow(/listener · pool/);
  });

  it('`renamePatch` 는 한 줄이고, 빈 이름 · 같은 이름은 거절한다', async () => {
    const { renamePatch } = await import('../../src/web/edit.js');
    expect(renamePatch('pool', 'app', ' app:v2 ')).toEqual([{ op: 'rename', kind: 'pool', key: 'app', to: 'app:v2' }]);
    expect(() => renamePatch('pool', 'app', 'app')).toThrow();
    expect(() => renamePatch('pool', 'app', ' ')).toThrow();
  });

  it('적용 화면이 「이름 변경」 줄을 낸다', async () => {
    const { viewOfImpact } = await import('../../src/web/impact-view.js');
    const v = viewOfImpact({ planId: 'p', revision: '2' }, {
      requiresReload: true, affectedListeners: [], socketChanges: { added: [], removed: [] }, planes: ['http'],
      renames: [{ kind: 'pool', from: 'app', to: 'app:v2' }],
    });
    expect(v.renames).toEqual(['풀 app → app:v2']);
  });
});
