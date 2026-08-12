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
import { MemoryStore } from '../../src/dp/agent.js';
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

/** 크래시 지점을 n 번째로 지정해 한 번 돌린다. 죽으면 그 사실을 돌려준다. */
async function runWithCrashAt(n: number) {
  const clock = new CrashClock();
  clock.crashAt = n;
  const store = new FaultStore(new MemoryStore(), clock);
  const effects = new FakeEffects(clock);
  let crashed = false;
  try {
    await new ApplyRunner(store, effects, FAST).run({ operationId: 'op-1', targetGeneration: TARGET });
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
    const phase = await new ApplyRunner(store, effects, FAST).run({
      operationId: 'op-1', targetGeneration: TARGET,
    });
    expect(phase).toBe<Phase>('activated');
    expect(effects.publishedGeneration).toBe(TARGET);
    expect(effects.acceptingGeneration).toBe(TARGET);
    expect(effects.reloadSignals).toBe(1);
  });

  it('저널이 단계를 남긴다', async () => {
    const store = new MemoryStore();
    const runner = new ApplyRunner(store, new FakeEffects(), FAST);
    await runner.run({ operationId: 'op-1', targetGeneration: TARGET });
    expect(runner.phases()).toEqual([
      'publish_intent', 'published', 'reload_intent', 'reload_observed', 'activated',
    ]);
  });
});

describe('S12 — 모든 지점에서 죽여 본다', () => {
  it('크래시 지점이 충분히 많다 — 지점을 손으로 고르지 않는다', async () => {
    const { clock } = await runWithCrashAt(9999);
    expect(clock.steps, '주입 지점이 너무 적다').toBeGreaterThanOrEqual(9);
  });

  it('어느 지점에서 죽어도 복구 후 최종 세대가 정확하다', async () => {
    const { clock: probe } = await runWithCrashAt(9999);

    for (let n = 0; n < probe.steps; n += 1) {
      const { store, effects, clock, crashed } = await runWithCrashAt(n);
      expect(crashed, `지점 ${n} 에서 죽지 않았다`).toBe(true);

      // 재시작 — 같은 durable 상태에서 새 인스턴스가 이어받는다.
      clock.crashAt = undefined;
      let phase = await new ApplyRunner(store, effects, FAST).recover();

      // 저널에 아무것도 없으면 시작조차 못 한 것이다 (§6.2 #1). CP 가 다시 시도한다.
      if (phase === 'no_operation') {
        expect(effects.publishCalls, `지점 ${n}: 기록 없이 부작용이 났다`).toBe(0);
        phase = await new ApplyRunner(store, effects, FAST).run({
          operationId: 'op-1', targetGeneration: TARGET,
        });
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
      const p = await new ApplyRunner(store, effects, FAST).recover();
      if (p === 'no_operation') {
        await new ApplyRunner(store, effects, FAST).run({ operationId: 'op-1', targetGeneration: TARGET });
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
    expect(await new ApplyRunner(store, effects, FAST).recover()).toBe<Phase>('no_operation');
    expect(effects.publishCalls).toBe(0);
    expect(effects.reloadSignals).toBe(0);
  });

  it('복구를 여러 번 돌려도 부작용이 늘지 않는다 — 멱등', async () => {
    const { store, effects, clock } = await runWithCrashAt(3);
    clock.crashAt = undefined;
    await new ApplyRunner(store, effects, FAST).recover();
    const after = effects.reloadSignals;
    await new ApplyRunner(store, effects, FAST).recover();
    await new ApplyRunner(store, effects, FAST).recover();
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
      new ApplyRunner(store, effects, FAST).run({ operationId: 'op-1', targetGeneration: TARGET }),
    ).rejects.toBeInstanceOf(CrashInjected);
    expect(effects.publishCalls).toBe(1);

    effects.crashAfterEffect = undefined;
    await new ApplyRunner(store, effects, FAST).recover();
    expect(effects.publishCalls, '이미 게시된 것을 다시 게시했다').toBe(1);
  });

  it('기록만 하고 게시 전에 죽었으면 게시한다', async () => {
    const store = new MemoryStore();
    const effects = new FakeEffects();
    effects.crashBeforeEffect = 'publish';
    await expect(
      new ApplyRunner(store, effects, FAST).run({ operationId: 'op-1', targetGeneration: TARGET }),
    ).rejects.toBeInstanceOf(CrashInjected);
    expect(effects.publishCalls).toBe(0);

    effects.crashBeforeEffect = undefined;
    await new ApplyRunner(store, effects, FAST).recover();
    expect(effects.publishCalls).toBe(1);
    expect(effects.acceptingGeneration).toBe(TARGET);
  });

  it('reload 를 보냈는지 모를 때는 관측으로 가른다 — 무턱대고 재전송하지 않는다', async () => {
    const store = new MemoryStore();
    const effects = new FakeEffects();
    effects.crashAfterEffect = 'reload';       // 신호는 갔고 기록 전에 죽었다
    await expect(
      new ApplyRunner(store, effects, FAST).run({ operationId: 'op-1', targetGeneration: TARGET }),
    ).rejects.toBeInstanceOf(CrashInjected);
    expect(effects.reloadSignals).toBe(1);

    effects.crashAfterEffect = undefined;
    await new ApplyRunner(store, effects, FAST).recover();
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
    const phase = await new ApplyRunner(store, effects, FAST).run({
      operationId: 'op-1', targetGeneration: TARGET,
    });
    expect(phase).toBe<Phase>('failed');
    expect(effects.reloadSignals).toBeLessThanOrEqual(RELOAD_ATTEMPT_LIMIT);
    expect(effects.acceptingGeneration).not.toBe(TARGET);
  });

  it('실패로 확정된 오퍼레이션은 복구가 되살리지 않는다', async () => {
    const store = new MemoryStore();
    const effects = new FakeEffects();
    effects.reloadTakesEffect = false;
    await new ApplyRunner(store, effects, FAST).run({ operationId: 'op-1', targetGeneration: TARGET });
    const signals = effects.reloadSignals;
    expect(await new ApplyRunner(store, effects, FAST).recover()).toBe<Phase>('failed');
    expect(effects.reloadSignals).toBe(signals);
  });
});
