/**
 * S12 — 크래시 저널 (DESIGN.md §6.2)
 *
 * 검증 대상은 **모든 durable write 와 외부 side effect 의 직전/직후**에서 죽었을 때
 * 복구가 정확한가다. 지점을 손으로 고르면 반드시 빠뜨리므로 **전 지점을 훑는다.**
 *
 * 합격 기준은 v4 에서 바뀌었다 (§6.2). HUP 은 exactly-once 로 만들 수 없다 — 마스터
 * cycle 만으로는 "못 보냈다"와 "보냈지만 아직 처리 전"을 구분할 수 없기 때문이다.
 * 그래서 **최종 세대가 정확하고 중복 reload 가 상한 이내**인지를 본다.
 */
import { describe, expect, it } from 'vitest';
import { DpAgent, MemoryStore } from '../../src/dp/agent.js';
import type { ActivationEvidence, ApplyOperation } from '../../src/dp/operation.js';
import {
  ApplyRunner,
  CrashClock,
  CrashInjected,
  FakeEffects,
  FaultStore,
  RELOAD_ATTEMPT_LIMIT,
  type Phase,
} from '../../src/dp/apply.js';

const TARGET = 'gen-000002';

/** 단위 테스트는 실제로 잠들지 않는다. 폴링 정책만 주입한다. */
const FAST = { attempts: 2, intervalMs: 0, sleep: async () => undefined };

/** apply 가 옮기는 멤버십 좌표. §3.6 튜플이 저널을 타고 흐른다. */
const OP: ApplyOperation = {
  leaderToken: '10',
  operationId: 'op-1',
  transitionId: 't-1',
  affectedPlanes: ['http'],
  targetGeneration: TARGET,
  generationDigest: 'sha256:gen',
  planes: {
    http: {
      expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
      target: { activationEpoch: '1', membershipRevision: '1' },
      payloadDigest: 'sha256:gen2',
    },
  },
};
/** store 를 감싼 Agent. 저널과 멤버십을 한 소유자가 갖는다. */
const agentOn = (store: MemoryStore | FaultStore) => new DpAgent(store);

/** 크래시 지점을 n 번째로 지정해 한 번 돌린다. 죽으면 그 사실을 돌려준다. */
async function runWithCrashAt(n: number) {
  const clock = new CrashClock();
  clock.crashAt = n;
  const store = new FaultStore(new MemoryStore(), clock);
  const effects = new FakeEffects(clock);
  let crashed = false;
  try {
    await new ApplyRunner(agentOn(store), effects, FAST).run(OP);
  } catch (e) {
    if (!(e instanceof CrashInjected)) throw e;
    crashed = true;
  }
  return { store, effects, clock, crashed };
}

describe('정상 경로', () => {
  it('publish → reload → 관측 → activated', async () => {
    const store = new MemoryStore();
    const effects = new FakeEffects();
    const phase = (await new ApplyRunner(agentOn(store), effects, FAST).run(OP)).phase;
    expect(phase).toBe<Phase>('activated');
    expect(effects.publishedGeneration).toBe(TARGET);
    expect(effects.acceptingGeneration).toBe(TARGET);
    expect(effects.reloadSignals).toBe(1);
  });

  it('저널이 단계를 남긴다', async () => {
    const store = new MemoryStore();
    const runner = new ApplyRunner(agentOn(store), new FakeEffects(), FAST);
    await runner.run(OP);
    expect(runner.phases()).toEqual([
      'preflight', 'publish_intent', 'published', 'membership_staged', 'reload_intent', 'reload_observed', 'activated',
    ]);
  });
});

