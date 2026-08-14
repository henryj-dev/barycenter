/**
 * 7차 검수 반례 ① — 새 리더가 진행 중인 작업을 승계한다 (DESIGN.md §3.5 · §6.2)
 *
 * 6차 반례 ③(동시 멱등성)을 고치려고 전역 `activeOperation` 을 넣었다. 그러면서 구멍을
 * 하나 열었다. **하나를 막고 다른 하나를 열었다.**
 *
 *   fence(11) 뒤:
 *     옛 저널 복구        → stale_leader
 *     새 리더의 새 작업   → operation_in_flight
 *     abortConfig 로 풀기 → stale_leader     ← 옛 토큰이라 거부된다
 *
 * **푸는 방법 자체가 없었다.** 새 리더가 apply 경로를 영영 못 잡는다. 리더 교체는 장애
 * 상황에서 일어나는 일인데, 하필 그때 컨트롤 플레인이 아무것도 못 하게 된다.
 *
 * 고치는 방식: **펜싱이 곧 승계다.** 더 높은 토큰이 `fence` 를 완료하면 옛 리더는 더
 * 이상 행동할 수 없으므로, 그 자리에서 옛 오퍼레이션의 예약을 반납하고 저널을 종단
 * (`superseded`)으로 닫는다. 새 리더는 관측으로 세상을 다시 읽고 자기 오퍼레이션을 낸다
 * (§3.3 — 되돌리는 것이 아니라 새 활성화 사건이다).
 */
import { describe, expect, it } from 'vitest';
import { DpAgent, DpRejection, MemoryStore, tupleFor } from '../../src/dp/agent.js';
import { ApplyRunner, FakeEffects, recordOf } from '../../src/dp/apply.js';
import type { ApplyOperation, PublishedState } from '../../src/dp/operation.js';

