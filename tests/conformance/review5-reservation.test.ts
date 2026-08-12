/**
 * 5차 검수 반례 — 소유권 예약 (DESIGN.md §9.1.1 blocker 1)
 *
 * **이 파일은 남이 재현한 반례다.** 검수가 녹색 테스트 상태에서 다섯 가지를 재현했고,
 * 다섯 가지 증상의 원인은 하나였다 — durable **active-operation 예약**이 없어서
 * "이 좌표는 누구 것인가" 를 아무도 소유하지 않는다.
 *
 * 그래서 단위 테스트가 아니라 conformance 로 따로 둔다. 구현이 바뀌어도 이 파일은
 * 그대로 남아야 한다. 여기 있는 것은 우리 구현의 사정이 아니라 **계약**이다.
 *
 *   ① 낮은 리더 토큰은 side effect 앞에서 막힌다        §3.5
 *   ② 남의 오퍼레이션이 내 저널을 덮지 못한다            §6.2
 *   ③ 같은 store 를 보는 두 인스턴스가 토큰을 되감지 못한다  §3.5
 *   ④ (plane, target_activation_epoch) 슬롯은 한 명만 갖는다  §3.6
 *   ⑥ 종단 상태에 들어간 전환은 되살아나지 않는다        §6.2
 *
 * ⑤(헬스 진행이 commit 을 깬다)와 ⑦(모델 fail-closed)은 여기 없다. ⑤ 는 §6.5 커서와
 * 함께 v0.3 으로, ⑦ 은 blocker 4 로 간다 (§9.1.1).
 */
import { describe, expect, it } from 'vitest';
import {
  DpAgent,
  DpRejection,
  MemoryStore,
  type OperationTuple,
} from '../../src/dp/agent.js';
import { ApplyRunner, FakeEffects } from '../../src/dp/apply.js';
import type { ActivationEvidence, ApplyOperation } from '../../src/dp/operation.js';

const EVIDENCE: ActivationEvidence = { acceptingGeneration: 'gen-1' };

/** 튜플 하나를 한 평면짜리 오퍼레이션으로 감싼다. 예약 계약은 평면 수와 무관하다. */
const APPLY = (op: OperationTuple, generation = 'gen-1'): ApplyOperation => ({
  leaderToken: op.leaderToken,
  operationId: op.operationId,
  transitionId: op.transitionId,
  affectedPlanes: [op.plane],
  targetGeneration: generation,
  planes: {
    [op.plane]: {
      expectedCurrent: op.expectedCurrent,
      target: op.target,
      payloadDigest: op.payloadDigest,
    },
  },
});

const OP = (o: Partial<OperationTuple> = {}): OperationTuple => ({
  leaderToken: '10',
  operationId: 'op-1',
  transitionId: 't-1',
  plane: 'http',
  expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
  target: { activationEpoch: '1', membershipRevision: '1' },
  payloadDigest: 'sha256:a',
  targetGeneration: 'gen-1',
  ...o,
});

const FAST = { attempts: 1, intervalMs: 0, sleep: async () => {} };

const kindOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return '거부되지 않았다';
  } catch (e) {
    return e instanceof DpRejection ? e.kind : `${(e as Error).message}`;
  }
};

// ── ① 부작용 전 펜싱 ─────────────────────────────────────────────────────

