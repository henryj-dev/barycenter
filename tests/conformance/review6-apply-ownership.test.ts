/**
 * 6차 검수 반례 ②③④⑥⑦ — 전역 apply 소유권 (DESIGN.md §3.5 · §3.6 · §6.2 · §6.3)
 *
 * 다섯 반례는 증상이 다르지만 원인이 하나다. **예약이 슬롯만 독점하고 apply 실행권을
 * 독점하지 않았다.** 저널도 `current` 도 HUP 도 전역인데 예약은 (평면, epoch) 별이다.
 *
 *   ② `commit()` 이 증거를 **기록만** 하고 검사하지 않는다.
 *   ③ 같은 오퍼레이션 6개를 동시에 보내면 전부 성공하고 HUP 이 6회 나간다.
 *   ④ `partially_activated` 가 종단이라 복구가 재시도하지 않고 예약이 남는다.
 *   ⑥ `drive()` 가 리더 토큰을 재검사하지 않아 **복구 경로로 들어오면 게시한다.**
 *   ⑦ `'1'` 과 `'01'` 이 서로 다른 슬롯을 잡는다.
 *
 * 고치는 방식도 하나다.
 *   · 전역 `activeOperation` — 한 번에 한 오퍼레이션만 apply 경로를 갖는다.
 *   · 저널에 `seq` CAS — 단계 전이를 한 명만 이긴다. 진 쪽은 다시 읽고 따라간다.
 *   · 매 단계 **부작용 앞에서** 소유권과 토큰을 재확인한다.
 *   · 좌표는 정규형으로만 저장한다.
 *   · `commit` 이 증거를 직접 판정한다 — §3.5 는 Agent 가 최종 심판이라고 말한다.
 */
import { describe, expect, it } from 'vitest';
import { DpAgent, DpRejection, MemoryStore, tupleFor } from '../../src/dp/agent.js';
import { ApplyRunner, FakeEffects } from '../../src/dp/apply.js';
import type { ActivationEvidence, ApplyOperation } from '../../src/dp/operation.js';

const OP = (o: Partial<ApplyOperation> = {}): ApplyOperation => ({
  leaderToken: '10',
  operationId: 'op-1',
  transitionId: 't-1',
  affectedPlanes: ['http'],
  targetGeneration: 'gen-1',
  planes: {
    http: {
      expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
      target: { activationEpoch: '1', membershipRevision: '1' },
      payloadDigest: 'sha256:h',
    },
  },
  ...o,
});

const BOTH = (o: Partial<ApplyOperation> = {}): ApplyOperation =>
  OP({
    affectedPlanes: ['http', 'stream'],
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
const GOOD: ActivationEvidence = { acceptingGeneration: 'gen-1' };

const kindOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return '거부되지 않았다';
  } catch (e) {
    return e instanceof DpRejection ? e.kind : (e as Error).name;
  }
};

// ── ② 증거는 기록이 아니라 검사다 ───────────────────────────────────────

describe('② Agent 가 증거를 직접 판정한다 (§3.5 · §6.3)', () => {
  const staged = async (): Promise<DpAgent> => {
    const agent = new DpAgent(new MemoryStore());
    const t = tupleFor(OP(), 'http');
    await agent.reserve(t);
    await agent.stage(t, null);
    return agent;
  };

  it('세대가 다른 증거로는 좌표가 움직이지 않는다', async () => {
    const agent = await staged();
    expect(await kindOf(agent.commit(tupleFor(OP(), 'http'), { acceptingGeneration: 'gen-다름' })))
      .toBe('not_activated');
    expect(agent.coordinate('http').activationEpoch).toBe('0');
  });

  it('config test 가 실패한 증거로도 움직이지 않는다', async () => {
    const agent = await staged();
    expect(
      await kindOf(agent.commit(tupleFor(OP(), 'http'), { ...GOOD, configTestPassed: false })),
    ).toBe('not_activated');
  });

  it('error log 가 늘어난 증거로도 움직이지 않는다', async () => {
    const agent = await staged();
    expect(await kindOf(agent.commit(tupleFor(OP(), 'http'), { ...GOOD, errorLogGrowth: 7 })))
      .toBe('not_activated');
  });

  it('워커가 덜 보고한 증거로도 움직이지 않는다', async () => {
    const agent = await staged();
    expect(
      await kindOf(
        agent.commit(tupleFor(OP(), 'http'), { ...GOOD, workersExpected: 4, workersReported: 0 }),
      ),
    ).toBe('not_activated');
  });

  it('좋은 증거로는 움직인다 — 막는 것만 하는 게 아니다', async () => {
    const agent = await staged();
    const ack = await agent.commit(tupleFor(OP(), 'http'), GOOD);
    expect(ack.activationEpoch).toBe('1');
    expect(agent.evidenceFor('http', '1')?.acceptingGeneration).toBe('gen-1');
  });
});