const OP = (o: Partial<ApplyOperation> = {}): ApplyOperation => ({
  leaderToken: '10',
  operationId: 'op-1',
  transitionId: 't-1',
  affectedPlanes: ['http'],
  targetGeneration: 'gen-1',
  generationDigest: 'sha256:g',
  planes: {
    http: {
      expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
      target: { activationEpoch: '1', membershipRevision: '1' },
      payloadDigest: 'sha256:h',
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

/** 옛 리더가 게시 직전까지 가서 멈춘 상태를 만든다. */
async function stalled(): Promise<{ agent: DpAgent; old: ApplyOperation }> {
  const agent = new DpAgent(new MemoryStore());
  const old = OP({ leaderToken: '10' });
  const fx = new FakeEffects();
  fx.crashBeforeEffect = 'publish';
  await new ApplyRunner(agent, fx, FAST).run(old).catch(() => undefined);
  expect(agent.activeOperation()?.operationId, '옛 작업이 apply 경로를 쥐고 있어야 한다').toBe('op-1');
  return { agent, old };
}

describe('① 새 리더가 들어오면 apply 경로가 풀린다', () => {
  it('fence 가 옛 오퍼레이션을 승계한다', async () => {
    const { agent } = await stalled();
    await agent.fence('11');
    expect(agent.activeOperation(), 'apply 경로가 잠긴 채로 남았다').toBeUndefined();
  });

  it('**새 리더가 자기 작업을 낼 수 있다** — 이게 없으면 장애 때 아무것도 못 한다', async () => {
    const { agent } = await stalled();
    await agent.fence('11');

    const fresh = OP({ leaderToken: '11', operationId: 'new', transitionId: 'new' });
    const r = await new ApplyRunner(agent, new FakeEffects(), FAST).run(fresh);
    expect(r.phase).toBe('activated');
    expect(agent.coordinate('http').activationEpoch).toBe('1');
  });

  it('옛 오퍼레이션의 예약이 반납된다 — 좌표가 잠기면 새 리더도 못 쓴다', async () => {
    const { agent } = await stalled();
    expect(agent.reservationOwner('http', '1')?.operationId).toBe('op-1');
    await agent.fence('11');
    expect(agent.reservationOwner('http', '1'), '옛 예약이 남았다').toBeUndefined();
  });

  it('옛 저널은 superseded 로 닫힌다 — 복구가 매달리지 않는다', async () => {
    const { agent } = await stalled();
    await agent.fence('11');
    expect(agent.readJournal()?.phase).toBe('superseded');

    const r = await new ApplyRunner(agent, new FakeEffects(), FAST).recover();
    expect(r.phase, '복구가 종단을 못 알아본다').toBe('superseded');
  });

  it('승계된 오퍼레이션은 되살아나지 않는다', async () => {
    const { agent, old } = await stalled();
    await agent.fence('11');
    // 옛 리더가 살아 있었더라도 이제 아무것도 못 한다.
    expect(await kindOf(new ApplyRunner(agent, new FakeEffects(), FAST).run(old))).toBe('stale_leader');
  });

  it('이미 넘어간 평면의 좌표는 그대로다 — 승계는 되돌리기가 아니다 (§3.3)', async () => {
    const agent = new DpAgent(new MemoryStore());
    await new ApplyRunner(agent, new FakeEffects(), FAST).run(OP({ leaderToken: '10' }));
    expect(agent.coordinate('http').activationEpoch).toBe('1');

    await agent.fence('11');
    expect(agent.coordinate('http').activationEpoch, '승계가 좌표를 되돌렸다').toBe('1');
  });
});

describe('같은 리더의 재-fence 는 자기 작업을 죽이지 않는다', () => {
  it('같은 토큰으로 다시 fence 해도 진행 중인 것이 살아 있다', async () => {
    const { agent } = await stalled();
    await agent.fence('10');
    expect(agent.activeOperation()?.operationId, '자기 작업을 스스로 승계했다').toBe('op-1');
    expect(agent.readJournal()?.phase).not.toBe('superseded');
  });

  it('낮은 토큰의 fence 는 애초에 거부된다', async () => {
    const { agent } = await stalled();
    expect(await kindOf(agent.fence('9'))).toBe('stale_leader');
    expect(agent.activeOperation()?.operationId).toBe('op-1');
  });
});

describe('승계 뒤에도 진행 중이던 작업을 이어받을 수 있다', () => {
  /**
   * ⚠️ **이 테스트는 한때 조작돼 있었다.**
   *
   * 수렴 방식으로 바꾸면서 픽스처를 `operationId: 'takeover'` 로 고쳤다 — 즉 "옛 리더가
   * 게시했다" 가 아니라 "**내가 이미 게시했다**" 로 바꿔 놓고 "다시 게시하지 않는다" 를
   * 통과시켰다. 코드에 맞춰 테스트를 고친 것이다. 10차 검수가 그걸 지적했다.
   *
   * 사실로 되돌린다. 옛 리더의 게시는 **내 것이 아니고**, 그래서 새 리더는 **다시
   * 게시한다.** 그게 수렴이다.
   */
  it('새 리더는 옛 리더의 게시를 자기 것으로 덮는다', async () => {
    const { agent } = await stalled();
    const fx = new FakeEffects();
    // 옛 리더(토큰 10, 자기 오퍼레이션)가 게시까지는 했다.
    fx.publishedRecord = {
      generation: 'gen-1',
      leaderToken: '10',
      operationId: 'op-1',
      transitionId: 't-1',
      generationDigest: 'sha256:g',
    };

    await agent.fence('11');
    const mine = OP({ leaderToken: '11', operationId: 'takeover', transitionId: 'takeover' });
    const r = await new ApplyRunner(agent, fx, FAST).run(mine);

    expect(r.phase).toBe('activated');
    expect(fx.publishCalls, '남의 게시를 그대로 두고 활성화로 끝냈다').toBeGreaterThan(0);
    expect(fx.publishedRecord?.operationId).toBe('takeover');
    expect(fx.publishedRecord?.leaderToken).toBe('11');
  });
});

// ── ② 펜싱 TOCTOU — 창을 좁혔고, 남는 것은 경계가 있다 ──────────────────

describe('② 관측 중 리더가 바뀌어도 좌표는 안전하다', () => {
  /**
   * **완전히 닫히지 않는다.** 검사와 부작용 사이의 틈을 없애려면 nginx 가 리더 토큰을
   * 이해해야 하는데 심볼릭 링크 교체와 SIGHUP 에는 그런 자리가 없다.
   *
   * 그래서 무엇이 안전하고 무엇이 아닌지를 못박는다.
   */
  it('관측 뒤 · 게시 앞의 검사가 옛 리더를 막는다', async () => {
    const agent = new DpAgent(new MemoryStore());
    const op = OP({ leaderToken: '10' });
    await agent.reserveAll(op);
    await agent.writeJournal({
      op, phase: 'publish_intent', reloadAttempts: 0, seq: 1, progress: { http: 'reserved' },
    });

    class Slow extends FakeEffects {
      override async observePublished(): Promise<PublishedState> {
        // 루프 머리의 검사는 이미 지났다. 이 await 안에서 새 리더가 완주한다.
        await agent.fence('11');
        return super.observePublished();
      }
    }
    const fx = new Slow();
    await new ApplyRunner(agent, fx, FAST).recover().catch(() => undefined);

    expect(fx.publishCalls, '관측 뒤 검사가 없으면 여기서 1 이 된다').toBe(0);
    expect(fx.reloadSignals).toBe(0);
  });

  it('**좌표는 어떤 경우에도 안전하다** — commit 은 직렬 구간에서 토큰을 다시 본다', async () => {
    const agent = new DpAgent(new MemoryStore());
    const op = OP({ leaderToken: '10' });
    await agent.reserveAll(op);
    await agent.stage(tupleFor(op, 'http'), null);

    await agent.fence('11'); // 새 리더가 들어온다 (승계로 예약이 반납된다)

    expect(
      await kindOf(agent.commit(tupleFor(op, 'http'), { acceptingGeneration: 'gen-1' })),
      '낡은 리더가 좌표를 옮겼다',
    ).not.toBe('통과');
    expect(agent.coordinate('http').activationEpoch).toBe('0');
  });
});