describe('① 낮은 리더 토큰은 side effect 앞에서 막힌다 (§3.5)', () => {
  it('게시도 저널 기록도 일어나지 않는다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    await agent.fence('99');

    const effects = new FakeEffects();
    expect(await kindOf(new ApplyRunner(agent, effects, FAST).run(APPLY(OP({ leaderToken: '10' })))))
      .toBe('stale_leader');

    // **이 세 줄이 계약이다.** 판정이 stale_leader 여도 부작용이 남으면 위반이다.
    expect(effects.publishCalls, 'current 를 이미 옮겼다').toBe(0);
    expect(effects.reloadSignals, 'HUP 을 보냈다').toBe(0);
    expect(store.load()?.journal, '저널을 남겼다').toBeUndefined();
    expect(agent.coordinate('http').activationEpoch).toBe('0');
  });

  it('토큰이 같거나 높으면 정상 진행한다 — 막는 것만 하는 게 아니다', async () => {
    const agent = new DpAgent(new MemoryStore());
    await agent.fence('10');
    const effects = new FakeEffects();
    expect((await new ApplyRunner(agent, effects, FAST).run(APPLY(OP({ leaderToken: '10' }))))
      .phase).toBe('activated');
    expect(effects.publishCalls).toBe(1);
  });
});

// ── ② 저널 소유권 ────────────────────────────────────────────────────────

describe('② 남의 오퍼레이션이 내 저널을 덮지 못한다 (§6.2)', () => {
  it('B 가 끝난 뒤 늦게 깨어난 A 의 저널 쓰기는 거부된다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const opB = OP({ operationId: 'B', transitionId: 'B' });

    await new ApplyRunner(agent, new FakeEffects(), FAST).run(APPLY(opB, 'gen-B'));
    expect(agent.coordinate('http').activationEpoch).toBe('1');

    const opA = OP({ operationId: 'A', transitionId: 'A' });
    expect(
      await kindOf(
        agent.writeJournal({ op: APPLY(opA, 'gen-A'), phase: 'published', reloadAttempts: 0, seq: 1 }),
      ),
    ).toBe('not_reserved');

    // 저널이 B 의 종단 상태 그대로여야 한다.
    expect(store.load()?.journal?.op.operationId ?? 'B(정리됨)').not.toBe('A');
  });
});

// ── ③ 인스턴스 간 lost update ────────────────────────────────────────────

describe('③ 두 인스턴스가 토큰을 되감지 못한다 (§3.5)', () => {
  it('동시에 fence 해도 durable 토큰은 최대값이다', async () => {
    // durable 저장이 느려야 창이 열린다. delay 가 없으면 반례가 재현되지 않는다.
    const store = new MemoryStore(1);
    const a = new DpAgent(store);
    const b = new DpAgent(store);

    await Promise.allSettled([a.fence('12'), b.fence('11')]);
    expect(store.load()?.maxLeaderToken, '낮은 토큰이 높은 토큰을 덮었다').toBe('12');
  });

  it('교차 실행에서도 낮은 토큰의 apply 는 살아남지 못한다', async () => {
    const store = new MemoryStore(1);
    const high = new DpAgent(store);
    const low = new DpAgent(store);

    const results = await Promise.allSettled([
      high.fence('20'),
      low.reserve(OP({ leaderToken: '11' })),
    ]);
    // 낮은 쪽이 이겼더라도 durable 토큰은 20 이어야 하고,
    expect(store.load()?.maxLeaderToken).toBe('20');
    // 예약이 남았다면 그건 20 이 오기 전에 끝난 것이므로, 이후 stage 는 막혀야 한다.
    if (results[1]?.status === 'fulfilled') {
      expect(await kindOf(low.stage(OP({ leaderToken: '11' }), null))).toBe('stale_leader');
    }
  });
});

// ── ④ 슬롯 독점 ──────────────────────────────────────────────────────────

