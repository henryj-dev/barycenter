/**
 * 13차 검수 반례 ① · ④ — 수렴이 거짓말을 하는 두 자리
 *
 * 처음엔 둘 다 "재현되지 않는다" 고 적었다. **내 시나리오가 약했던 것이다.** 코드를
 * 읽고 다시 짜니 둘 다 나왔다. 재현 실패를 반증으로 쓴 것이 틀렸다.
 *
 *   ① `#reconcileOnce` 는 **리더 토큰을 전혀 보지 않는다.** 기준(`lastActivated`)이
 *      옛 리더의 것이어도 그대로 되돌린다. 신임 리더가 이미 fence 하고 게시까지 했는데
 *      옛 드라이버의 reconcile 한 번이 그걸 덮는다. `exclusiveApply` 는 인스턴스 안의
 *      큐라 두 리더 사이에서는 아무것도 막지 못한다.
 *
 *   ④ 기준이 계속 바뀌어 라운드를 소진하면 **아무것도 관측하지 않고** `converged` 를
 *      돌려준다. "지금은 우리 차례가 아니다" 와 "수렴했다" 는 완전히 다른 말이다.
 *
 * 둘 다 불변식(I1·I3·I5)이 못 잡는다. 게시는 외부 효과라 상태 술어로 표현되지 않는다 —
 * `assertInvariants` 밖의 '점' 이다. 그래서 여기 반례로 고정한다.
 */
import { describe, expect, it } from 'vitest';
import { DpAgent, MemoryStore } from '../../src/dp/agent.js';
import { FakeEffects } from '../../src/dp/apply.js';
import { LocalDataplaneDriver } from '../../src/dp/driver.js';
import type { ApplyOperation, PublishedState } from '../../src/dp/operation.js';

const OP = (id: string, generation: string, leaderToken: string): ApplyOperation => ({
  leaderToken,
  operationId: id,
  transitionId: id,
  affectedPlanes: ['http', 'stream'],
  targetGeneration: generation,
  generationDigest: `sha256:${generation}`,
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

describe('① 옛 리더의 reconcile 은 신임 리더를 덮지 않는다', () => {
  it('신임이 fence 한 뒤에는 옛 기준으로 되돌리지 않는다', async () => {
    const store = new MemoryStore();
    const fx = new FakeEffects();
    await LocalDataplaneDriver.create({ store, effects: fx }).applyConfig(OP('A', 'gen-A', '10'));

    // 신임 리더 B 가 들어와 fence 하고 자기 세대를 게시했다 — 아직 commit 전이다.
    const b = new DpAgent(store);
    await b.fence('11');
    fx.publishedRecord = {
      generation: 'gen-B',
      leaderToken: '11',
      operationId: 'B',
      transitionId: 'B',
      generationDigest: 'sha256:gen-B',
    };
    fx.acceptingGeneration = 'gen-B';
    const before = fx.publishCalls;

    // 옛 리더 A 의 드라이버가 이제서야 수렴을 돈다.
    const r = await LocalDataplaneDriver.create({ store, effects: fx }).reconcileConfig();

    expect(fx.publishCalls - before, '옛 리더가 자기 세대를 다시 게시했다').toBe(0);
    expect(fx.publishedRecord?.generation, '신임의 게시물이 옛 것으로 덮였다').toBe('gen-B');
    expect(r.kind, '남의 세대가 올라가 있는데 되돌렸다고 답했다').not.toBe('repaired');
    expect(r.kind).not.toBe('converged');
  });

  it('같은 리더라면 그대로 되돌린다 — 막기만 하는 게 아니다', async () => {
    const store = new MemoryStore();
    const fx = new FakeEffects();
    await LocalDataplaneDriver.create({ store, effects: fx }).applyConfig(OP('A', 'gen-A', '10'));

    // 남이 포인터만 흔들어 놨다. 리더는 그대로다.
    fx.publishedRecord = {
      generation: 'gen-X',
      leaderToken: '10',
      operationId: 'X',
      transitionId: 'X',
      generationDigest: 'sha256:gen-X',
    };
    const r = await LocalDataplaneDriver.create({ store, effects: fx }).reconcileConfig();

    expect(r.kind, '되돌릴 수 있는데 손을 놨다').toBe('repaired');
    expect(fx.publishedRecord?.generation).toBe('gen-A');
  });
});

describe('④ 라운드를 소진하면 수렴했다고 말하지 않는다', () => {
  it('기준이 계속 바뀌면 관측 없이 converged 를 돌려주지 않는다', async () => {
    const store = new MemoryStore();
    await LocalDataplaneDriver.create({ store, effects: new FakeEffects() })
      .applyConfig(OP('A', 'gen-A', '10'));

    let flips = 0;
    const shifting = new (class extends FakeEffects {
      override async observePublished(): Promise<PublishedState> {
        // 관측하는 사이 기준이 바뀐다.
        flips += 1;
        const stored = store.load()!;
        const payload = stored.payload as { lastActivated?: unknown };
        payload.lastActivated = {
          generation: `gen-${flips}`,
          leaderToken: '10',
          operationId: `op-${flips}`,
          transitionId: `t-${flips}`,
          generationDigest: `sha256:gen-${flips}`,
        };
        await store.save({ version: stored.version + 1, payload });
        return { kind: 'none' };
      }
    })();

    const r = await LocalDataplaneDriver.create({ store, effects: shifting }).reconcileConfig();

    expect(flips, '기준을 흔들지 못했다 — 반례를 재현하지 못한 것이다').toBeGreaterThanOrEqual(3);
    expect(r.kind, '아무것도 관측하지 않고 수렴했다고 답했다').not.toBe('converged');
  });
});