describe('S12 — 모든 지점에서 죽여 본다', () => {
  it('크래시 지점이 충분히 많다 — 지점을 손으로 고르지 않는다', async () => {
    const { clock } = await runWithCrashAt(9999);
    // 개수는 **집합의 일치를 증명하지 않는다.** 5차 검수가 그걸 지적했고, 실제로
    // publish·reload 지점을 통째로 빼도 이 검사는 통과했다. 지점의 이름과 §6.2 표와의
    // 대응은 `tests/conformance/review5-crash-points.test.ts` 가 본다.
    // 여기 남은 것은 "스윕이 돌 만큼은 있다" 는 하한일 뿐이다.
    expect(clock.steps, '주입 지점이 너무 적다').toBeGreaterThanOrEqual(9);
  });

  it('어느 지점에서 죽어도 복구 후 최종 세대가 정확하다', async () => {
    const { clock: probe } = await runWithCrashAt(9999);

    for (let n = 0; n < probe.steps; n += 1) {
      const { store, effects, clock, crashed } = await runWithCrashAt(n);
      expect(crashed, `지점 ${n} 에서 죽지 않았다`).toBe(true);

      // 재시작 — 같은 durable 상태에서 새 인스턴스가 이어받는다.
      clock.crashAt = undefined;
      let phase = (await new ApplyRunner(agentOn(store), effects, FAST).recover()).phase;

      // 저널에 아무것도 없으면 시작조차 못 한 것이다 (§6.2 #1). CP 가 다시 시도한다.
      if (phase === 'no_operation') {
        expect(effects.publishCalls, `지점 ${n}: 기록 없이 부작용이 났다`).toBe(0);
        phase = (await new ApplyRunner(agentOn(store), effects, FAST).run(OP)).phase;
      }

      expect(phase, `지점 ${n}: 복구가 activated 로 끝나지 않았다`).toBe<Phase>('activated');
      expect(effects.acceptingGeneration, `지점 ${n}: 최종 세대가 틀리다`).toBe(TARGET);
      expect(effects.publishedGeneration, `지점 ${n}: 게시된 세대가 틀리다`).toBe(TARGET);
    }
  });

  it('어느 지점에서 죽어도 중복 reload 가 상한 이내다', async () => {
    const { clock: probe } = await runWithCrashAt(9999);

    for (let n = 0; n < probe.steps; n += 1) {
      const { store, effects, clock } = await runWithCrashAt(n);
      clock.crashAt = undefined;
      const p = (await new ApplyRunner(agentOn(store), effects, FAST).recover()).phase;
      if (p === 'no_operation') {
        await new ApplyRunner(agentOn(store), effects, FAST).run(OP);
      }
      expect(
        effects.reloadSignals,
        `지점 ${n}: reload 를 ${effects.reloadSignals} 번 보냈다 (상한 ${RELOAD_ATTEMPT_LIMIT})`,
      ).toBeLessThanOrEqual(RELOAD_ATTEMPT_LIMIT);
    }
  });

  it('기록 없이 죽으면 부작용도 없다 — no_operation (§6.2 #1)', async () => {
    const { store, effects, clock } = await runWithCrashAt(0);
    clock.crashAt = undefined;
    expect((await new ApplyRunner(agentOn(store), effects, FAST).recover()).phase).toBe<Phase>('no_operation');
    expect(effects.publishCalls).toBe(0);
    expect(effects.reloadSignals).toBe(0);
  });

  it('복구를 여러 번 돌려도 부작용이 늘지 않는다 — 멱등', async () => {
    const { store, effects, clock } = await runWithCrashAt(3);
    clock.crashAt = undefined;
    await new ApplyRunner(agentOn(store), effects, FAST).recover();
    const after = effects.reloadSignals;
    await new ApplyRunner(agentOn(store), effects, FAST).recover();
    await new ApplyRunner(agentOn(store), effects, FAST).recover();
    expect(effects.reloadSignals).toBe(after);
  });
});