describe('④ (plane, target_activation_epoch) 슬롯은 한 명만 갖는다 (§3.6)', () => {
  const A = OP({ operationId: 'A', transitionId: 'A', payloadDigest: 'sha256:A' });
  const B = OP({ operationId: 'B', transitionId: 'B', payloadDigest: 'sha256:B' });

  it('남이 잡은 슬롯은 예약되지 않는다', async () => {
    const agent = new DpAgent(new MemoryStore());
    await agent.reserve(A);
    expect(await kindOf(agent.reserve(B))).toBe('slot_taken');
  });

  it('남이 잡은 슬롯에 stage 할 수 없다', async () => {
    const agent = new DpAgent(new MemoryStore());
    await agent.reserve(A);
    await agent.stage(A, null);
    expect(await kindOf(agent.stage(B, null))).toBe('slot_taken');
    expect(agent.stagedDigest('http', '1')).toBe('sha256:A');
  });

  it('무관한 오퍼레이션의 abort 는 내 슬롯을 지우지 못한다', async () => {
    const agent = new DpAgent(new MemoryStore());
    await agent.reserve(A);
    await agent.stage(A, null);
    await agent.abort(B).catch(() => undefined);
    expect(agent.stagedDigest('http', '1'), 'B 의 abort 가 A 의 슬롯을 지웠다').toBe('sha256:A');
  });

  it('같은 오퍼레이션의 재요청은 멱등이다 — 막는 것만 하는 게 아니다', async () => {
    const agent = new DpAgent(new MemoryStore());
    const first = await agent.reserve(A);
    const again = await agent.reserve(A);
    expect(again.cached).toBe(true);
    expect(again.activationEpoch).toBe(first.activationEpoch);
  });

  it('id·digest 가 같아도 좌표가 다르면 캐시된 ACK 를 주지 않는다', async () => {
    const agent = new DpAgent(new MemoryStore());
    await agent.reserve(OP());
    await agent.stage(OP(), null);
    const forged = OP({
      expectedCurrent: { activationEpoch: '99', membershipRevision: '99' },
      target: { activationEpoch: '99', membershipRevision: '99' },
    });
    expect(await kindOf(agent.stage(forged, null))).toBe('tuple_mismatch');
  });
});

// ── ⑥ 종단 상태 ──────────────────────────────────────────────────────────

describe('⑥ 종단 상태에 들어간 전환은 되살아나지 않는다 (§6.2)', () => {
  /** HUP 을 보내도 세대가 바뀌지 않는다 — reload 상한을 넘긴다. */
  const deaf = (): FakeEffects => {
    const fx = new FakeEffects();
    fx.reloadTakesEffect = false;
    return fx;
  };

  it('failed 뒤의 지연 commit 은 좌표를 옮기지 못한다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const op = OP();

    expect((await new ApplyRunner(agent, deaf(), FAST).run(APPLY(op))).phase).toBe('failed');
    expect(await kindOf(agent.commit(op, EVIDENCE))).toBe('terminal');
    expect(agent.coordinate('http').activationEpoch, 'failed 인데 좌표가 옮겨갔다').toBe('0');
  });

  it('failed 는 슬롯을 비운다 — 다음 오퍼레이션이 그 좌표를 쓸 수 있다', async () => {
    const agent = new DpAgent(new MemoryStore());
    await new ApplyRunner(agent, deaf(), FAST).run(APPLY(OP()));
    expect(agent.stagedDigest('http', '1'), '실패한 전환의 슬롯이 남았다').toBeUndefined();

    // 새 전환은 같은 좌표를 다시 잡을 수 있어야 한다. 안 그러면 한 번 실패로 영구히 막힌다.
    const retry = OP({ operationId: 'retry', transitionId: 'retry' });
    const ack = await agent.reserve(retry);
    expect(ack.activationEpoch).toBe('1');
  });

  it('abort 뒤의 지연 stage 도 막힌다', async () => {
    const agent = new DpAgent(new MemoryStore());
    const op = OP();
    await agent.reserve(op);
    await agent.abort(op);
    expect(await kindOf(agent.stage(op, null))).toBe('terminal');
  });

  it('commit 된 전환에 abort 가 와도 종단 상태를 오염시키지 않는다', async () => {
    const agent = new DpAgent(new MemoryStore());
    const op = OP();
    await agent.reserve(op);
    await agent.stage(op, null);
    await agent.commit(op, EVIDENCE);
    expect(await kindOf(agent.abort(op))).toBe('terminal');
    expect(agent.coordinate('http').activationEpoch, 'abort 가 활성 좌표를 되돌렸다').toBe('1');
  });
});
