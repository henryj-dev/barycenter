/**
 * 8차 검수 반례 — apply 실행권(lease)과 승계의 마무리
 *
 * 7차에서 `fence` 가 승계하도록 고쳤다. 그러면서 또 구멍이 생겼고, **내가 "남는 위험의
 * 경계" 라고 적은 것 자체가 거짓이었다.**
 *
 *   ① 옛 러너가 `publish()` 안에서 멈춘 뒤 승계·신임 완료가 지나가면, 옛 게시가
 *      **나중에 착지한다** → `current` = 옛 세대, 좌표 = 신임 세대.
 *      "신임 게시가 덮는다" 는 게시 **순서**를 가정한 말이었다.
 *   ② 저널을 쓰기 전에 죽으면 승계가 예약을 남긴다 → 신임 작업이 `slot_taken`.
 *      종단으로 끝난 저널을 `superseded` 로 덮기도 했다.
 *   ③ 관측 뒤 evidence 를 **현재 저널**에 썼다. 그 사이 승계가 일어나면 남의 것이다.
 *   ⑤ `abortConfig` 가 예약만 지우고 실행권을 놓지 않았다.
 *
 * 고치는 방식: **검사를 부작용 구현 안으로 내린다.** 러너가 아무리 앞에서 확인해도 그
 * 뒤의 `await` 안에서 리더가 바뀌면 소용없다. `Effects` 는 되돌릴 수 없는 연산 직전에
 * `lease.assertValid()` 를 부르고 그 사이에 `await` 를 두지 않는다 — JavaScript 는 단일
 * 스레드라 그 구간에는 아무도 끼어들지 못한다.
 */
import { describe, expect, it } from 'vitest';
import { DpAgent, DpRejection, MemoryStore, tupleFor } from '../../src/dp/agent.js';
import { ApplyRunner, FakeEffects, recordOf } from '../../src/dp/apply.js';
import { LocalDataplaneDriver } from '../../src/dp/driver.js';
import type { ApplyLease, ApplyOperation, PublishRecord } from '../../src/dp/operation.js';

const OP = (id: string, gen = 'gen-1', o: Partial<ApplyOperation> = {}): ApplyOperation => ({
  leaderToken: '10',
  operationId: id,
  transitionId: id,
  affectedPlanes: ['http', 'stream'],
  targetGeneration: gen,
  generationDigest: 'sha256:g',
  planes: {
    http: {
      expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
      target: { activationEpoch: '1', membershipRevision: '1' },
      payloadDigest: 'sha256:h',
    },
    stream: {
      expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
      target: { activationEpoch: '1', membershipRevision: '1' },
      payloadDigest: 'sha256:s',
    },
  },
  ...o,
});

const FAST = { attempts: 1, intervalMs: 0, sleep: async () => {} };

const kindOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return '통과';
  } catch (e) {
    return e instanceof DpRejection ? e.kind : (e as Error).name;
  }
};

// ── ① lease 가 늦은 부작용을 막는다 ─────────────────────────────────────

describe('① 옛 러너의 늦은 게시가 착지하지 못한다', () => {
  it('멈춰 있던 publish 는 승계 뒤에 완료되지 못한다', async () => {
    const store = new MemoryStore();
    const oldAgent = new DpAgent(store); // 옛 리더의 프로세스
    const newAgent = new DpAgent(store); // 새 리더의 프로세스

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    /** 옛 세대를 게시하려다 준비 단계에서 멈춘다. */
    class Stalling extends FakeEffects {
      override async publish(record: PublishRecord, lease: ApplyLease): Promise<void> {
        if (record.generation === 'gen-old') await gate;
        await super.publish(record, lease);
      }
    }

    const fx = new Stalling();
    const oldRun = new ApplyRunner(oldAgent, fx, FAST).run(OP('old', 'gen-old')).catch((e) => e);
    await new Promise((r) => setTimeout(r, 20));

    await newAgent.fence('11');
    await new ApplyRunner(newAgent, fx, FAST).run(OP('new', 'gen-new', { leaderToken: '11' }));
    expect(fx.publishedGeneration).toBe('gen-new');

    release();
    await oldRun;

    // **여기가 계약이다.** 좌표가 개별적으로 안전한 것과 시스템이 정합한 것은 다르다.
    expect(fx.publishedGeneration, 'current 와 좌표가 갈라졌다').toBe('gen-new');
    expect(newAgent.coordinate('http').activationEpoch).toBe('1');
  });

  it('lease 를 쥔 채로는 정상 게시된다 — 막는 것만 하는 게 아니다', async () => {
    const agent = new DpAgent(new MemoryStore());
    const fx = new FakeEffects();
    const r = await new ApplyRunner(agent, fx, FAST).run(OP('only'));
    expect(r.phase).toBe('activated');
    expect(fx.publishCalls).toBe(1);
  });

  /**
   * `signalReload` 의 lease 는 **계약이다.** 러너의 흐름에서는 저널 쓰기가 먼저 막아
   * 주지만, 그건 지금 흐름이 그렇다는 것일 뿐이다. `Effects` 구현자는 흐름을 모른다 —
   * 계약을 직접 시험한다.
   *
   * (러너 경로로만 시험했더니 lease 검사를 빼도 통과했다. 저널 쓰기에서 먼저 걸렸기
   * 때문이다. 검사하지 않는 것을 검사한다고 믿을 뻔했다.)
   */
  it('lease 를 잃은 뒤의 HUP 은 거부된다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const op = OP('old');
    await agent.reserveAll(op);
    const lease = agent.lease(op);

    const fx = new FakeEffects();
    await fx.signalReload(lease); // 아직 내 차례다
    expect(fx.reloadSignals).toBe(1);

    await new DpAgent(store).fence('11'); // 승계
    expect(await kindOf(fx.signalReload(lease))).toBe('stale_leader');
    expect(fx.reloadSignals, '잃은 lease 로 HUP 을 보냈다').toBe(1);
  });

  it('lease 를 잃은 뒤의 게시도 거부된다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const op = OP('old');
    await agent.reserveAll(op);
    const lease = agent.lease(op);

    const fx = new FakeEffects();
    await new DpAgent(store).fence('11');
    expect(await kindOf(fx.publish(recordOf(OP('old')), lease))).toBe('stale_leader');
    expect(fx.publishCalls, '잃은 lease 로 게시했다').toBe(0);
  });
});

