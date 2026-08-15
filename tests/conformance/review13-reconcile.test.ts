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
import { DpAgent, MemoryStore, tupleFor } from '../../src/dp/agent.js';
import { ApplyRunner, FakeEffects } from '../../src/dp/apply.js';
import { LocalDataplaneDriver } from '../../src/dp/driver.js';
import type { ApplyOperation, PublishedState } from '../../src/dp/operation.js';

const FAST = { attempts: 1, intervalMs: 0, sleep: async () => {}, effectTimeoutMs: 200 };

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

  /**
   * ①을 고치면서 **정당한 수렴까지 막았다** (14차 검수가 짚었다). 토큰 검사를 관측
   * **앞에** 뒀더니, fence 만 오르고 바깥은 그대로인 정합한 상태에도 `diverged` 라고
   * 답했다. 아무것도 갈라지지 않았는데.
   *
   * 읽기와 쓰기를 갈라야 했다. **관측은 누구나 한다. 리더만 고친다.**
   */
  it('fence 만 올랐고 바깥이 정합하면 converged 다 — 막기만 하는 게 아니다', async () => {
    const store = new MemoryStore();
    const fx = new FakeEffects();
    await LocalDataplaneDriver.create({ store, effects: fx }).applyConfig(OP('A', 'gen-A', '10'));

    // 신임이 fence 만 했다. 새 게시도 활성화도 없고 바깥은 여전히 gen-A 다.
    await new DpAgent(store).fence('11');
    const before = fx.publishCalls;

    const r = await LocalDataplaneDriver.create({ store, effects: fx }).reconcileConfig();

    expect(r.kind, '갈라진 것이 없는데 갈라졌다고 답했다').toBe('converged');
    expect(fx.publishCalls - before, '읽기만 하면 되는데 게시했다').toBe(0);
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

// ── 내가 만든 구멍 — 13차 ② 수정이 열었다 ────────────────────────────────

describe('종단 기록 뒤 죽어도 수렴 기준이 사라지지 않는다', () => {
  /**
   * 13차 ② 를 고치면서 승격을 `finishOperation({promote})` 안으로 접었다. 그런데
   * **`recover()` 의 종단 경로는 `promote` 를 안 넘긴다.** 그래서 `activated` 저널을
   * 쓰고 반납 전에 죽으면, 복구가 `pendingActivation` 을 **승격하지 않고 지운다.**
   *
   * 활성화는 실제로 일어났는데 되돌릴 기준이 사라진다 — reconcile 이 `no_baseline`
   * 이라고 답한다. 게시는 나갔는데 기준이 없다고 하는 것은 10차·12차에서 이미 한 번씩
   * 틀렸던 답이다.
   *
   * 14차 검수가 코드 추적만으로 이 후보를 지목했다(실행 전에 죽었다). 재현해 보니 맞다.
   */
  it('activated 뒤 크래시 → 복구가 기준을 승격한다', async () => {
    const store = new MemoryStore();
    const fx = new FakeEffects();
    const agent = new DpAgent(store);
    const op = OP('done', 'gen-A', '10');

    fx.publishedRecord = {
      generation: 'gen-A', leaderToken: '10', operationId: 'done',
      transitionId: 'done', generationDigest: 'sha256:gen-A',
    };
    fx.acceptingGeneration = 'gen-A';

    // 전 평면이 넘어갔고 종단 저널까지 썼다. 그 직후 죽는다 — 반납은 못 했다.
    await agent.reserveAll(op);
    for (const plane of ['http', 'stream'] as const) {
      await agent.stage(tupleFor(op, plane), null);
      await agent.commit(tupleFor(op, plane), { acceptingGeneration: 'gen-A' });
    }
    await agent.writeJournal({
      op, phase: 'activated', reloadAttempts: 1, seq: 1,
      progress: { http: 'committed', stream: 'committed' },
    });
    expect(agent.lastActivated(), '아직 승격 전이어야 반례가 성립한다').toBeUndefined();

    // 재시작.
    const r = await new ApplyRunner(new DpAgent(store), fx, FAST).recover();
    expect(r.phase).toBe('activated');

    expect(
      new DpAgent(store).lastActivated()?.generation,
      '활성화는 일어났는데 되돌릴 기준이 사라졌다',
    ).toBe('gen-A');

    const rec = await LocalDataplaneDriver.create({ store, effects: fx }).reconcileConfig();
    expect(rec.kind, '기준이 없다고 답했다').toBe('converged');
  });

  it('실패로 닫힌 종단은 승격하지 않는다 — 13차 ② 와 같은 종류다', async () => {
    const store = new MemoryStore();
    const fx = new FakeEffects();
    const agent = new DpAgent(store);
    const op = OP('half', 'gen-A', '10');

    // http 만 넘어갔고, 저널은 partial_exhausted 로 닫혔다.
    await agent.reserveAll(op);
    await agent.stage(tupleFor(op, 'http'), null);
    await agent.commit(tupleFor(op, 'http'), { acceptingGeneration: 'gen-A' });
    await agent.writeJournal({
      op, phase: 'partial_exhausted', reloadAttempts: 9, seq: 1,
      progress: { http: 'committed', stream: 'failed' },
    });

    await new ApplyRunner(new DpAgent(store), fx, FAST).recover();

    expect(
      new DpAgent(store).lastActivated(),
      '한 평면만 넘어간 것을 되돌릴 기준으로 삼았다',
    ).toBeUndefined();
  });
});
