/**
 * S3 · S4 — **엔진 재시작 부트스트랩과 CP 단절** (§6.4 · §6.7 · §12.0)
 *
 * §12.0 의 두 줄:
 *
 *   S3  재시딩까지 공백 < 1s, **오래된 헬스 되살아남 없음**
 *   S4  fail-open 유지, **eviction 시 zero-peer 없음**
 *
 * 둘 다 한 함수에 모인다 — `ControlPlane.restageMembership()`. 그런데 그 함수에
 * **재현물이 하나도 없었다.** 판정 규칙(`shouldPushMembership`)은 단위로 덮여 있는데,
 * 그것을 부르는 경로가 안 덮여 있으면 규칙이 맞아도 안 불릴 수 있다 — 이 저장소가
 * "필드는 있는데 아무도 안 읽는다" 로 반복해서 잡아 온 부류의 함수판이다.
 *
 * ── 왜 여기가 중요한가
 *
 * `lua_shared_dict` 는 **프로세스 수명**이다. 엔진이 재시작하면 슬롯이 통째로 비고,
 * 밸런서는 §6.5-3 대로 연결을 끊는다 — 설정은 멀쩡한데 트래픽이 전부 죽는다.
 * 코드 주석이 *"컨테이너를 재시작하고 500 을 받고서야 이 자리를 봤다"* 고 적어 뒀다.
 *
 * 그래서 다시 적재하는데, **무엇으로** 적재하느냐가 S3 의 둘째 절이다. 세대
 * 아티팩트로 되밀면 그 세대가 만들어질 때의 스냅샷이 돌아온다 — 죽은 백엔드가
 * 되살아난다. 정본은 **head 리비전 ∩ 지금 헬스** 다.
 *
 *   npm run test:store     (도커 필요)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigStore, type PatchOp } from '../../src/store/config-store.js';
import { ControlPlane } from '../../src/control/plane.js';
import { LeaderElection } from '../../src/control/leader.js';
import type { DataplaneDriver } from '../../src/dp/driver.js';
import type { Plane } from '../../src/dp/operation.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('restage');
const CAPS = { httpLua: true, streamLua: true, streamRealip: false, sslConfCommand: true };
const EPOCH = '5';

let db: Db;
let store: ConfigStore;
let control: ControlPlane;
let election0: LeaderElection;
let prefix = '';

/** 재적재가 민 슬롯. 엔진 재시작 뒤 dict 에 들어갈 값이다. */
const pushed: { plane: Plane; epoch: string; slots: Record<string, string[]> }[] = [];
/** `published.kind` — 게시된 것이 없으면 재적재는 아무것도 안 한다. */
let publishedOwned = true;

const driver: DataplaneDriver = {
  fence: () => Promise.resolve({ maxToken: '0' }),
  applyConfig: () => Promise.reject(new Error('이 스위트는 apply 를 안 태운다')),
  recoverConfig: () => Promise.reject(new Error('안 쓴다')),
  abortConfig: () => Promise.resolve(),
  applyMembership: () => Promise.reject(new Error('안 쓴다')),
  pushMembershipDirect(plane, epoch, slots) {
    pushed.push({ plane, epoch, slots });
    return Promise.resolve();
  },
  reconcileConfig: () => Promise.reject(new Error('안 쓴다')),
  status: () => Promise.resolve({
    maxLeaderToken: '0',
    planes: {
      http: { activationEpoch: EPOCH, membershipRevision: '1', payloadDigest: '' },
      stream: { activationEpoch: EPOCH, membershipRevision: '1', payloadDigest: '' },
    },
    published: publishedOwned
      ? {
        kind: 'owned',
        record: {
          generation: 'g', leaderToken: '1', operationId: 'o',
          transitionId: 't', generationDigest: 'sha256:g',
        },
      }
      : { kind: 'none' },
    lastEvidence: undefined,
    unfinished: undefined,
  } as unknown as Awaited<ReturnType<DataplaneDriver['status']>>),
};

