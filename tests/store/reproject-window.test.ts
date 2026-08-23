/**
 * ▲ 잔여물 — **staging 과 활성화 사이에 헬스가 바뀌는 창** (§6.5-4)
 *
 * `plane.ts` 가 그 자리에 이렇게 적어 두었다:
 *
 * > ⚠️ **이 창이 닫혔다는 것은 논증이지 측정이 아니다.** staging 과 활성화 사이에
 * > 헬스를 바꾸는 것을 밖에서 결정적으로 만들 방법이 없어서, 재현물 없이 둔다.
 *
 * **"밖에서" 가 그 문장의 전부다.** 밖에서는 프로버가 언제 판정을 뒤집을지 못 정하니
 * 맞는 말이다. 그런데 헬스는 프로버의 소유가 아니라 **`backend_health` 표**의 소유이고,
 * `eligible()` 은 그 표를 읽는다. 표를 직접 쓰면 그 창은 결정적이다.
 *
 * ── 창을 어디서 여는가
 *
 * `ControlPlane.apply()` 의 순서가 정확히 이렇다:
 *
 *   ① `slotsForEligible(...)` — **T0 의 헬스**로 부트스트랩 슬롯을 만든다
 *   ② `driver.applyConfig(op)` — 게시 · staging · HUP · 활성화
 *   ③ `projectHealth()`      — 지금 헬스로 **다시 유도한다**
 *
 * ②가 도는 동안 백엔드가 죽으면 새 epoch 은 ①의 멤버십을 들고 서빙을 시작한다.
 * ③이 그 창을 닫는다는 것이 §6.5 의 주장이고, 여기서 잰다 — 가짜 드라이버의
 * `applyConfig` 안에서 `backend_health` 를 뒤집으면 ②의 한가운데가 된다.
 *
 * ── 이 파일이 답하는 물음
 *
 * "재투영을 빼는 변이가 아무 테스트도 안 깨뜨린다" 가 그 자리의 다른 반쪽이었다.
 * 이제 깨뜨린다 — `projectHealth()` 호출을 지우면 아래 첫 검사가 빨개진다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigStore, type PatchOp } from '../../src/store/config-store.js';
import { ControlPlane } from '../../src/control/plane.js';
import { LeaderElection } from '../../src/control/leader.js';
import type { DataplaneDriver } from '../../src/dp/driver.js';
import type { ApplyOperation, ApplyResult, Plane } from '../../src/dp/operation.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('reproject-window');

let db: Db;
let store: ConfigStore;
let control: ControlPlane;
/**
 * **세대 디렉토리는 테스트마다 새로 판다.** `reset(db)` 은 DB 만 되돌리므로 리비전이
 * 1 부터 다시 세는데, 파일시스템에는 앞 테스트의 `r2-e1` 이 남아 있다. 그러면
 * `materializeGeneration` 이 "세대는 불변이다" 로 막는다 — 그 판정 자체는 옳다.
 */
let prefix = '';
let election0: LeaderElection;

/** 멤버십 평면이 켜져 있어야 `projectHealth` 가 일을 한다. */
const CAPS = { httpLua: true, streamLua: true, streamRealip: false, sslConfCommand: true };

/** ②가 도는 동안 무슨 일이 일어나는가 — 테스트마다 갈아 끼운다. */
let duringApply: (() => Promise<void>) | undefined;

/**
 * ③ 이 민 슬롯. ① 의 T0 슬롯은 봉투가 아니라 **세대 파일**로 나가므로 여기서 못 본다 —
 * 그래서 이 테스트는 ①과 ③을 비교하는 대신 **③의 결과가 지금 헬스와 맞는지**를 잰다.
 * §6.5-4 가 요구하는 것이 그것이고, ①을 훔쳐보면 오히려 세대 배치에 결박된다.
 */
const pushed: { plane: Plane; slots: Record<string, string[]> }[] = [];

const EPOCH = '7';