// ── ③ 동시 멱등성 ───────────────────────────────────────────────────────

describe('③ 같은 오퍼레이션을 동시에 여러 번 보내도 HUP 은 한 번이다', () => {
  it('6개 동시 실행 — reload 상한이 우회되지 않는다', async () => {
    const agent = new DpAgent(new MemoryStore());
    const effects = new FakeEffects();

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => new ApplyRunner(agent, effects, FAST).run(OP())),
    );

    const done = results.filter(
      (r) => r.status === 'fulfilled' && r.value.phase === 'activated',
    ).length;
    expect(done, '아무도 끝내지 못했다').toBeGreaterThan(0);
    expect(effects.publishCalls, '게시가 여러 번 일어났다').toBe(1);
    expect(effects.reloadSignals, 'HUP 이 여러 번 나갔다 — reload 상한이 무의미해진다').toBe(1);
    expect(agent.coordinate('http').activationEpoch).toBe('1');
  });

  it('다른 오퍼레이션이 끼어들면 거부된다 — 한 번에 하나만 apply 한다', async () => {
    const agent = new DpAgent(new MemoryStore());
    const a = OP({ operationId: 'A', transitionId: 'A' });
    const b = OP({
      operationId: 'B',
      transitionId: 'B',
      targetGeneration: 'gen-B',
      planes: {
        stream: {
          expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
          target: { activationEpoch: '1', membershipRevision: '1' },
          payloadDigest: 'sha256:B',
        },
      },
      affectedPlanes: ['stream'],
    });

    // A 를 게시 직전까지 진행시킨 뒤 B 를 넣는다.
    const stuck = new FakeEffects();
    stuck.crashBeforeEffect = 'publish';
    await new ApplyRunner(agent, stuck, FAST).run(a).catch(() => undefined);

    const fx = new FakeEffects();
    expect(await kindOf(new ApplyRunner(agent, fx, FAST).run(b))).toBe('operation_in_flight');
    expect(fx.publishCalls, '끼어든 오퍼레이션이 게시했다').toBe(0);

    // **거부됐다는 것만으로는 부족하다.** 거부되기 전에 자원을 가져갔는지 봐야 한다 —
    // 뮤테이션으로 확인해 보니 소유권 검사를 빼도 이 테스트가 통과했다. B 가 예약을
    // 훔친 뒤 다른 지점에서 막혔을 뿐이었다.
    expect(agent.activeOperation()?.operationId, 'apply 경로의 주인이 바뀌었다').toBe('A');
    expect(agent.reservationOwner('stream', '1'), '끼어든 오퍼레이션이 예약을 가져갔다')
      .toBeUndefined();
  });
});

// ── ④ partial 은 종단이 아니다 ──────────────────────────────────────────

