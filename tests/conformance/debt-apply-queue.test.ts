/**
 * **빚 갚기 — 멈춘 러너가 뒤의 모든 apply 를 줄 세우는가**
 *
 * STATUS 의 한계 목록에 이렇게 적혀 있었다: *"`exclusiveApply` 교착 — 같은 Agent 안에서
 * 멈춘 러너 뒤에 apply 가 줄 선다. `Effects` 에 타임아웃이 없으면 풀리지 않는다."*
 *
 * **그 조건절이 낡았다.** 11차 반례 ⑤ 로 부작용마다 예산(`effectTimeoutMs`)이 붙었고,
 * 예산을 넘기면 `driveInner` 가 run 을 통째로 끝낸다. 즉 "타임아웃이 없으면" 이라는
 * 전제가 이제 성립하지 않는다.
 *
 * 그런데 **적혀 있는 것과 재 본 것은 다르다** — 이 시리즈가 서른세 회차 동안 배운 것이
 * 그것이다. 그래서 잰다. 재는 것은 **경과 시간이 아니라 큐가 풀리는가** 다.
 * (18차에 "마감의 효과" 대신 경과 시간을 재다가 뮤턴트를 놓친 적이 있다.)
 */
import { describe, expect, it } from 'vitest';
import { FakeEffects } from '../../src/testing/apply-fakes.js';
import { DpAgent, MemoryStore } from '../../src/dp/agent.js';
import { ApplyRunner } from '../../src/dp/apply.js';
import type { ApplyOperation } from '../../src/dp/operation.js';

const OP: ApplyOperation = {
  leaderToken: '10',
  operationId: 'stuck',
  transitionId: 'stuck',
  // **두 평면을 다 선언해야 한다.** 하나만 적었더니 `run` 이 부작용에 닿기도 전에
  // 거부됐고, `catch` 가 그걸 삼켜 `entered` 가 영영 안 풀렸다 — 테스트가 타임아웃으로
  // 죽으면서 **아무것도 안 재고 있었다.** 픽스처가 통과시킨 것의 반대 모양이다.
  affectedPlanes: ['http', 'stream'],
  targetGeneration: 'gen-1',
  generationDigest: 'sha256:gen-1',
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
 * 첫 부작용에서 영영 안 돌아온다 — 죽은 nginx 나 멈춘 파일시스템이다.
 *
 * **진입을 신호로 준다.** 그게 없으면 "러너가 큐 안에 있는" 시점을 못 잡고, 큐에 들어가기
 * **전**에 줄을 서게 된다 — 그러면 테스트가 아무것도 안 재면서 초록이다. 대조군이 그것을
 * 잡았다(예산을 무한으로 줘도 통과했다).
 */
class HangingEffects extends FakeEffects {
  entered: Promise<void>;
  #signal!: () => void;
  constructor() {
    super();
    this.entered = new Promise<void>((r) => { this.#signal = r; });
  }
  // **러너가 처음 부르는 부작용**에 매단다. 게시에 매달았더니 거기까지 도달을 못 해
  // `entered` 가 영영 안 풀렸다 — 테스트가 8 초 타임아웃으로 죽었다. 재려는 것은
  // "매달린 부작용 뒤에서 큐가 풀리는가" 이므로 어느 부작용이든 상관없고, **도달이
  // 확실한 것**을 골라야 한다.
  override preflight(): Promise<never> {
    this.#signal();
    return new Promise<never>(() => undefined);
  }
}

describe('멈춘 러너가 큐를 영구히 잠그지 않는다', () => {
  /**
   * **드라이버 표면으로는 예산을 못 바꾼다.** `LocalDataplaneDriver.create` 는
   * `{store, effects}` 만 받는다 — 운영자가 `effectTimeoutMs` 를 조정할 길이 없고,
   * 테스트도 러너를 직접 세워야 한다. 이건 이 회차에 발견한 것이라 한계 목록에 적었다.
   */
  it('매달린 부작용은 예산에서 끊기고 큐가 풀린다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const effects0 = new HangingEffects();
    const runner = new ApplyRunner(agent, effects0, {
      effectTimeoutMs: 50, attempts: 2, intervalMs: 1,
    });

    const stuck = runner.run(OP).catch((e: unknown) => (e as Error).name);
    await effects0.entered;
    const behind = agent.exclusiveApply(async () => 'behind' as const);

    expect(await behind, '멈춘 러너 뒤에서 큐가 안 풀렸다').toBe('behind');
    await stuck;
  });

  it('예산이 없으면 같은 자리에서 잠긴다 — 그것이 이 빚의 원래 모양이다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const effects1 = new HangingEffects();
    const runner = new ApplyRunner(agent, effects1, {
      // 짧게 잡되 대조에는 충분하다 — 진짜 1 시간을 걸면 타이머가 프로세스를 붙잡는다.
      effectTimeoutMs: 2_000, attempts: 2, intervalMs: 1,
    });
    void runner.run(OP).catch(() => undefined);
    await effects1.entered;

    const raced = await Promise.race([
      agent.exclusiveApply(async () => 'passed' as const),
      new Promise<'blocked'>((r) => { setTimeout(() => r('blocked'), 300); }),
    ]);
    // **대조군이다.** 예산을 일부러 꺼야 잠긴다는 것이 곧 예산이 일하고 있다는 증거다.
    expect(raced, '예산이 없어도 안 잠긴다면 위 테스트가 재는 것이 없다').toBe('blocked');
  });
});