// ── ② 승계가 확실히 반납한다 ────────────────────────────────────────────

describe('② 승계는 실행권이 든 목록으로 반납한다', () => {
  it('**저널을 쓰기 전에 죽어도** 예약이 남지 않는다', async () => {
    const store = new MemoryStore();
    const oldAgent = new DpAgent(store);
    await oldAgent.reserveAll(OP('old'));
    expect(oldAgent.readJournal(), '아직 저널이 없는 상태여야 한다').toBeUndefined();

    const newAgent = new DpAgent(store);
    await newAgent.fence('11');

    expect(newAgent.reservationOwner('http', '1'), '저널이 없다고 예약을 놓쳤다').toBeUndefined();
    const acks = await newAgent.reserveAll(OP('new', 'gen-1', { leaderToken: '11' }));
    // 설정 apply 는 두 평면을 선언하므로 ACK 도 둘이다 (11차 반례 ②).
    expect(acks.length).toBe(2);
  });

  /**
   * 창이 좁다. 러너는 **기록 먼저, 반납 나중**이므로 그 사이에 죽으면 저널은 종단인데
   * 실행권이 남는다. 정상 실행 뒤에 fence 하면 이미 반납된 뒤라 승계가 아예 안 일어나
   * 아무것도 검증하지 못한다 — 뮤테이션으로 확인했다.
   */
  it('**종단으로 끝난 저널은 덮지 않는다** — 좌표와 다른 말을 하면 안 된다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const op = OP('done');

    // **전 평면을 넘긴다.** 전에는 http 만 commit 하고 저널을 `activated` 로 적었는데,
    // 그건 실제 코드가 만들 수 없는 상태다 — `activated` 는 선언한 평면이 전부 넘어갔을
    // 때만 쓰인다. 불가능한 전제 위에서는 무엇을 확인해도 뜻이 없다 (14차 검수가
    // I6 으로 이 픽스처를 짚었다). 확인하려는 것(종단 저널을 안 덮는다)은 그대로다.
    await agent.reserveAll(op);
    for (const plane of ['http', 'stream'] as const) {
      await agent.stage(tupleFor(op, plane), null);
      await agent.commit(tupleFor(op, plane), { acceptingGeneration: 'gen-1' });
    }
    await agent.writeJournal({
      op, phase: 'activated', reloadAttempts: 1, seq: 1,
      progress: { http: 'committed', stream: 'committed' },
    });
    // 여기서 죽었다고 치자 — 저널은 종단인데 실행권이 아직 남아 있다.
    expect(agent.activeOperation(), '창을 만들지 못했다').toBeDefined();
    expect(agent.coordinate('http').activationEpoch).toBe('1');

    await new DpAgent(store).fence('11');
    expect(agent.readJournal()?.phase, 'activated 를 superseded 로 덮었다').toBe('activated');
    expect(agent.activeOperation(), '실행권은 놓아야 한다').toBeUndefined();
  });
});

// ── ③ 남의 저널에 쓰지 않는다 ───────────────────────────────────────────