describe('§6.2 — 관측이 저널보다 우선한다', () => {
  it('게시는 했는데 기록 전에 죽었으면 다시 게시하지 않는다', async () => {
    const store = new MemoryStore();
    const effects = new FakeEffects();
    // publish 직후(기록 전)에서 죽인다.
    effects.crashAfterEffect = 'publish';
    await expect(
      new ApplyRunner(agentOn(store), effects, FAST).run(OP),
    ).rejects.toBeInstanceOf(CrashInjected);
    expect(effects.publishCalls).toBe(1);

    effects.crashAfterEffect = undefined;
    await new ApplyRunner(agentOn(store), effects, FAST).recover();
    expect(effects.publishCalls, '이미 게시된 것을 다시 게시했다').toBe(1);
  });

  it('기록만 하고 게시 전에 죽었으면 게시한다', async () => {
    const store = new MemoryStore();
    const effects = new FakeEffects();
    effects.crashBeforeEffect = 'publish';
    await expect(
      new ApplyRunner(agentOn(store), effects, FAST).run(OP),
    ).rejects.toBeInstanceOf(CrashInjected);
    expect(effects.publishCalls).toBe(0);

    effects.crashBeforeEffect = undefined;
    await new ApplyRunner(agentOn(store), effects, FAST).recover();
    expect(effects.publishCalls).toBe(1);
    expect(effects.acceptingGeneration).toBe(TARGET);
  });

  it('reload 를 보냈는지 모를 때는 관측으로 가른다 — 무턱대고 재전송하지 않는다', async () => {
    const store = new MemoryStore();
    const effects = new FakeEffects();
    effects.crashAfterEffect = 'reload';       // 신호는 갔고 기록 전에 죽었다
    await expect(
      new ApplyRunner(agentOn(store), effects, FAST).run(OP),
    ).rejects.toBeInstanceOf(CrashInjected);
    expect(effects.reloadSignals).toBe(1);

    effects.crashAfterEffect = undefined;
    await new ApplyRunner(agentOn(store), effects, FAST).recover();
    expect(effects.reloadSignals, '이미 반영된 reload 를 다시 보냈다').toBe(1);
  });
});