const driver: DataplaneDriver = {
  fence: () => Promise.resolve({ maxToken: '0' }),
  async applyConfig(op: ApplyOperation): Promise<ApplyResult> {
    // 부트스트랩 슬롯은 세대에 실린다 — 여기서는 봉투가 아니라 **호출 시점**만 쓴다.
    if (duringApply !== undefined) await duringApply();
    return {
      phase: 'activated',
      progress: { http: undefined, stream: undefined },
      partialTransition: false,
    };
  },
  recoverConfig: () => Promise.reject(new Error('안 쓴다')),
  abortConfig: () => Promise.resolve(),
  applyMembership: () => Promise.reject(new Error('안 쓴다')),
  pushMembershipDirect(plane, _epoch, slots) {
    pushed.push({ plane, slots });
    return Promise.resolve();
  },
  reconcileConfig: () => Promise.reject(new Error('안 쓴다')),
  status: () => Promise.resolve({
    maxLeaderToken: '0',
    planes: {
      http: { activationEpoch: EPOCH, membershipRevision: '1', payloadDigest: '' },
      stream: { activationEpoch: EPOCH, membershipRevision: '1', payloadDigest: '' },
    },
    published: { current: undefined, pendingActivation: undefined },
    lastEvidence: undefined,
    unfinished: undefined,
  } as unknown as Awaited<ReturnType<DataplaneDriver['status']>>),
};

const MODEL: PatchOp[] = [
  { op: 'put', kind: 'pool', key: 'app', body: { protocolClass: 'http', algorithm: 'round_robin' } },
  { op: 'put', kind: 'backend', key: 'a', body: { pool: 'app', host: '10.0.0.1', port: 80, weight: 1 } },
  { op: 'put', kind: 'backend', key: 'b', body: { pool: 'app', host: '10.0.0.2', port: 80, weight: 1 } },
  {
    op: 'put', kind: 'listener', key: 'front',
    body: {
      protocol: 'http', bind: '0.0.0.0', port: 8080, enabled: true,
      http: { defaultAction: { pool: 'app' } },
    },
  },
];

/** 헬스 표를 **직접** 쓴다. 프로버를 태우면 언제 뒤집힐지가 다시 불확정이 된다. */
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

async function commitAndApply(): Promise<void> {
  const head = await store.head();
  const cs = await store.createChangeset(head.revision, 't');
  await store.patchChangeset(cs, MODEL, 't');
  const plan = await store.plan(cs, 't');
  await store.commit(cs, plan.id, 't');
  await control.apply(plan.id, 't');
}

/** 밀린 슬롯에서 peer 목록을 평평하게 편다. */
const peersOf = (slots: Record<string, string[]> | undefined): string[] =>
  Object.values(slots ?? {}).flat().sort();

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 실물 PG 를 쓴다');
  startPg(PG);
  db = new Db(PG.dsn);
  await db.migrate();
  store = new ConfigStore(db, { streamRealip: false });
  const election = new LeaderElection(PG.dsn, 'reproject-test');
  if (!(await election.tryAcquire())) throw new Error('리더 획득 실패');
  election0 = election;
}, 240_000);

afterAll(async () => {
  if (prefix !== '') rmSync(prefix, { recursive: true, force: true });
  await db?.close();
  stopPg(PG);
});

beforeEach(async () => {
  await reset(db);
  duringApply = undefined;
  pushed.length = 0;
  if (prefix !== '') rmSync(prefix, { recursive: true, force: true });
  prefix = mkdtempSync(join(tmpdir(), 'bary-reproject-'));
  control = new ControlPlane(db, store, driver, election0, {
    prefix,
    adminSocket: join(prefix, 'admin.sock'),
    renderCaps: CAPS,
  });
});

