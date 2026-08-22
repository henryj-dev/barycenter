/**
 * plan 의 시맨틱 영향 — DESIGN.md §5.4 · §2.2-1
 *
 * §5.4 는 아홉 항목을 요구하는데 v0.1 은 다섯만 냈다. 나머지를 채우는 회차의
 * 재현물이다. **여기는 실물 저장소를 지난다** — 순수 함수 단위 검사는
 * `tests/unit/impact-semantics.test.ts` 에 있고, 이 파일이 재는 것은
 * *plan 이 실제로 그 값을 만들어 JSONB 로 왕복하는가* 다.
 *
 *   npm run test:store     (도커 필요)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ConfigStore, type PatchOp } from '../../src/store/config-store.js';
import type { CertFacts } from '../../src/dp/certinfo.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('impact');

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

/** 리스너 둘. 하나는 http, 하나는 tcp — 서로 다른 풀을 본다. */
const two: PatchOp[] = [
  PUT('pool', 'web', { protocolClass: 'http', algorithm: 'round_robin' }),
  PUT('backend', 'web-1', { pool: 'web', host: '10.0.0.1', port: 80, weight: 1 }),
  PUT('listener', 'front', {
    protocol: 'http', bind: '0.0.0.0', port: 999, enabled: true,
    http: { defaultAction: { pool: 'web' } },
  }),
  PUT('pool', 'game', { protocolClass: 'tcp', algorithm: 'round_robin' }),
  PUT('backend', 'game-1', { pool: 'game', host: '10.0.0.2', port: 7777, weight: 1 }),
  PUT('listener', 'edge', {
    protocol: 'tcp', bind: '0.0.0.0', port: 888, enabled: true, defaultPool: 'game',
  }),
];

async function commitAll(ops: PatchOp[]): Promise<void> {
  const head = await store.head();
  const cs = await store.createChangeset(head.revision, 't');
  await store.patchChangeset(cs, ops, 't');
  const plan = await store.plan(cs, 't');
  await store.commit(cs, plan.id, 't');
}

/** 패치를 얹고 plan 만 낸다 (커밋하지 않는다). */
async function planOf(ops: PatchOp[]) {
  const head = await store.head();
  const cs = await store.createChangeset(head.revision, 't');
  await store.patchChangeset(cs, ops, 't');
  return store.plan(cs, 't');
}

describe('§5.4 topologyEpochChange — 이 전환이 좌표를 옮기는가', () => {
  /**
   * 멤버십 평면이 켜진 엔진. 백엔드는 conf 가 아니라 dict 에 산다 (§7.3 · S1).
   *
   * **capability 로 갈리는 것을 capability 를 바꿔 가며 잰다.** 하나만 재면 다른
   * 배포에서 이 값이 거짓이 되는 것을 아무도 못 본다 — 같은 변경이 엔진에 따라
   * 세대 전환을 하기도 하고 안 하기도 한다.
   */
  const luaStore = (): ConfigStore =>
    new ConfigStore(db, { streamRealip: false, httpLua: true, streamLua: true });

  it('멤버십 평면이 있으면 백엔드 변경은 좌표를 안 옮긴다', async () => {
    const s = luaStore();
    const head = await s.head();
    const cs0 = await s.createChangeset(head.revision, 't');
    await s.patchChangeset(cs0, two, 't');
    const p0 = await s.plan(cs0, 't');
    await s.commit(cs0, p0.id, 't');

    const cs = await s.createChangeset((await s.head()).revision, 't');
    await s.patchChangeset(cs, [
      PUT('backend', 'web-1', { pool: 'web', host: '10.0.0.9', port: 80, weight: 1 }),
    ], 't');
    const plan = await s.plan(cs, 't');

    expect(plan.impact.requiresReload).toBe(false);
    expect(plan.impact.topologyEpochChange).toBe(false);
  });

  it('멤버십 평면이 없으면 같은 변경이 좌표를 옮긴다', async () => {
    await commitAll(two);
    const plan = await planOf([
      PUT('backend', 'web-1', { pool: 'web', host: '10.0.0.9', port: 80, weight: 1 }),
    ]);
    // 백엔드가 conf 에 렌더되므로 세대가 새로 서고, 세대에는 epoch 이 구워진다.
    expect(plan.impact.topologyEpochChange).toBe(true);
  });

  it('리스너를 바꾸면 멤버십 평면이 있어도 좌표를 옮긴다', async () => {
    const s = luaStore();
    const head = await s.head();
    const cs0 = await s.createChangeset(head.revision, 't');
    await s.patchChangeset(cs0, two, 't');
    const p0 = await s.plan(cs0, 't');
    await s.commit(cs0, p0.id, 't');

    const cs = await s.createChangeset((await s.head()).revision, 't');
    await s.patchChangeset(cs, [PUT('listener', 'edge', {
      protocol: 'tcp', bind: '0.0.0.0', port: 8888, enabled: true, defaultPool: 'game',
    })], 't');
    const plan = await s.plan(cs, 't');

    expect(plan.impact.topologyEpochChange).toBe(true);
  });
});

