/**
 * 워커 교대 창 — **한 번 본 활성화를 한 번의 옛 답으로 버리지 않는다** (2026-11-02).
 *
 * nginx 는 HUP 을 받으면 새 워커를 먼저 띄우고, 그 **뒤에** 옛 워커에게 QUIT 을 보낸다.
 * 옛 워커가 QUIT 을 받아 리스닝 소켓을 닫기 전까지 둘은 **같은 소켓에서 함께 accept** 한다.
 * 그 창 안의 관측은 새 세대와 옛 세대를 번갈아 답할 수 있다.
 *
 * 러너는 그 창을 몰랐다. `awaitActivation` 이 목표 세대를 한 번 보면 저널에 증거만 적고
 * `reload_intent` 로 되돌아갔고, 거기서 **한 번** 다시 읽었다. 그 한 번이 옛 워커에 닿으면
 *
 *   · 처음 보낸 HUP 이면   → HUP 을 **한 번 더** 보낸다
 *   · 두 번째 HUP 이면     → 상한에 닿아 **`failed`** 로 닫는다 — 세계는 이미 목표 세대다
 *
 * CI 의 간헐 빨강 다섯 건이 이 두 모양이었다 — `tests/e2e/apply-nginx.test.ts` 의
 * "게시 직후 죽어도 복구가 이어받는다"(`failed`), "이미 반영된 뒤 … reload 를 더 보내지
 * 않는다"(reload 2 회), `spike/s12` 의 `S12.lock`(`failed`, 지점 42 개 = HUP 두 번).
 *
 * 여기서는 그 창을 **결정적으로** 만든다. HUP 마다 관측이 [새 → 옛 → 새 …] 순서로 답한다.
 */
import { describe, expect, it } from 'vitest';
import { CrashInjected, FakeEffects } from '../../src/testing/apply-fakes.js';
import { DpAgent, MemoryStore } from '../../src/dp/agent.js';
import { ApplyRunner } from '../../src/dp/apply.js';
import type { ActivationEvidence, ApplyOperation } from '../../src/dp/operation.js';

const OLD = 'gen-000001';
const TARGET = 'gen-000002';
const FAST = { attempts: 3, intervalMs: 0, sleep: async () => undefined };

const OP: ApplyOperation = {
  leaderToken: '10',
  operationId: 'op-flap',
  transitionId: 't-flap',
  affectedPlanes: ['http', 'stream'],
  targetGeneration: TARGET,
  generationDigest: 'sha256:gen',
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
};

/**
 * HUP 직후 **새 워커와 옛 워커가 함께 accept 한다.** 첫 관측은 새 워커에, 둘째는 옛
 * 워커에 닿는다. 그 뒤 옛 워커가 소켓을 닫아 새 세대만 답한다.
 */
class Handover extends FakeEffects {
  private window: string[] = [];

  /** @param oldReads 교대 창 안에서 옛 워커에 닿는 관측 수. */
  constructor(private readonly oldReads = 1) {
    super();
    this.acceptingGeneration = OLD;
  }

  override async signalReload(...args: Parameters<FakeEffects['signalReload']>) {
    const checked = await super.signalReload(...args);
    this.window = [TARGET, ...Array<string>(this.oldReads).fill(OLD)];
    return checked;
  }

  override async observeActivation(): Promise<ActivationEvidence | undefined> {
    const accepting = this.window.shift() ?? this.acceptingGeneration;
    return accepting === undefined
      ? undefined
      : { acceptingGeneration: accepting, configTestPassed: true, errorLogGrowth: 0 };
  }
}

describe('워커 교대 창의 옛 답은 활성화를 뒤집지 않는다', () => {
  it('정상 경로 — HUP 은 한 번이고 activated 다', async () => {
    const fx = new Handover();
    const result = await new ApplyRunner(new DpAgent(new MemoryStore()), fx, FAST).run(OP);
    expect(result.phase).toBe('activated');
    expect(fx.reloadSignals, '교대 창의 옛 답에 HUP 을 한 번 더 보냈다').toBe(1);
  });

  it('HUP 직전에 죽은 뒤 복구 — failed 가 아니라 activated 다', async () => {
    const store = new MemoryStore();
    const fx = new Handover();
    // 첫 러너는 `reloadAttempts` 를 1 로 적은 뒤 HUP 직전에 죽는다.
    fx.crashBeforeEffect = 'reload';
    await expect(new ApplyRunner(new DpAgent(store), fx, FAST).run(OP))
      .rejects.toBeInstanceOf(CrashInjected);
    expect(fx.reloadSignals).toBe(0);

    fx.crashBeforeEffect = undefined;
    const result = await new ApplyRunner(new DpAgent(store), fx, FAST).recover();
    // 고치기 전에는 여기서 `failed` 였다 — 두 번째 HUP 뒤 한 번의 옛 답이 상한을 채웠다.
    expect(result.phase, result.failure).toBe('activated');
    expect(fx.reloadSignals).toBe(1);
  });

  it('창이 두 번 읽을 만큼 길어도 — 확인은 한 번이 아니라 예산 안에서 본다', async () => {
    // `reload_observed` 의 재확인이 한 번만 읽으면, 옛 답 하나에 `reload_intent` 로
    // 돌아가 거기서 또 옛 답을 읽고 HUP 을 다시 보낸다.
    const fx = new Handover(2);
    const result = await new ApplyRunner(new DpAgent(new MemoryStore()), fx, FAST).run(OP);
    expect(result.phase).toBe('activated');
    expect(fx.reloadSignals).toBe(1);
  });

  it('교대가 끝나지 않으면 여전히 HUP 을 다시 보낸다 — 판정을 무디게 하지 않았다', async () => {
    // 새 세대가 한 번 보였다가 **계속** 옛 세대만 답한다. 예산 안에 다시 안 보이면
    // 활성화된 것이 아니다.
    class Reverted extends Handover {
      override async signalReload(...args: Parameters<FakeEffects['signalReload']>) {
        const checked = await super.signalReload(...args);
        this.acceptingGeneration = OLD;
        return checked;
      }
    }
    const fx = new Reverted();
    const result = await new ApplyRunner(new DpAgent(new MemoryStore()), fx, FAST).run(OP);
    expect(result.phase).toBe('failed');
    expect(fx.reloadSignals).toBe(2);
  });
});
