/**
 * 11차 검수 반례 ⑤ — 멈춘 부작용이 러너를 영원히 붙잡는다
 *
 * `Effects` 에 deadline 도 취소도 없다. 그래서 주입된 구현이 멈추면
 *
 *   · 러너가 영영 끝나지 않고
 *   · `exclusiveApply` 가 **그 뒤의 모든 apply 를 줄 세운다**
 *
 * 내 프로브가 실제로 교착했다. 리더 교체는 장애 때 일어나는 일인데, 하필 그때 멈춰 선다.
 *
 * **취소는 못 한다.** JavaScript 의 Promise 는 취소되지 않고, `docker exec` 도 `kill` 도
 * 이미 나간 뒤다. 할 수 있는 것은 **기다림을 끊고 실패로 확정하는 것**이다. 버려진
 * 부작용이 뒤늦게 착지하는 문제는 수렴(`reconcileConfig`)이 맡는다 — 그게 방식 전환의
 * 값이다.
 */
import { describe, expect, it } from 'vitest';
import { DpAgent, MemoryStore } from '../../src/dp/agent.js';
import { ApplyRunner, FakeEffects } from '../../src/dp/apply.js';
import type { ApplyLease, ApplyOperation, PublishRecord } from '../../src/dp/operation.js';

const OP = (id: string, gen = 'gen-1'): ApplyOperation => ({
  leaderToken: '10',
  operationId: id,
  transitionId: id,
  affectedPlanes: ['http', 'stream'],
  targetGeneration: gen,
  generationDigest: `sha256:${gen}`,
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
});

/** 예산을 짧게 준다. 실제 배포에서는 S7 의 판정 예산(< 3s)에 맞춘다. */
const FAST = { attempts: 1, intervalMs: 0, sleep: async () => {}, effectTimeoutMs: 50 };

/** 영영 끝나지 않는 게시. */
class Hanging extends FakeEffects {
  override async publish(_record: PublishRecord, _lease: ApplyLease): Promise<void> {
    await new Promise(() => {});
  }
}

describe('⑤ 멈춘 부작용은 예산을 넘기면 끊는다', () => {
  it('**러너가 영원히 매달리지 않는다**', async () => {
    const agent = new DpAgent(new MemoryStore());
    const started = Date.now();
    const r = await new ApplyRunner(agent, new Hanging(), FAST).run(OP('stuck'));
    expect(r.phase, '멈춘 게시를 성공으로 끝냈다').toBe('failed');
    expect(Date.now() - started, '예산을 한참 넘겼다').toBeLessThan(5_000);
  });

  it('멈춘 러너 뒤의 apply 가 풀린다 — 교착하지 않는다', async () => {
    const agent = new DpAgent(new MemoryStore());
    const hanging = new ApplyRunner(agent, new Hanging(), FAST).run(OP('stuck')).catch(() => undefined);

    // 같은 Agent 다. 전에는 `exclusiveApply` 가 여기서 영원히 기다렸다.
    const after = await Promise.race([
      new ApplyRunner(agent, new FakeEffects(), FAST).run(OP('next', 'gen-2')).catch((e) => e),
      new Promise((r) => setTimeout(() => r('교착'), 5_000)),
    ]);
    expect(after, 'exclusiveApply 가 풀리지 않았다').not.toBe('교착');
    await hanging;
  });

  it('예산 안에 끝나는 부작용은 그대로 진행한다 — 막는 것만 하는 게 아니다', async () => {
    const agent = new DpAgent(new MemoryStore());
    class Slow extends FakeEffects {
      override async publish(record: PublishRecord, lease: ApplyLease): Promise<void> {
        await new Promise((r) => setTimeout(r, 5));
        await super.publish(record, lease);
      }
    }
    const r = await new ApplyRunner(agent, new Slow(), FAST).run(OP('ok'));
    expect(r.phase).toBe('activated');
  });

  it('끊긴 이유가 기록된다 — 조용히 실패하지 않는다', async () => {
    const agent = new DpAgent(new MemoryStore());
    const r = await new ApplyRunner(agent, new Hanging(), FAST).run(OP('stuck'));
    expect(r.phase).toBe('failed');
    expect(r.failure ?? '', '왜 실패했는지 말하지 않는다').toMatch(/예산|timeout|deadline/i);
  });
});
