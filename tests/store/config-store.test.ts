/**
 * 정본 저장소 — changeset → plan → commit (DESIGN.md §5.3, §4.0)
 *
 * v0.1 완료 판정의 절반이 여기 있다: **"모순 조합은 저장이 거부된다."** 나머지 절반
 * (`curl :999 → A:11`)은 e2e 가 진다.
 *
 *   npm run test:store     (도커 필요)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ConfigStore, StoreError, type PatchOp } from '../../src/store/config-store.js';
import { Db, DSN, dockerAvailable, reset, startPg, stopPg } from './pg-fixture.js';

let db: Db;
let store: ConfigStore;

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 이 스위트는 실물 PG 를 쓴다');
  startPg();
  db = new Db(DSN);
  await db.migrate();
  store = new ConfigStore(db);
}, 180_000);

afterAll(async () => {
  await db?.close();
  stopPg();
});

beforeEach(async () => {
  await reset(db);
});

const PUT = (kind: PatchOp extends { kind: infer K } ? K : never, key: string, body: unknown): PatchOp =>
  ({ op: 'put', kind, key, body });

/** `:999 → A:11` 을 만드는 최소 패치. v0.1 완료 판정의 그 모양이다. */
const minimal: PatchOp[] = [
  PUT('pool', 'app', { protocolClass: 'http', algorithm: 'round_robin' }),
  PUT('backend', 'a-11', { pool: 'app', host: '10.0.0.1', port: 11, weight: 1 }),
  PUT('listener', 'front', {
    protocol: 'http', bind: '0.0.0.0', port: 999, enabled: true,
    http: { defaultAction: { pool: 'app' } },
  }),
];

/** changeset 하나를 열고 커밋까지 밀어붙인다. */
async function commitAll(ops: PatchOp[], by = 'tester'): Promise<{
  revision: string; activationEpoch: string; planId: string;
}> {
  const head = await store.head();
  const cs = await store.createChangeset(head.revision, by);
  await store.patchChangeset(cs, ops, by);
  const plan = await store.plan(cs, by);
  const out = await store.commit(cs, plan.id, by);
  return { ...out, planId: plan.id };
}