describe('③ 관측 결과는 내 저널에만 쓴다', () => {
  /**
   * 창이 좁고, **신임 작업이 아직 진행 중이어야 한다.**
   *
   * 신임이 이미 끝났으면 `activeOperation` 이 비어 있어서 저널 쓰기가 먼저 막는다.
   * 그 상태로 시험했더니 `mine` 검사를 빼도 통과했다 — 검사하지 않는 것을 검사한다고
   * 믿을 뻔했다. 신임이 실행권을 쥐고 있는 동안이라야 옛 러너의 쓰기가 **소유권 검사를
   * 통과해** 남의 저널에 착지한다.
   */
  it('진행 중인 신임 저널에 옛 러너의 관측이 들어가지 않는다', async () => {
    const store = new MemoryStore();
    const oldAgent = new DpAgent(store);
    const newAgent = new DpAgent(store);
    const oldOp = OP('old');
    const newOp = OP('new', 'gen-1', { leaderToken: '11' });

    await oldAgent.reserveAll(oldOp);
    await oldAgent.writeJournal({
      op: oldOp, phase: 'reload_intent', reloadAttempts: 0, seq: 1, progress: { http: 'staged' },
    });

    let handed = false;
    class Handover extends FakeEffects {
      override async observeActivation() {
        if (!handed) return undefined; // 아직 안 넘어갔다 → HUP 을 보내게 한다
        // `awaitActivation` 안이다. 신임이 실행권과 저널을 **쥔 채로** 진행 중이다.
        return { acceptingGeneration: 'gen-1', errorLogGrowth: 0, masterPid: '옛-러너' };
      }
      override async signalReload(lease: ApplyLease) {
        await super.signalReload(lease);
        // 승계하고 신임이 자기 저널을 연다 — 아직 끝나지 않았다.
        await newAgent.fence('11');
        await newAgent.reserveAll(newOp);
        await newAgent.writeJournal({
          op: newOp, phase: 'publish_intent', reloadAttempts: 0,
          seq: (newAgent.readJournal()?.seq ?? 0) + 1, progress: { http: 'reserved' },
        });
        // 이 시점에 신임이 실행권과 저널을 **쥔 채로** 진행 중이다 — 그래야 옛 러너의
        // 쓰기가 소유권 검사를 통과한다.
        expect(newAgent.activeOperation()?.operationId, '창을 만들지 못했다').toBe('new');
        handed = true;
      }
    }

    await new ApplyRunner(oldAgent, new Handover(), FAST).recover().catch(() => undefined);

    const journal = newAgent.readJournal();
    expect(journal?.op.operationId, '옛 러너가 저널 주인을 바꿨다').toBe('new');
    // **주인 이름은 그대로 두고 내용만 덮을 수 있다.** 그래서 내용을 본다.
    expect(journal?.evidence?.masterPid, '옛 러너의 관측이 신임 저널에 들어갔다').toBeUndefined();
  });
});

// ── ⑤ abort 가 실행권을 놓는다 ──────────────────────────────────────────

describe('⑤ abortConfig 는 실행권까지 놓는다', () => {
  it('abort 뒤 다음 오퍼레이션이 막히지 않는다', async () => {
    const store = new MemoryStore();
    const inspect = new DpAgent(store);
    const driver = LocalDataplaneDriver.create({ store, effects: new FakeEffects() });

    await inspect.reserveAll(OP('old'));
    await driver.abortConfig(OP('old'));

    expect(inspect.reservationOwner('http', '1')).toBeUndefined();
    expect(inspect.activeOperation(), 'abort 했는데 실행권이 남았다').toBeUndefined();
    expect(await kindOf(inspect.reserveAll(OP('new')))).toBe('통과');
  });
});

// ── ④ 저장소는 내부를 모른다 ────────────────────────────────────────────

describe('④ DurableStore 는 내부 상태기계를 동결하지 않는다', () => {
  /**
   * 9차 검수 ④ — 전에는 "불투명" 이라 적어 놓고 실제로는 `AgentState` 의 모양을
   * 요구했다. `{version}` 만 보관하는 정직한 구현은 두 번째 쓰기에서 깨졌다.
   * 이제 저장소가 보는 것은 **봉투**뿐이다: 버전과, 해석하지 않는 payload.
   */
  it('저장소는 version 과 불투명 payload 만 안다', async () => {
    const seen: Array<{ version: number; payload: unknown }> = [];
    const store = {
      state: undefined as { version: number; payload: unknown } | undefined,
      load() {
        return this.state;
      },
      async save(next: { version: number; payload: unknown }) {
        // **내용을 들여다보지 않는다.** 버전만 보고 그대로 보관한다.
        seen.push({ version: next.version, payload: next.payload });
        this.state = next;
      },
    };

    const agent = new DpAgent(store);
    await agent.fence('10');
    await agent.fence('11');

    // 저장소가 본 것은 버전이 하나씩 오르는 불투명한 값뿐이다.
    expect(seen.map((s) => s.version)).toEqual([1, 2]);
    // 그리고 그것을 그대로 돌려주면 Agent 가 이어서 쓴다.
    expect(agent.maxLeaderToken()).toBe('11');
  });

  it('불투명 payload 를 그대로 보관했다 돌려주면 복구된다', async () => {
    const store = new MemoryStore();
    const first = new DpAgent(store);
    await first.reserveAll(OP('op'));

    // 저장소가 내용을 해석하지 않고 옮겼다고 치자.
    const carried: unknown = structuredClone(store.load());
    const moved = new MemoryStore();
    await moved.save(carried as never);

    const second = new DpAgent(moved);
    expect(second.activeOperation()?.operationId).toBe('op');
    expect(second.reservationOwner('http', '1')?.operationId).toBe('op');
  });
});