describe('§5.4 certificateChanges — 무엇이 교체되고 언제 만료되는가', () => {
  const REF = (n: string, v: string): string => `store://${n}@${v.repeat(32)}`;
  const FACTS: Record<string, CertFacts> = {
    [REF('site', 'a')]: {
      subject: 'CN=a.test', issuer: 'CN=Test CA', domains: ['a.test'],
      notBefore: '2026-01-01T00:00:00.000Z', notAfter: '2026-04-01T00:00:00.000Z',
      chainLength: 2,
    },
    [REF('site', 'b')]: {
      subject: 'CN=a.test', issuer: 'CN=Test CA', domains: ['a.test'],
      notBefore: '2026-03-01T00:00:00.000Z', notAfter: '2026-06-01T00:00:00.000Z',
      chainLength: 2,
    },
  };
  const digests = {
    chainDigest: `sha256:${'a'.repeat(64)}`, keyDigest: `sha256:${'b'.repeat(64)}`,
  };
  const certStore = (): ConfigStore => new ConfigStore(
    db, { streamRealip: false }, { facts: (r: string) => FACTS[r] },
  );

  const tlsSetup = (ref: string): PatchOp[] => [
    PUT('pool', 'web', { protocolClass: 'http', algorithm: 'round_robin' }),
    PUT('backend', 'web-1', { pool: 'web', host: '10.0.0.1', port: 80, weight: 1 }),
    PUT('certificate', 'site', { materialRef: ref, ...digests }),
    PUT('tlsPolicy', 'pol', { minVersion: '1.2' }),
    PUT('listener', 'secure', {
      protocol: 'https', bind: '0.0.0.0', port: 443, enabled: true,
      tls: { policy: 'pol', defaultCertificate: 'site' },
      http: { defaultAction: { pool: 'web' } },
    }),
    PUT('sniBinding', 'b1', { listener: 'secure', hosts: ['a.test'], certificate: 'site' }),
  ];

  it('갱신은 교체로 보이고 새 만료일을 싣는다', async () => {
    const s = certStore();
    const cs0 = await s.createChangeset((await s.head()).revision, 't');
    await s.patchChangeset(cs0, tlsSetup(REF('site', 'a')), 't');
    const p0 = await s.plan(cs0, 't');
    await s.commit(cs0, p0.id, 't');

    const cs = await s.createChangeset((await s.head()).revision, 't');
    await s.patchChangeset(cs, [
      PUT('certificate', 'site', { materialRef: REF('site', 'b'), ...digests }),
    ], 't');
    const plan = await s.plan(cs, 't');

    expect(plan.impact.certificateChanges).toEqual([
      { key: 'site', change: 'replaced', notAfter: '2026-06-01T00:00:00.000Z' },
    ]);
  });

  it('자료를 모르면 날짜를 안 싣는다', async () => {
    // §8.1 — 만료는 자료에서 온다. 설정에 적힌 날짜를 믿으면 알람이 거짓이다.
    // 모르면 **비워 둔다.** 지어내지 않고, 그렇다고 항목을 감추지도 않는다.
    const blind = new ConfigStore(db, { streamRealip: false }, { facts: () => undefined });
    const cs = await blind.createChangeset((await blind.head()).revision, 't');
    await blind.patchChangeset(cs, tlsSetup(REF('site', 'a')), 't');
    const plan = await blind.plan(cs, 't');

    expect(plan.impact.certificateChanges).toEqual([{ key: 'site', change: 'added' }]);
  });

  it('인증서를 안 건드리면 아무것도 안 싣는다', async () => {
    await commitAll(two);
    const plan = await planOf([
      PUT('backend', 'web-1', { pool: 'web', host: '10.0.0.9', port: 80, weight: 1 }),
    ]);
    expect(plan.impact.certificateChanges).toEqual([]);
  });
});

