/**
 * ▲ 잔여물 — **"관측 못 했다" 와 "안 일어났다" 를 러너가 합친다** (2026-08-23).
 *
 * `verify.sh` 의 ▲ 목록에 *"예산 초과가 부분 커밋을 숨김 (13차 ③)"* 으로 서 있던 것이고,
 * `spike/s12` 의 간헐 빨강이 그 항목에 **재현 가능한 무대**를 붙여 줬다. 그때 진단은
 * 이랬다: 복구 러너가 `RejectionError(terminalState:'failed')` 로 죽는데
 * `link` 와 `served` 는 이미 목표 세대다 — **세계는 수렴해 있었다.**
 *
 * 자리는 `observe()` 다:
 *
 *     private async observe() {
 *       try { return await this.budget('observeActivation', ...); }
 *       catch { return undefined; }        // ← 여기
 *     }
 *
 * 관측 채널이 죽은 것(admin 소켓 타임아웃 · 예산 초과)과 세계가 정말 안 바뀐 것이
 * **똑같이 `undefined`** 가 된다. `provesActivation(undefined, gen)` 은 양쪽 다 거짓이라
 * 러너는 둘을 구분할 수 없고, 상한에 닿으면 *"활성화가 관측되지 않았다"* 로 종단을 적는다.
 *
 * 그 서술은 **한쪽에서만 참이다.** 다른 쪽에서 참인 것은 *"관측 자체가 실패했다"* 이고,
 * 그건 세계에 대한 주장이 아니다. 종단 기록이 거짓 주장을 담으면 그걸 읽는 운영자와
 * 복구 경로가 둘 다 틀린 곳을 본다.
 *
 * 그리고 대응도 달라야 한다. 못 읽었다고 HUP 을 다시 보내는 것은 **읽기 실패에 쓰기로
 * 답하는 것**이고, 워커 세대만 쌓는다 (§6.4 admission control).
 */
import { describe, expect, it } from 'vitest';
import { CrashClock, FakeEffects } from '../../src/testing/apply-fakes.js';

import { DpAgent, MemoryStore } from '../../src/dp/agent.js';
import { ApplyRunner, RELOAD_ATTEMPT_LIMIT } from '../../src/dp/apply.js';
import type { ActivationEvidence, ApplyOperation } from '../../src/dp/operation.js';

const TARGET = 'gen-000002';
const FAST = { attempts: 2, intervalMs: 0, sleep: async () => undefined };

const OP: ApplyOperation = {
  leaderToken: '10',
  operationId: 'op-unobs',
  transitionId: 't-unobs',
  // 설정 apply 는 **두 평면을 모두** 선언해야 한다 — 하나의 nginx.conf 가 둘을 함께 바꾼다.
  affectedPlanes: ['http', 'stream'],
  targetGeneration: TARGET,
  generationDigest: 'sha256:gen',
  planes: {
    http: {
      expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
      target: { activationEpoch: '1', membershipRevision: '1' },
      payloadDigest: 'sha256:gen2',
    },
    stream: {
      expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
      target: { activationEpoch: '1', membershipRevision: '1' },
      payloadDigest: 'sha256:s',
    },
  },
};

/** 세계는 **안 바뀐다** — 관측은 잘 되고, 답이 옛 세대다. */
class Contradicting extends FakeEffects {
  override async observeActivation(): Promise<ActivationEvidence | undefined> {
    return { acceptingGeneration: 'gen-000001', configTestPassed: true, errorLogGrowth: 0 };
  }
}

/** 세계는 알 수 없다 — **관측 채널이 죽었다.** 세대가 뭔지 우리는 모른다. */
class Unobservable extends FakeEffects {
  override async observeActivation(): Promise<ActivationEvidence | undefined> {
    throw new Error('admin 소켓이 2000ms 안에 안 답했다');
  }
}

const runWith = async (effects: FakeEffects) => {
  const store = new MemoryStore();
  const runner = new ApplyRunner(new DpAgent(store), effects, FAST);
  return runner.run(OP);
};

describe('관측 실패와 부정 관측은 다른 것이다', () => {
  it('세계가 옛 세대를 답하면 — 활성화가 안 일어난 것이다', async () => {
    const r = await runWith(new Contradicting(new CrashClock()));
    expect(r.phase).toBe('failed');
    // 세계를 읽었고, 그 답이 목표가 아니었다. 이 서술은 참이다.
    expect(r.failure).toContain('활성화가 관측되지 않았다');
    expect(r.failure).not.toContain('관측 자체');
  });

  it('관측 채널이 죽으면 — 세계에 대해 아무 주장도 하지 않는다', async () => {
    const r = await runWith(new Unobservable(new CrashClock()));
    expect(r.phase).toBe('failed');
    /**
     * **핵심.** 여기서 "활성화가 관측되지 않았다" 고 적으면 거짓이다 — 우리는
     * 활성화를 관측하지 *못한* 것이지 활성화가 *안 일어난* 것을 관측한 게 아니다.
     * 세계는 이미 목표 세대일 수 있고, S12 에서 실제로 그랬다.
     */
    expect(r.failure).toContain('관측 자체');
    expect(r.failure).toContain('세계의 상태를 모른다');
  });

  it('못 읽었다고 HUP 을 다시 보내지 않는다 — 읽기 실패에 쓰기로 답하지 않는다', async () => {
    /**
     * 재전송은 **워커 세대를 쌓는다** (§6.4). 관측이 안 되는 동안 상한까지 HUP 을
     * 밀어붙이면, 정작 세계가 이미 수렴해 있던 경우에 우리가 만든 것은 부하뿐이다.
     */
    const effects = new Unobservable(new CrashClock());
    await runWith(effects);
    expect(effects.reloadSignals).toBeLessThanOrEqual(1);

    // 대조군 — 세계를 읽었고 답이 틀렸으면 재전송이 옳다. 상한까지 간다.
    const seen = new Contradicting(new CrashClock());
    await runWith(seen);
    expect(seen.reloadSignals).toBe(RELOAD_ATTEMPT_LIMIT);
  });
});