/** http 풀 하나에 백엔드 셋. stream 쪽도 하나 둬서 평면이 따로 도는 것을 본다. */
const MODEL: PatchOp[] = [
  { op: 'put', kind: 'pool', key: 'app', body: { protocolClass: 'http', algorithm: 'round_robin' } },
  { op: 'put', kind: 'backend', key: 'a', body: { pool: 'app', host: '10.0.0.1', port: 80, weight: 1 } },
  { op: 'put', kind: 'backend', key: 'b', body: { pool: 'app', host: '10.0.0.2', port: 80, weight: 1 } },
  { op: 'put', kind: 'backend', key: 'c', body: { pool: 'app', host: '10.0.0.3', port: 80, weight: 1 } },
  {
    op: 'put', kind: 'listener', key: 'front',
    body: {
      protocol: 'http', bind: '0.0.0.0', port: 8080, enabled: true,
      http: { defaultAction: { pool: 'app' } },
    },
  },
];

async function setHealth(key: string, state: 'healthy' | 'unhealthy'): Promise<void> {
  await db.query(
    `INSERT INTO backend_health
       (backend_key, state, probe_start_seq, consecutive, last_ok, observed_at, detail)
     VALUES ($1,$2,'1',1,$3,now(),'테스트가 직접 썼다')
     ON CONFLICT (backend_key) DO UPDATE SET
       state=EXCLUDED.state, observed_at=now(), detail=EXCLUDED.detail`,
    [key, state, state === 'healthy'],
  );
}

async function commitModel(): Promise<void> {
  const head = await store.head();
  const cs = await store.createChangeset(head.revision, 't');
  await store.patchChangeset(cs, MODEL, 't');
  const plan = await store.plan(cs, 't');
  await store.commit(cs, plan.id, 't');
}

const httpPeers = (): string[] =>
  Object.values(pushed.find((p) => p.plane === 'http')?.slots ?? {}).flat().sort();

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 실물 PG 를 쓴다');
  startPg(PG);
  db = new Db(PG.dsn);
  await db.migrate();
  store = new ConfigStore(db, { streamRealip: false });
  const e = new LeaderElection(PG.dsn, 'restage-test');
  if (!(await e.tryAcquire())) throw new Error('리더 획득 실패');
  election0 = e;
}, 240_000);

afterAll(async () => {
  if (prefix !== '') rmSync(prefix, { recursive: true, force: true });
  await db?.close();
  stopPg(PG);
});

beforeEach(async () => {
  await reset(db);
  pushed.length = 0;
  publishedOwned = true;
  if (prefix !== '') rmSync(prefix, { recursive: true, force: true });
  prefix = mkdtempSync(join(tmpdir(), 'bary-restage-'));
  control = new ControlPlane(db, store, driver, election0, {
    prefix, adminSocket: join(prefix, 'admin.sock'), renderCaps: CAPS,
  });
});