describe('▲ staging 과 활성화 사이의 헬스 변화', () => {
  /**
   * **이 파일의 이유.** 이게 없으면 §6.5-4 의 "다시 유도한다" 는 논증으로만 산다.
   */
  it('②가 도는 동안 죽은 백엔드는 ③이 뺀다', async () => {
    await setHealth('a', 'healthy');
    await setHealth('b', 'healthy');
    duringApply = async () => { await setHealth('b', 'unhealthy'); };

    await commitAndApply();

    expect(pushed.length, '재투영이 아무것도 안 밀었다').toBeGreaterThan(0);
    const peers = peersOf(pushed.find((p) => p.plane === 'http')?.slots);
    expect(peers).toContain('10.0.0.1:80');
    // **이 한 줄이 창이 닫혔다는 측정이다.** T0 에는 b 가 산 것으로 있었다.
    expect(peers, `밀린 peer: ${JSON.stringify(peers)}`).not.toContain('10.0.0.2:80');
  }, 240_000);

  /**
   * 반대 방향도 같이 잰다. 창은 양쪽으로 열린다 — T0 에 죽어 있던 백엔드가 활성화
   * 사이에 살아나면 새 epoch 은 그 백엔드 없이 서빙을 시작한다. 재투영이 그것도
   * 되돌려야 "지금 헬스와 일치한다" 가 성립한다.
   */
  it('②가 도는 동안 살아난 백엔드는 ③이 들인다', async () => {
    await setHealth('a', 'healthy');
    await setHealth('b', 'unhealthy');
    duringApply = async () => { await setHealth('b', 'healthy'); };

    await commitAndApply();

    const peers = peersOf(pushed.find((p) => p.plane === 'http')?.slots);
    expect(peers, `밀린 peer: ${JSON.stringify(peers)}`).toContain('10.0.0.2:80');
  }, 240_000);

  /**
   * 헬스가 안 바뀌면 재투영은 **같은 답**을 낸다. 이게 §6.5 가 이벤트 재생 대신 재유도를
   * 고를 수 있었던 이유다 — 리듀서가 델타가 아니라 상태에서 계산하므로 멱등이다.
   */
  it('아무것도 안 바뀌면 재투영이 같은 답을 낸다', async () => {
    await setHealth('a', 'healthy');
    await setHealth('b', 'healthy');

    await commitAndApply();

    const peers = peersOf(pushed.find((p) => p.plane === 'http')?.slots);
    expect(peers).toEqual(['10.0.0.1:80', '10.0.0.2:80']);
  }, 240_000);

  /**
   * 드레인도 같은 표를 지난다(`drainKeys`). 창 안에서 드레인이 걸리면 그것도 빠져야
   * 한다 — 안 그러면 "드레인했는데 다음 apply 가 되살린다" 가 된다.
   */
  it('②가 도는 동안 드레인된 백엔드도 ③이 뺀다', async () => {
    await setHealth('a', 'healthy');
    await setHealth('b', 'healthy');
    duringApply = async () => {
      await db.query(
        `INSERT INTO backend_drain (backend_key, started_at, started_by)
         VALUES ('b', now(), 't') ON CONFLICT (backend_key) DO NOTHING`,
      );
    };

    await commitAndApply();

    const peers = peersOf(pushed.find((p) => p.plane === 'http')?.slots);
    // **살아 있는 쪽을 먼저 못 박는다.** `not.toContain` 만 두면 재투영이 아예 안
    // 돌았을 때(빈 배열)도 통과한다 — 뮤테이션으로 그렇게 되는 것을 봤다.
    expect(peers, `밀린 peer: ${JSON.stringify(peers)}`).toContain('10.0.0.1:80');
    expect(peers, `밀린 peer: ${JSON.stringify(peers)}`).not.toContain('10.0.0.2:80');
  }, 240_000);

  /**
   * **재투영이 실패해도 apply 는 실패하지 않는다.** 활성화는 이미 끝났고, 되돌릴 것이
   * 없다. 대신 조용히 넘기지 않고 감사에 남긴다 — `health.reproject.failed`.
   */
  it('재투영이 죽어도 apply 는 산다 — 그리고 감사에 남는다', async () => {
    await setHealth('a', 'healthy');
    await setHealth('b', 'healthy');
    const original = driver.pushMembershipDirect;
    (driver as { pushMembershipDirect: unknown }).pushMembershipDirect =
      () => Promise.reject(new Error('밀기 실패'));
    try {
      await commitAndApply();
    } finally {
      (driver as { pushMembershipDirect: unknown }).pushMembershipDirect = original;
    }
    const rows = (await db.query(
      `SELECT action FROM audit WHERE action='health.reproject.failed'`,
    )).rows;
    expect(rows.length, '실패가 감사에 안 남았다').toBeGreaterThan(0);
  }, 240_000);
});