describe('reload 가 끝내 반영되지 않으면', () => {
  // 상한이 없으면 이 테스트는 **실패가 아니라 매달린다.** 매달리는 것은 신호가 아니므로
  // 짧은 타임아웃을 걸어 빨리 실패하게 만든다.
  it('상한까지만 재시도하고 실패로 확정한다 — 무한 재전송하지 않는다', { timeout: 2000 }, async () => {
    const store = new MemoryStore();
    const effects = new FakeEffects();
    effects.reloadTakesEffect = false;         // 포트 점유 등으로 새 세대가 활성화되지 않는다
    const phase = (await new ApplyRunner(agentOn(store), effects, FAST).run(OP)).phase;
    expect(phase).toBe<Phase>('failed');
    expect(effects.reloadSignals).toBeLessThanOrEqual(RELOAD_ATTEMPT_LIMIT);
    expect(effects.acceptingGeneration).not.toBe(TARGET);
  });

  it('실패로 확정된 오퍼레이션은 복구가 되살리지 않는다', async () => {
    const store = new MemoryStore();
    const effects = new FakeEffects();
    effects.reloadTakesEffect = false;
    await new ApplyRunner(agentOn(store), effects, FAST).run(OP);
    const signals = effects.reloadSignals;
    expect((await new ApplyRunner(agentOn(store), effects, FAST).recover()).phase).toBe<Phase>('failed');
    expect(effects.reloadSignals).toBe(signals);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// DpAgent 와 ApplyRunner 의 결합 — 5차 검수가 지목한 구조적 누락
//
// 둘이 같은 store 를 각자 쓰던 시절에는 서로를 덮어썼다(반례 ③④). 이제 Agent 가
// durable 상태를 소유하고, operation tuple 이 저널을 타고 흐른다.
// ─────────────────────────────────────────────────────────────────────────
describe('저널과 멤버십이 한 오퍼레이션으로 묶인다', () => {
  it('멤버십 staging 이 **HUP 앞에** 일어난다 (§6.5-1)', async () => {
    const store = new MemoryStore();
    const agent = agentOn(store);
    const effects = new FakeEffects();
    // reload 시점에 이미 슬롯이 올라가 있어야 한다. 새 워커가 accept 를 시작한 뒤에
    // 올리면 그 사이 옛 상태로 peer 를 고른다.
    class Watching extends FakeEffects {
      stagedAtReload: string | undefined;
      override async signalReload(): Promise<void> {
        this.stagedAtReload = agent.stagedDigest('http', '1');
        await super.signalReload();
      }
    }
    const watching = new Watching();
    await new ApplyRunner(agent, watching, FAST).run(OP);
    expect(watching.stagedAtReload, 'HUP 시점에 슬롯이 없었다').toBe('sha256:gen2');
  });

  it('활성화되고 나서야 멤버십 좌표가 움직인다 (§6.5-4)', async () => {
    const store = new MemoryStore();
    const agent = agentOn(store);
    expect(agent.coordinate('http').activationEpoch).toBe('0');
    await new ApplyRunner(agent, new FakeEffects(), FAST).run(OP);
    expect(agent.coordinate('http')).toEqual({
      activationEpoch: '1', membershipRevision: '1', payloadDigest: 'sha256:gen2',
    });
  });

  it('reload 가 반영되지 않으면 좌표도 움직이지 않는다', async () => {
    const store = new MemoryStore();
    const agent = agentOn(store);
    const effects = new FakeEffects();
    effects.reloadTakesEffect = false;
    const phase = (await new ApplyRunner(agent, effects, FAST).run(OP)).phase;
    expect(phase).toBe<Phase>('failed');
    expect(agent.coordinate('http').activationEpoch, '실패했는데 좌표가 움직였다').toBe('0');
  });

  it('저널과 멤버십이 같은 durable 상태에 함께 산다', async () => {
    const store = new MemoryStore();
    const agent = agentOn(store);
    await new ApplyRunner(agent, new FakeEffects(), FAST).run(OP);
    const state = store.load()!.payload as { journal?: { phase: string }; planes: { http: { activationEpoch: string } } };
    expect(state.journal?.phase).toBe<Phase>('activated');
    expect(state.planes.http.activationEpoch).toBe('1');
  });

  /**
   * 한때 이 테스트의 제목은 거짓말이었다. "부작용 전에 막힌다" 라고 써 놓고 `publish` 가
   * 한 번 일어나는 것을 주석으로 정당화하고 있었다. 5차 검수가 그걸 반례로 재현했고,
   * §9.1.1 blocker 1(소유권 예약)이 들어오면서 닫혔다.
   *
   * **계약은 `tests/conformance/review5-reservation.test.ts` 에 있다.** 여기서는
   * apply 경로에서도 같은 것이 성립하는지만 본다.
   */
  it('낮은 리더 토큰의 apply 는 **부작용 전에** 막힌다', async () => {
    const store = new MemoryStore();
    const agent = agentOn(store);
    await agent.fence('99');
    const effects = new FakeEffects();
    await expect(
      new ApplyRunner(agent, effects, FAST).run({ ...OP, leaderToken: '10' }),
    ).rejects.toThrow();
    expect(agent.coordinate('http').activationEpoch).toBe('0');
    expect(effects.publishCalls, '§3.5 — 거부될 오퍼레이션이 current 를 옮겼다').toBe(0);
    expect(effects.reloadSignals, '토큰이 낮은데 reload 를 보냈다').toBe(0);
  });
});

describe('reload_observed 이후 세대가 다시 바뀌면', () => {
  /** 처음 관측에서는 target 을 주고, 그 다음부터는 다른 세대를 준다. */
  class FlappingEffects extends FakeEffects {
    private seen = 0;
    override async observeActivation(): Promise<ActivationEvidence | undefined> {
      this.seen += 1;
      // 1회: reload_intent 의 관측을 통과시켜 reload_observed 로 보낸다.
      // 그 뒤: reload_observed 의 **재확인**에서 다른 세대를 본다.
      return { acceptingGeneration: this.seen <= 1 ? TARGET : 'gen-끼어듦' };
    }
  }

  it('좌표를 옮기지 않고 reload_intent 로 되돌아간다', async () => {
    const store = new MemoryStore();
    const agent = agentOn(store);
    const effects = new FlappingEffects();
    const phase = (await new ApplyRunner(agent, effects, FAST).run(OP)).phase;

    // 활성화를 확인하지 못했으므로 실패로 끝나야 하고,
    // **무엇보다 멤버십 좌표가 움직이면 안 된다.**
    expect(phase).toBe<Phase>('failed');
    expect(
      agent.coordinate('http').activationEpoch,
      '활성화를 확인하지 못했는데 좌표가 움직였다',
    ).toBe('0');
  });
});