describe('S3 — 엔진 재시작 부트스트랩', () => {
  it('산 백엔드를 서 있는 epoch 으로 다시 적재한다', async () => {
    await commitModel();
    for (const k of ['a', 'b', 'c']) await setHealth(k, 'healthy');

    const r = await control.restageMembership();

    expect(r?.epoch, '서 있는 epoch 으로 안 밀었다').toBe(EPOCH);
    expect(httpPeers()).toEqual(['10.0.0.1:80', '10.0.0.2:80', '10.0.0.3:80']);
  }, 240_000);

  /**
   * **S3 의 둘째 절이다.** 세대 아티팩트로 되밀면 그 세대가 만들어질 때의 스냅샷이
   * 돌아오고, 그러면 죽은 백엔드가 재시작만으로 되살아난다. 정본은 head ∩ 지금 헬스다.
   */
  it('**죽은 백엔드는 재시작으로 되살아나지 않는다**', async () => {
    await commitModel();
    await setHealth('a', 'healthy');
    await setHealth('b', 'unhealthy');
    await setHealth('c', 'healthy');

    await control.restageMembership();

    const peers = httpPeers();
    expect(peers, `밀린 peer: ${JSON.stringify(peers)}`).not.toContain('10.0.0.2:80');
    expect(peers).toEqual(['10.0.0.1:80', '10.0.0.3:80']);
  }, 240_000);

  it('드레인된 백엔드도 되살아나지 않는다 — 같은 리듀서를 지난다', async () => {
    await commitModel();
    for (const k of ['a', 'b', 'c']) await setHealth(k, 'healthy');
    await db.query(
      `INSERT INTO backend_drain (backend_key, started_at, started_by)
       VALUES ('c', now(), 't') ON CONFLICT (backend_key) DO NOTHING`,
    );

    await control.restageMembership();
    expect(httpPeers()).toEqual(['10.0.0.1:80', '10.0.0.2:80']);
  }, 240_000);

  /**
   * `unknown` 은 **안 뺀다.** 아직 재보지 못한 것과 죽은 것은 다르고, 기동 직후
   * 전부 `unknown` 일 때 다 빼면 멤버십이 통째로 빈다 — 그게 §12.0 이 적어 둔
   * 실패 시 축소안("부팅 시 전 백엔드 unknown")이 위험한 이유다.
   */
  it('헬스 판정이 아직 없으면 빼지 않는다 — 재본 적 없음과 죽음은 다르다', async () => {
    await commitModel();
    await control.restageMembership();
    expect(httpPeers()).toEqual(['10.0.0.1:80', '10.0.0.2:80', '10.0.0.3:80']);
  }, 240_000);

  /**
   * §12.0 의 첫째 절 — **재시딩까지 공백 < 1s**. 여기서 재는 것은 데몬이 부르는
   * 함수 자체의 시간이다. 실물에서는 그 앞에 프로세스 기동이 붙지만, 그 부분은
   * 우리 코드가 아니다.
   */
  it('재적재가 1초 안에 끝난다', async () => {
    await commitModel();
    for (const k of ['a', 'b', 'c']) await setHealth(k, 'healthy');
    const t0 = Date.now();
    await control.restageMembership();
    expect(Date.now() - t0, '재시딩이 1초를 넘었다').toBeLessThan(1000);
  }, 240_000);

  it('게시된 것이 없으면 아무것도 안 민다 — 없는 좌표에 쓰지 않는다', async () => {
    await commitModel();
    publishedOwned = false;
    expect(await control.restageMembership()).toBeUndefined();
    expect(pushed.length).toBe(0);
  }, 240_000);
});

describe('S4 — 의도적 zero-peer 와 갱신 실패를 가른다 (§6.7)', () => {
  /**
   * **풀의 모든 백엔드가 죽었다.** 그건 실제로 빈 멤버십이고 요청은 실패해야 한다 —
   * 옛 peer 를 남겨 두면 죽은 백엔드가 계속 트래픽을 받는다. 빈 셋을 **쓴다.**
   */
  it('전부 죽으면 빈 슬롯을 쓴다 — 죽은 peer 를 남기지 않는다', async () => {
    await commitModel();
    for (const k of ['a', 'b', 'c']) await setHealth(k, 'unhealthy');

    const r = await control.restageMembership();

    expect(r?.planes, 'http 평면에 안 밀었다').toContain('http');
    expect(httpPeers()).toEqual([]);
  }, 240_000);

  /**
   * **모델에 백엔드가 아예 없는 것**도 같은 쪽이다 — 의도적 zero-peer 다.
   * 여기서 안 밀면 옛 슬롯이 남고, 지워진 백엔드가 계속 트래픽을 받는다.
   */
  it('백엔드를 다 지운 것도 의도적 zero-peer 다', async () => {
    await commitModel();
    const head = await store.head();
    const cs = await store.createChangeset(head.revision, 't');
    await store.patchChangeset(cs, [
      { op: 'delete', kind: 'backend', key: 'a' },
      { op: 'delete', kind: 'backend', key: 'b' },
      { op: 'delete', kind: 'backend', key: 'c' },
      { op: 'delete', kind: 'listener', key: 'front' },
    ] as PatchOp[], 't');
    const plan = await store.plan(cs, 't');
    await store.commit(cs, plan.id, 't');

    await control.restageMembership();
    expect(httpPeers()).toEqual([]);
  }, 240_000);
});