describe('④ partially_activated 에서 복구가 이어받는다 (§6.2 #8)', () => {
  /** stream 만 commit 이 거부되게 만든다 — stage 를 건너뛴다. */
  async function halfway(): Promise<{ agent: DpAgent; op: ApplyOperation; fx: FakeEffects }> {
    const agent = new DpAgent(new MemoryStore());
    const op = BOTH();
    const fx = new FakeEffects();
    fx.publishedGeneration = 'gen-1';
    fx.acceptingGeneration = 'gen-1';

    await agent.reserveAll(op);
    await agent.stage(tupleFor(op, 'http'), null);
    // stream 은 일부러 stage 하지 않는다.
    await agent.writeJournal({
      op,
      phase: 'reload_observed',
      reloadAttempts: 1,
      seq: (agent.readJournal()?.seq ?? 0) + 1,
      progress: { http: 'staged', stream: 'reserved' },
    });
    return { agent, op, fx };
  }

  it('한 평면만 넘어가면 partially_activated 로 보고한다', async () => {
    const { agent, fx } = await halfway();
    const r = await new ApplyRunner(agent, fx, FAST).recover();
    expect(r.phase).toBe('partially_activated');
    expect(r.partialTransition).toBe(true);
    expect(r.progress.http).toBe('committed');
    expect(r.progress.stream).not.toBe('committed');
  });

  it('**못 넘어간 평면의 예약이 남지 않는다** — 좌표가 영구히 잠기면 안 된다', async () => {
    const { agent, fx } = await halfway();
    await new ApplyRunner(agent, fx, FAST).recover();
    expect(
      agent.reservationOwner('stream', '1'),
      'stream 예약이 남았다 — 다음 오퍼레이션이 그 좌표를 못 쓴다',
    ).toBeUndefined();
  });

  it('다음 오퍼레이션이 못 넘어간 평면을 다시 잡을 수 있다', async () => {
    const { agent, fx } = await halfway();
    await new ApplyRunner(agent, fx, FAST).recover();

    const retry = OP({
      operationId: 'retry',
      transitionId: 'retry',
      affectedPlanes: ['stream'],
      planes: {
        stream: {
          expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
          target: { activationEpoch: '1', membershipRevision: '1' },
          payloadDigest: 'sha256:retry',
        },
      },
    });
    const ack = await agent.reserveAll(retry);
    expect(ack.length).toBe(1);
  });

  it('전역 소유권도 반납된다 — 다음 apply 가 막히면 안 된다', async () => {
    const { agent, fx } = await halfway();
    await new ApplyRunner(agent, fx, FAST).recover();
    expect(agent.activeOperation(), 'apply 경로가 잠긴 채로 남았다').toBeUndefined();
  });
});

// ── ⑥ 복구 경로에도 펜싱이 있다 ────────────────────────────────────────

describe('⑥ 복구도 부작용 앞에서 펜싱을 지난다 (§3.5)', () => {
  it('새 리더가 fence 한 뒤 옛 복구는 게시하지 못한다', async () => {
    const agent = new DpAgent(new MemoryStore());
    const op = OP({ leaderToken: '10' });
    await agent.reserveAll(op);
    await agent.writeJournal({
      op,
      phase: 'publish_intent',
      reloadAttempts: 0,
      seq: 1,
      progress: { http: 'reserved' },
    });

    await agent.fence('11'); // 새 리더 등장

    const fx = new FakeEffects();
    expect(await kindOf(new ApplyRunner(agent, fx, FAST).recover())).toBe('stale_leader');
    expect(fx.publishCalls, '§3.5 — 거부될 오퍼레이션이 current 를 옮겼다').toBe(0);
    expect(fx.reloadSignals).toBe(0);
    expect(agent.coordinate('http').activationEpoch).toBe('0');
  });

  it('같은 리더의 복구는 정상 진행한다 — 막는 것만 하는 게 아니다', async () => {
    const agent = new DpAgent(new MemoryStore());
    const op = OP({ leaderToken: '10' });
    await agent.reserveAll(op);
    await agent.writeJournal({
      op, phase: 'publish_intent', reloadAttempts: 0, seq: 1, progress: { http: 'reserved' },
    });
    const fx = new FakeEffects();
    const r = await new ApplyRunner(agent, fx, FAST).recover();
    expect(r.phase).toBe('activated');
    expect(fx.publishCalls).toBe(1);
  });
});