describe('정본 저장소', () => {
  it('빈 저장소의 head 는 최초 리비전이다', async () => {
    const head = await store.head();
    expect(head.revision).toBe('1');
    expect(head.etag).toBe('"r1"');
    expect(await store.modelAt('1')).toEqual({
      listeners: [], httpRoutes: [], passthroughRoutes: [], pools: [], backends: [],
    });
  });

  it('changeset 한 바퀴가 head 를 앞으로 옮긴다', async () => {
    const { revision } = await commitAll(minimal);
    expect(revision).toBe('2');
    expect((await store.head()).revision).toBe('2');

    const model = await store.modelAt('2');
    expect(model.pools.map((p) => p.key)).toEqual(['app']);
    expect(model.backends).toEqual([
      { key: 'a-11', pool: 'app', host: '10.0.0.1', port: 11, weight: 1 },
    ]);
    expect(model.listeners[0]).toMatchObject({ key: 'front', protocol: 'http', port: 999 });
  });

  it('**리비전은 불변 스냅샷이다** — 뒤에 뭘 해도 옛 리비전은 그대로다', async () => {
    await commitAll(minimal);
    await commitAll([PUT('backend', 'a-12', { pool: 'app', host: '10.0.0.2', port: 12, weight: 1 })]);
    // 롤백 자료가 되려면 이게 참이어야 한다 (§7.2 가 세대를 자기완결적으로 만든 것과 같은 이유).
    expect((await store.modelAt('2')).backends.map((b) => b.key)).toEqual(['a-11']);
    expect((await store.modelAt('3')).backends.map((b) => b.key)).toEqual(['a-11', 'a-12']);
  });

  describe('§5.3 단회 lifecycle', () => {
    it('sealed 이후의 PATCH 는 409 다', async () => {
      const head = await store.head();
      const cs = await store.createChangeset(head.revision, 't');
      await store.patchChangeset(cs, minimal, 't');
      await store.plan(cs, 't');
      await expect(store.patchChangeset(cs, minimal, 't')).rejects.toMatchObject({
        status: 409, code: 'changeset_not_open',
      });
    });

    it('reopen 하면 다시 고칠 수 있고 **옛 plan 은 죽는다**', async () => {
      const head = await store.head();
      const cs = await store.createChangeset(head.revision, 't');
      await store.patchChangeset(cs, minimal, 't');
      const stale = await store.plan(cs, 't');
      await store.reopen(cs, 't');
      await store.patchChangeset(cs, [], 't');   // 이제 열려 있다

      // 죽이지 않으면 reopen 뒤에 옛 plan_id 로 커밋하는 재생 경로가 남는다.
      expect((await store.getPlan(stale.id)).state).toBe('expired');
      await expect(store.commit(cs, stale.id, 't')).rejects.toMatchObject({
        status: 409, code: 'PLAN_STALE',
      });
    });

    it('**plan_id 는 단회 소비다** — 같은 것으로 두 번 커밋할 수 없다', async () => {
      const head = await store.head();
      const cs = await store.createChangeset(head.revision, 't');
      await store.patchChangeset(cs, minimal, 't');
      const plan = await store.plan(cs, 't');
      await store.commit(cs, plan.id, 't');
      // **메시지까지 본다.** 코드만 보면 이 테스트는 단회 소비가 아니라 `head_moved` 가
      // 잡아도 초록이다 — 커밋하면 head 는 반드시 움직이므로 두 검사가 같은 무대에
      // 겹쳐 있다. 실제로 단회 소비 검사를 빼 봤더니 이 테스트가 안 깨졌다.
      // 어느 쪽이 막았는지 구분하지 않으면 그건 이름만 그럴듯한 테스트다.
      await expect(store.commit(cs, plan.id, 't')).rejects.toThrow(/단회 소비/);
    });

    it('**head 가 움직이면 커밋이 막힌다** (head_moved)', async () => {
      const head = await store.head();
      const a = await store.createChangeset(head.revision, 't');
      const b = await store.createChangeset(head.revision, 't');
      await store.patchChangeset(a, minimal, 't');
      await store.patchChangeset(b, [PUT('pool', 'other', {
        protocolClass: 'tcp', algorithm: 'round_robin',
      })], 't');
      const pa = await store.plan(a, 't');
      const pb = await store.plan(b, 't');

      await store.commit(a, pa.id, 't');
      // b 는 같은 base 위에 앉아 있었다. 통과시키면 a 의 변경 위에 b 가 겹쳐 앉는다.
      // b 자신의 plan 은 아직 `planned` 이므로 여기서 무는 것은 **오직 head 검사**다.
      await expect(store.commit(b, pb.id, 't')).rejects.toThrow(/head 가 움직였다/);
    });

    it('예약은 **커밋 순간**에 일어난다 — plan 시점에는 없다', async () => {
      const head = await store.head();
      const cs = await store.createChangeset(head.revision, 't');
      await store.patchChangeset(cs, minimal, 't');
      const plan = await store.plan(cs, 't');
      expect(plan.targetRevision).toBeUndefined();
      expect(plan.activationEpoch).toBeUndefined();

      await store.commit(cs, plan.id, 't');
      const after = await store.getPlan(plan.id);
      expect(after.state).toBe('committed');
      expect(after.targetRevision).toBe('2');
      expect(after.activationEpoch).toBe('1');
    });

    it('**`activation_epoch` 는 리비전과 별개로 앞으로만 간다** (§3.3-1)', async () => {
      const first = await commitAll(minimal);
      const second = await commitAll([
        PUT('backend', 'a-12', { pool: 'app', host: '10.0.0.2', port: 12, weight: 1 }),
      ]);
      expect(BigInt(second.activationEpoch) > BigInt(first.activationEpoch)).toBe(true);

      // 롤백은 옛 **내용**으로 새 리비전을 만든다. epoch 는 그와 무관하게 계속 앞으로 간다
      // — S19 가 실물로 확인한 규칙이다. 한 시퀀스를 공유하면 여기서 둘이 얽힌다.
      const rolled = await commitAll([{ op: 'delete', kind: 'backend', key: 'a-12' }]);
      expect(BigInt(rolled.activationEpoch) > BigInt(second.activationEpoch)).toBe(true);
      expect(await store.modelAt(rolled.revision)).toEqual(await store.modelAt(first.revision));
    });
  });

  describe('모순 조합은 저장이 거부된다 (v0.1 완료 판정)', () => {
    it('UDP 리스너에 acceptProxyProtocol — 5차 반례', async () => {
      const head = await store.head();
      const cs = await store.createChangeset(head.revision, 't');
      // 판별 유니온이 **표현 자체를 막는다**. 해독 단계에서 400 이다.
      await expect(store.patchChangeset(cs, [PUT('listener', 'u', {
        protocol: 'udp', bind: '0.0.0.0', port: 53, enabled: true,
        defaultPool: 'p', udp: { preset: 'dns' }, acceptProxyProtocol: true,
      })], 't')).rejects.toMatchObject({ status: 400, code: 'malformed' });
    });

    /**
     * **누가 무는지 재 봤다.** 코드는 `constraint_violation`(23514 CHECK) 이지
     * `reference_violation`(23503 FK) 이 아니다.
     *
     * 애플리케이션 경로에서는 `applyOp` 가 풀의 **진짜** 클래스를 읽어 쓰므로 거짓말이
     * 안 생기고, 그래서 무는 것은 `http_route_pool_is_http` CHECK 다. 복합 FK 는 **클래스를
     * 속였을 때**의 방벽이라 여기서는 안 걸린다 — 두 장치가 각각 다른 것을 막는다.
     * "복합 FK 가 잡는다" 고 적어 뒀다면 거짓 서사였을 것이다.
     */
    it('**http 라우트가 tcp 풀을 가리키면 막힌다** — CHECK 가 문다', async () => {
      const head = await store.head();
      const cs = await store.createChangeset(head.revision, 't');
      await store.patchChangeset(cs, [
        PUT('pool', 'tcp-pool', { protocolClass: 'tcp', algorithm: 'round_robin' }),
        PUT('backend', 'b1', { pool: 'tcp-pool', host: '10.0.0.1', port: 11, weight: 1 }),
        PUT('listener', 'front', { protocol: 'http', bind: '0.0.0.0', port: 999, enabled: true }),
        PUT('httpRoute', 'r1', {
          listener: 'front', hosts: ['a.test'], priority: 1,
          action: { kind: 'proxy', pool: 'tcp-pool', websocket: false },
        }),
      ], 't');
      await expect(store.plan(cs, 't')).rejects.toMatchObject({
        status: 422, code: 'constraint_violation',
      });
    });

    it('백엔드 없는 풀은 렌더에서 사라지는 대신 저장이 막힌다', async () => {
      const head = await store.head();
      const cs = await store.createChangeset(head.revision, 't');
      await store.patchChangeset(cs, [
        PUT('pool', 'empty', { protocolClass: 'http', algorithm: 'round_robin' }),
        PUT('listener', 'front', {
          protocol: 'http', bind: '0.0.0.0', port: 999, enabled: true,
          http: { defaultAction: { pool: 'empty' } },
        }),
      ], 't');
      await expect(store.plan(cs, 't')).rejects.toMatchObject({
        status: 422, code: 'invalid_model',
      });
    });

    it('없는 풀을 참조하면 422', async () => {
      const head = await store.head();
      const cs = await store.createChangeset(head.revision, 't');
      await store.patchChangeset(cs, [
        PUT('listener', 'l', { protocol: 'tcp', bind: '0.0.0.0', port: 1, defaultPool: 'nope', enabled: true }),
      ], 't');
      await expect(store.plan(cs, 't')).rejects.toMatchObject({
        status: 422, code: 'unknown_pool',
      });
    });

    it('**소켓이 겹치면 막힌다** — http 999 와 tcp 999', async () => {
      const head = await store.head();
      const cs = await store.createChangeset(head.revision, 't');
      await store.patchChangeset(cs, [
        ...minimal,
        PUT('pool', 'raw', { protocolClass: 'tcp', algorithm: 'round_robin' }),
        PUT('backend', 'r-1', { pool: 'raw', host: '10.0.0.9', port: 9, weight: 1 }),
        PUT('listener', 'dup', {
          protocol: 'tcp', bind: '0.0.0.0', port: 999, enabled: true, defaultPool: 'raw',
        }),
      ], 't');
      await expect(store.plan(cs, 't')).rejects.toMatchObject({ status: 422 });
    });
  });

  it('**plan 이 통과했는데 commit 이 깨지는 일이 없다** — 같은 경로를 지난다', async () => {
    // plan 은 패치를 실제로 적용해 보고 되돌린다. 손으로 만든 그림자에 대고 검증하면
    // DB 제약이 빠지고, 그러면 plan 초록 / commit 빨강이 생긴다.
    const head = await store.head();
    const cs = await store.createChangeset(head.revision, 't');
    await store.patchChangeset(cs, minimal, 't');
    const plan = await store.plan(cs, 't');
    expect(plan.renderDigest).toMatch(/^[0-9a-f]{16,}$/);
    await expect(store.commit(cs, plan.id, 't')).resolves.toMatchObject({ revision: '2' });
  });

  it('**plan 은 아무것도 안 남긴다** — 시뮬레이션이 진짜 되돌아가는가', async () => {
    // 이걸 안 재면 `dryRun` 이 사실 커밋하고 있어도 **아무 테스트도 안 깨진다.**
    // 리소스는 어차피 생기고 head 는 commit 이 올리니, 새는 것이 겉으로 안 드러난다.
    const head = await store.head();
    const cs = await store.createChangeset(head.revision, 't');
    await store.patchChangeset(cs, minimal, 't');
    await store.plan(cs, 't');
    expect((await db.query('SELECT count(*)::int AS n FROM pools')).rows[0]?.['n']).toBe(0);
    expect((await db.query('SELECT count(*)::int AS n FROM listeners')).rows[0]?.['n']).toBe(0);
    expect((await store.head()).revision).toBe('1');
  });

  it('plan 이 impact 를 낸다 — 새로 여는 소켓이 보인다', async () => {
    const head = await store.head();
    const cs = await store.createChangeset(head.revision, 't');
    await store.patchChangeset(cs, minimal, 't');
    const plan = await store.plan(cs, 't');
    // HUP 실패 위험이 여기서 드러나야 한다 (§5.4 socket_changes).
    expect(plan.impact.socketChanges.added).toContain('tcp://0.0.0.0:999');
    expect(plan.impact.planes).toContain('http');
    expect(plan.impact.affectedListeners).toEqual([
      { key: 'front', protocol: 'http', bind: '0.0.0.0', port: 999 },
    ]);
  });

  it('모든 변경이 감사에 남는다 (§5.1)', async () => {
    await commitAll(minimal, 'alice');
    const rows = (await db.query(
      `SELECT principal, action, revision FROM audit ORDER BY id`,
    )).rows;
    expect(rows.map((r) => r['action'])).toEqual([
      'changeset.create', 'changeset.patch', 'changeset.plan', 'changeset.commit',
    ]);
    expect(new Set(rows.map((r) => r['principal']))).toEqual(new Set(['alice']));
    expect(rows.at(-1)?.['revision']).toBe('2');
  });

  it('StoreError 는 §5.1 의 코드를 든다', () => {
    const e = new StoreError(422, 'x', 'y');
    expect(e.status).toBe(422);
    expect(e).toBeInstanceOf(Error);
  });
});
