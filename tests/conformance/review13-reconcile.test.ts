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

describe('관측하는 사이 기준이 바뀌면 옛 기준으로 수렴을 선언하지 않는다', () => {
  /**
   * 14차 검수. 조기 `converged` 경로에는 재검사가 없었다 — `expected` 를 읽고 두 번
   * await 한 뒤, 그 사이 기준이 바뀌었는지 보지 않고 `converged(expected)` 를 돌려줬다.
   *
   * 호출자에게 "손 떼도 된다" 고 말하는 답이라 틀리면 비싸다. 읽고-확인하는 seqlock 이다.
   */
  it('조기 converged 앞에서 기준을 다시 본다', async () => {
    const store = new MemoryStore();
    const seed = new FakeEffects();
    await LocalDataplaneDriver.create({ store, effects: seed }).applyConfig(OP('A', 'gen-A', '10'));

    let moved = false;
    const shifting = new (class extends FakeEffects {
      override async observeActivation() {
        // 바깥은 gen-A 그대로인데, 관측하는 사이 기준이 gen-B 로 옮겨 갔다.
        if (!moved) {
          moved = true;
          const stored = store.load()!;
          const payload = stored.payload as { lastActivated?: unknown };
          payload.lastActivated = {
            generation: 'gen-B', leaderToken: '10', operationId: 'B',
            transitionId: 'B', generationDigest: 'sha256:gen-B',
          };
          await store.save({ version: stored.version + 1, payload });
        }
        return super.observeActivation();
      }
    })();
    shifting.publishedRecord = seed.publishedRecord;
    shifting.acceptingGeneration = 'gen-A';

    const r = await LocalDataplaneDriver.create({ store, effects: shifting }).reconcileConfig();

    expect(moved, '기준을 흔들지 못했다 — 반례를 재현하지 못한 것이다').toBe(true);
    if (r.kind === 'converged') {
      expect(r.record.generation, '옛 기준으로 수렴했다고 답했다').not.toBe('gen-A');
    }
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

describe('수렴은 마감이 있다 — apply 를 무한정 막지 않는다', () => {
  /**
   * 14차 검수. 부작용마다 10 초가 **새로** 시작됐다. 기준이 매 라운드 바뀌고 각 관측이
   * 10 초 직전에 끝나는 스케줄이면 한 번의 `reconcileConfig` 가 2 분 넘게 인스턴스 큐를
   * 잡는다 — 그동안 apply 도 못 들어온다. `reconcileConfig` 와 `applyConfig` 가 같은
   * 큐에서 도는 것이 11차의 결론이었으므로, 여기 머무는 시간이 곧 막히는 시간이다.
   *
   * 시계를 밀어서 본다. 30 초를 실제로 기다리면 그것대로 나쁜 테스트가 된다.
   */
  it('마감을 넘기면 부작용을 더 부르지 않고 끝낸다', async () => {
    const store = new MemoryStore();
    const seed = new FakeEffects();
    await LocalDataplaneDriver.create({ store, effects: seed }).applyConfig(OP('A', 'gen-A', '10'));

    const real = Date.now;
    let offset = 0;
    Date.now = () => real.call(Date) + offset;
    try {
      let observes = 0;
      const slow = new (class extends FakeEffects {
        override async observePublished(): Promise<PublishedState> {
          observes += 1;
          offset += 11_000; // 부작용 하나가 예산 직전까지 걸렸다고 친다
          // 기준도 매번 바뀐다 — 그래야 라운드를 다시 돈다. 이 둘이 겹치는 스케줄이
          // 바로 검수가 지목한 것이다("각 관측이 10 초 직전에 끝나고 매번 baseline 이 바뀐다").
          const stored = store.load()!;
          const payload = stored.payload as { lastActivated?: unknown };
          payload.lastActivated = {
            generation: `gen-${observes}`, leaderToken: '10',
            operationId: `op-${observes}`, transitionId: `t-${observes}`,
            generationDigest: `sha256:gen-${observes}`,
          };
          await store.save({ version: stored.version + 1, payload });
          return { kind: 'none' };
        }
      })();

      const r = await LocalDataplaneDriver.create({ store, effects: slow })
        .reconcileConfig()
        .catch((e: unknown) => ({ kind: 'threw' as const, why: (e as { kind?: string }).kind }));

      expect(observes, '관측을 아예 안 했다 — 반례를 재현하지 못한 것이다').toBeGreaterThan(0);
      // **마감이 실제로 걸렸는지**를 본다. 처음엔 흘러간 시간만 봤는데, 마감을 없애도
      // 그 수치가 그대로라 뮤테이션이 통과했다 — 제목이 확인보다 넓었다.
      expect(r, '마감을 넘겼는데 부작용을 계속 불렀다').toEqual({ kind: 'threw', why: 'stale_state' });
      expect(offset, '마감 뒤에도 부작용을 더 불렀다').toBeLessThanOrEqual(33_000);
    } finally {
      Date.now = real;
    }
  });
});

describe('수렴이 건네는 lease 는 리더도 확인한다 (15차)', () => {
  /**
   * 15차 검수. 수렴의 게시 lease 는 **기준만** 봤고, HUP lease 는 `() => undefined` —
   * **아무것도 안 봤다.** 그래서 규약을 지켜 `assertValid()` 를 부르는 `Effects` 구현도
   * 낡은 리더 밑에서 그대로 진행한다. fence 는 기준(`lastActivated`)을 바꾸지 않으므로
   * 기준 검사만으로는 리더 교체를 못 본다.
   *
   * 부작용이 실제로 나가는 것까지는 재현하지 못했다 — 관측 뒤 토큰 검사가 그 앞을 막는다.
   * 그래도 **lease 가 약속을 안 지키는 것 자체**가 결함이다. 규약은 "되돌릴 수 없는 연산
   * 직전에 이걸 확인하면 안전하다" 인데, 확인해도 안전하지 않았다.
   */
  /** 리더는 그대로 두고 **기준만** 옮긴다. 토큰 검사로는 이걸 못 본다. */
  const moveBaseline = async (store: MemoryStore): Promise<void> => {
    const stored = store.load()!;
    const payload = stored.payload as { lastActivated?: unknown };
    payload.lastActivated = {
      generation: 'gen-Z', leaderToken: '10', operationId: 'Z',
      transitionId: 'Z', generationDigest: 'sha256:gen-Z',
    };
    await store.save({ version: stored.version + 1, payload });
  };

  const leaseChecks = async (
    fenceBefore: 'publish' | 'reload' | 'baseline',
  ): Promise<{ threw: string | undefined }> => {
    const store = new MemoryStore();
    const seed = new FakeEffects();
    await LocalDataplaneDriver.create({ store, effects: seed }).applyConfig(OP('A', 'gen-A', '10'));

    let threw: string | undefined;
    const fx = new (class extends FakeEffects {
      override async observePublished(): Promise<PublishedState> {
        return { kind: 'none' }; // 어긋나 있다 — 수렴이 고치려 든다
      }
      override async publish(record: never, lease: { assertValid: () => void }) {
        if (fenceBefore === 'publish' || fenceBefore === 'baseline') {
          if (fenceBefore === 'publish') await new DpAgent(store).fence('11');
          else await moveBaseline(store);
          try { lease.assertValid(); } catch (e) { threw = (e as { kind?: string }).kind; }
        }
        return super.publish(record, lease as never);
      }
      override async signalReload(lease: { assertValid: () => void }) {
        if (fenceBefore === 'reload') {
          await new DpAgent(store).fence('11');
          try { lease.assertValid(); } catch (e) { threw = (e as { kind?: string }).kind; }
        }
        return super.signalReload(lease as never);
      }
    })();

    await LocalDataplaneDriver.create({ store, effects: fx }).reconcileConfig().catch(() => undefined);
    return { threw };
  };

  it('게시 직전 lease 가 리더 교체를 막는다', async () => {
    expect((await leaseChecks('publish')).threw, 'lease 가 통과시켰다').toBe('stale_leader');
  });

  it('HUP 직전 lease 가 리더 교체를 막는다 — 여기는 아예 비어 있었다', async () => {
    expect((await leaseChecks('reload')).threw, 'lease 가 아무것도 확인하지 않았다').toBe('stale_leader');
  });

  /**
   * **토큰 검사와 기준 검사는 서로를 대신하지 못한다.** 리더는 그대로인데 기준만 옮겨
   * 가는 경우가 있고(다른 오퍼레이션이 활성화를 끝냈다), 그때 옛 기준으로 되돌리면
   * 방금 올라간 것을 지운다.
   */
  it('리더가 그대로여도 기준이 옮겨 갔으면 막는다', async () => {
    expect((await leaseChecks('baseline')).threw, '기준이 바뀌었는데 lease 가 통과시켰다')
      .toBe('stale_leader');
  });
});