// ── ⑦ 좌표는 정규형이다 ────────────────────────────────────────────────

describe('⑦ 좌표 문자열은 정규형으로만 산다', () => {
  it("'01' 은 '1' 과 같은 슬롯이다", async () => {
    const agent = new DpAgent(new MemoryStore());
    const a = tupleFor(OP({ operationId: 'A', transitionId: 'A' }), 'http');
    const b = tupleFor(
      OP({
        operationId: 'B',
        transitionId: 'B',
        planes: {
          http: {
            expectedCurrent: { activationEpoch: '00', membershipRevision: '0' },
            target: { activationEpoch: '01', membershipRevision: '1' },
            payloadDigest: 'sha256:B',
          },
        },
      }),
      'http',
    );
    await agent.reserve(a);
    expect(await kindOf(agent.reserve(b))).toBe('slot_taken');
  });

  it('저장되는 좌표도 정규형이다', async () => {
    const agent = new DpAgent(new MemoryStore());
    const t = tupleFor(
      OP({
        planes: {
          http: {
            expectedCurrent: { activationEpoch: '000', membershipRevision: '0' },
            target: { activationEpoch: '007', membershipRevision: '009' },
            payloadDigest: 'sha256:h',
          },
        },
      }),
      'http',
    );
    await agent.reserve(t);
    await agent.stage(t, null);
    await agent.commit(t, GOOD);
    expect(agent.coordinate('http').activationEpoch).toBe('7');
    expect(agent.coordinate('http').membershipRevision).toBe('9');
    expect(agent.stagedDigest('http', '7')).toBeUndefined();
    expect(agent.evidenceFor('http', '7')?.acceptingGeneration).toBe('gen-1');
  });

  it('숫자가 아닌 좌표는 거부된다', async () => {
    const agent = new DpAgent(new MemoryStore());
    // 정규화는 튜플을 만드는 시점에 한다 — 잘못된 좌표는 Agent 에 닿지도 못한다.
    const build = () => tupleFor(
      OP({
        planes: {
          http: {
            expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
            target: { activationEpoch: '1e3', membershipRevision: '1' },
            payloadDigest: 'sha256:h',
          },
        },
      }),
      'http',
    );
    expect(await kindOf(Promise.resolve().then(() => agent.reserve(build())))).toBe('invalid_coordinate');
  });
});

// ── 연속 오퍼레이션 ─────────────────────────────────────────────────────

describe('앞선 오퍼레이션의 종단 저널이 다음 것을 막지 않는다', () => {
  /**
   * 실물 e2e 가 먼저 잡은 것이다. 저널은 하나뿐이라 앞선 오퍼레이션의 종단 기록이
   * 남아 있는데, 그걸 그대로 두고 진행하면 **남의 저널을 읽고 스스로 막힌다.**
   */
  it('두 오퍼레이션이 연달아 돈다', async () => {
    const agent = new DpAgent(new MemoryStore());
    const fx = new FakeEffects();

    const first = await new ApplyRunner(agent, fx, FAST).run(OP({ operationId: 'A', transitionId: 'A' }));
    expect(first.phase).toBe('activated');

    const second = await new ApplyRunner(agent, fx, FAST).run(
      OP({
        operationId: 'B',
        transitionId: 'B',
        targetGeneration: 'gen-2',
        planes: {
          http: {
            expectedCurrent: { activationEpoch: '1', membershipRevision: '1' },
            target: { activationEpoch: '2', membershipRevision: '2' },
            payloadDigest: 'sha256:B',
          },
        },
      }),
    );
    expect(second.phase, 'B 가 A 의 종단 저널에 막혔다').toBe('activated');
    expect(agent.coordinate('http').activationEpoch).toBe('2');
    expect(agent.activeOperation()).toBeUndefined();
  });
});