describe('§5.4 socketChanges — 두 쪽을 같은 자로 잰다', () => {
  it('안 움직인 소켓은 안 싣는다', async () => {
    await commitAll(two);
    const plan = await planOf([
      PUT('backend', 'web-1', { pool: 'web', host: '10.0.0.9', port: 80, weight: 1 }),
    ]);
    // 리스너를 안 건드렸다. **HUP 실패 위험이 여기서 드러나야 하는데**(§5.4),
    // 매번 전부가 열리고 닫히는 것처럼 보이면 이 줄은 신호가 아니라 잡음이다.
    expect(plan.impact.socketChanges).toEqual({ added: [], removed: [] });
  });

  it('진짜 닫히는 소켓은 싣는다', async () => {
    await commitAll(two);
    const plan = await planOf([{ op: 'delete', kind: 'listener', key: 'edge' }]);
    expect(plan.impact.socketChanges.removed).toEqual(['tcp://0.0.0.0:888']);
    expect(plan.impact.socketChanges.added).toEqual([]);
  });
});

describe('§5.4 sessionImpact — 기존 세션은 어떻게 되는가', () => {
  const effectOf = (impact: { sessionImpact: { protocol: string; effect: string }[] },
    protocol: string): string | undefined =>
    impact.sessionImpact.find((s) => s.protocol === protocol)?.effect;

  it('소켓이 사라지는 프로토콜은 기존 세션이 끊긴다', async () => {
    await commitAll(two);
    const plan = await planOf([{ op: 'delete', kind: 'listener', key: 'edge' }]);
    expect(effectOf(plan.impact, 'tcp')).toBe('may_reset');
    // http 리스너는 안 건드렸다. **모르는 것과 영향 없는 것을 섞지 않는다.**
    expect(effectOf(plan.impact, 'http')).toBe('none');
  });

  it('소켓이 그대로면 새 트래픽부터다', async () => {
    await commitAll(two);
    const plan = await planOf([
      PUT('backend', 'web-1', { pool: 'web', host: '10.0.0.9', port: 80, weight: 1 }),
    ]);
    expect(effectOf(plan.impact, 'http')).toBe('new_only');
  });

  it('worker shutdown timeout 이 걸려 있으면 진행 중 요청이 잘린다', async () => {
    await commitAll([...two, PUT('engine', 'engine', { workerShutdownTimeoutS: 2 })]);
    // 소켓은 그대로 두고 라우팅만 바꾼다 — reload 는 나지만 bind 는 안 움직인다.
    const plan = await planOf([
      PUT('backend', 'web-1', { pool: 'web', host: '10.0.0.9', port: 80, weight: 1 }),
    ]);
    // §4.10 실측: 상한이 걸리면 in-flight 가 **응답 없이** 죽는다 (curl exit=52).
    expect(effectOf(plan.impact, 'http')).toBe('may_reset');
  });
});

describe('§5.4 affectedListeners — 영향과 목록은 다르다', () => {
  it('영향받는 리스너만 싣는다', async () => {
    await commitAll(two);
    // web 풀의 백엔드만 옮긴다. `edge` 는 game 풀을 보므로 아무 상관이 없다.
    const plan = await planOf([
      PUT('backend', 'web-1', { pool: 'web', host: '10.0.0.9', port: 80, weight: 1 }),
    ]);
    const keys = plan.impact.affectedListeners.map((l) => l.key);
    expect(keys).toEqual(['front']);
  });

  it('지워진 리스너도 영향이다', async () => {
    await commitAll(two);
    const plan = await planOf([{ op: 'delete', kind: 'listener', key: 'edge' }]);
    const edge = plan.impact.affectedListeners.find((l) => l.key === 'edge');
    // 사라진 것은 모델에 없다. 그래도 **영향받은 것 중 가장 큰 것**이다 —
    // 여기서 안 실으면 화면이 "아무 리스너도 영향받지 않는다" 고 말한다.
    expect(edge).toBeDefined();
    expect(edge?.change).toBe('removed');
  });

  it('아무것도 안 바뀌면 아무 리스너도 영향이 아니다', async () => {
    await commitAll(two);
    // 같은 값을 다시 쓴다. 리비전은 움직이지만 내용은 그대로다.
    const plan = await planOf([
      PUT('backend', 'web-1', { pool: 'web', host: '10.0.0.1', port: 80, weight: 1 }),
    ]);
    expect(plan.impact.affectedListeners).toEqual([]);
  });
});
