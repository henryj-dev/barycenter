/**
 * 17차 검수 반례 A — **내 두 규칙이 서로 반대를 명령한다**
 *
 * 16차에 이렇게 고쳤다: 후보에 완결의 뜻(`pendingEpochs`)이 없으면 **절대 승격하지
 * 않는다.** 근거는 "기준이 없는 것은 `no_baseline` 으로 드러나고 수렴이 다시 만든다.
 * 거짓 기준보다 낫다" 였다.
 *
 * 그런데 I6(b)는 이렇게 말한다: 저널이 `activated` 인데 후보가 사라졌으면 **반드시**
 * 기준이 그것이어야 한다.
 *
 * 뜻 없는 후보 + `activated` 저널 = **어떤 쓰기로도 빠져나올 수 없다.**
 *
 * ```
 * recoverConfig    → InvariantViolation (몇 번을 불러도)
 * fence('11')      → InvariantViolation (신임 리더도 막힌다)
 * applyConfig(C)   → operation_in_flight (모든 오퍼레이션 차단)
 * reconcileConfig  → converged(gen-A)   ← 좌표는 epoch 2(gen-B) 인데
 * ```
 *
 * 마지막 줄이 제일 나쁘다. 막힌 것도 문제지만 **수렴이 "다 됐다" 고 답한다.** 16차 주석의
 * 근거가 틀렸다 — `no_baseline` 이 아니라 **낡은 기준**이고, 수렴은 그걸 정답으로 읽는다.
 *
 * 고치는 방향: 완결의 뜻을 **저널**에서 가져온다. 저널의 op 는 실행권 아래서 쓰였으므로
 * 호출자가 준 것이 아니다 — 16차가 막으려던 것(호출자를 믿는 것)에 해당하지 않는다.
 */
import { describe, expect, it } from 'vitest';
import { DpAgent, MemoryStore, tupleFor } from '../../src/dp/agent.js';
import { FakeEffects } from '../../src/dp/apply.js';
import { LocalDataplaneDriver } from '../../src/dp/driver.js';
import type { ApplyOperation, PublishedState } from '../../src/dp/operation.js';

const OP = (id: string, generation: string, from: string, to: string): ApplyOperation => ({
  leaderToken: '10',
  operationId: id,
  transitionId: id,
  affectedPlanes: ['http', 'stream'],
  targetGeneration: generation,
  generationDigest: `sha256:${generation}`,
  planes: {
    http: {
      expectedCurrent: { activationEpoch: from, membershipRevision: from },
      target: { activationEpoch: to, membershipRevision: to },
      payloadDigest: `sha256:h-${id}`,
    },
    stream: {
      expectedCurrent: { activationEpoch: from, membershipRevision: from },
      target: { activationEpoch: to, membershipRevision: to },
      payloadDigest: `sha256:s-${id}`,
    },
  },
});

/**
 * gen-A 를 기준으로 세운 뒤, gen-B 를 전 평면 넘기고 `activated` 저널까지 쓴다.
 * 그리고 **15차 이전 직렬화를 흉내내** 완결의 뜻만 지운다 — 16차 반례 ① 과 같은 수술이다.
 */
async function legacyCandidate(): Promise<{ store: MemoryStore; effects: FakeEffects }> {
  const store = new MemoryStore();
  const effects = new FakeEffects();
  await LocalDataplaneDriver.create({ store, effects }).applyConfig(OP('A', 'gen-A', '0', '1'));

  const agent = new DpAgent(store);
  const b = OP('B', 'gen-B', '1', '2');
  await agent.reserveAll(b, { op: b, phase: 'preflight', reloadAttempts: 0, progress: {} });
  for (const plane of ['http', 'stream'] as const) {
    await agent.stage(tupleFor(b, plane), null);
    await agent.commit(tupleFor(b, plane), { acceptingGeneration: 'gen-B' });
  }
  await agent.writeJournal({
    op: b, phase: 'activated', reloadAttempts: 1,
    seq: (agent.readJournal()?.seq ?? 0) + 1,
    progress: { http: 'committed', stream: 'committed' },
  });

  const stored = store.load()!;
  const payload = stored.payload as Record<string, unknown>;
  delete payload.pendingEpochs;
  await store.save({ version: stored.version + 1, payload });
  return { store, effects };
}

describe('뜻 없는 후보가 상태를 잠그지 않는다', () => {
  it('복구가 빠져나온다 — 몇 번을 불러도 같은 자리에서 죽지 않는다', async () => {
    const { store, effects } = await legacyCandidate();
    const driver = LocalDataplaneDriver.create({ store, effects });

    const first = await driver.recoverConfig();
    expect(first.phase, '복구가 종단을 못 봤다').toBe('activated');
    expect(
      new DpAgent(store).activeOperation(),
      '복구 뒤에도 실행권이 남았다',
    ).toBeUndefined();
  });

  it('신임 리더가 들어올 수 있다', async () => {
    const { store } = await legacyCandidate();
    await expect(new DpAgent(store).fence('11'), 'fence 가 막혔다').resolves.toBeDefined();
  });

  it('다음 오퍼레이션이 들어간다', async () => {
    const { store, effects } = await legacyCandidate();
    const driver = LocalDataplaneDriver.create({ store, effects });
    await driver.recoverConfig();

    const r = await driver.applyConfig(OP('C', 'gen-C', '2', '3'));
    expect(r.phase, '전환이 영구히 막혔다').toBe('activated');
  });

  it('**수렴이 낡은 기준을 정답이라고 하지 않는다** — 좌표는 이미 지나갔다', async () => {
    const { store, effects } = await legacyCandidate();

    const r = await LocalDataplaneDriver.create({ store, effects }).reconcileConfig();

    expect(new DpAgent(store).coordinate('http').activationEpoch, '전제가 성립하지 않는다').toBe('2');
    // **조건부로 적으면 안 된다** (18차 ④). 처음엔 `if (r.kind === 'converged')` 안에서만
    // 검사해서, 코드가 `diverged` 나 `no_baseline` 같은 다른 오답을 내도 초록이었다.
    // 무엇이 나와야 하는지를 직접 못박는다.
    // 18차 검수가 `dirty` 의 의미 과적을 지적해 변종을 갈랐다 — 여긴 "복구를 부르면
    // 끝난다" 이지 "네가 정해라" 가 아니다.
    expect(r.kind, '끝나지 않은 활성화를 드러내지 않았다').toBe('unfinished');
  });

  it('빠져나온 뒤 기준은 실제로 활성화된 세대다', async () => {
    const { store, effects } = await legacyCandidate();
    await LocalDataplaneDriver.create({ store, effects }).recoverConfig();

    expect(
      new DpAgent(store).lastActivated()?.generation,
      '전 평면이 넘어갔는데 기준이 옛 세대로 남았다',
    ).toBe('gen-B');
  });
});

describe('저널에서 뜻을 가져오되 남의 저널은 믿지 않는다', () => {
  /**
   * 뜻을 저널에서 가져오게 하면서 신원 대조를 같이 넣었다. 그게 없으면 **다른 전환의
   * 저널**로 이 후보의 완결을 판정하게 된다 — 16차가 막으려던 것(남이 준 평면 집합을
   * 믿는 것)이 저널을 통해 되돌아오는 길이다.
   */
  it('후보와 저널이 다른 전환이면 승격하지 않는다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);

    // B 가 http 만 넘기고 뜻을 잃는다.
    const b = OP('B', 'gen-B', '0', '1');
    await agent.reserveAll(b, { op: b, phase: 'preflight', reloadAttempts: 0, progress: {} });
    await agent.stage(tupleFor(b, 'http'), null);
    await agent.commit(tupleFor(b, 'http'), { acceptingGeneration: 'gen-B' });
    {
      const stored = store.load()!;
      const payload = stored.payload as Record<string, unknown>;
      delete payload.pendingEpochs;
      await store.save({ version: stored.version + 1, payload });
    }

    // 저널만 **다른 전환**의 것으로 바꾼다. 그 전환은 http 하나만 선언한다.
    const other: ApplyOperation = {
      ...OP('OTHER', 'gen-O', '0', '1'),
      affectedPlanes: ['http'],
      planes: { http: OP('OTHER', 'gen-O', '0', '1').planes.http! },
    };
    {
      const stored = store.load()!;
      const payload = stored.payload as { journal?: unknown };
      payload.journal = {
        op: other, phase: 'activated', reloadAttempts: 1, seq: 99,
        progress: { http: 'committed' },
      };
      await store.save({ version: stored.version + 1, payload });
    }

    await new DpAgent(store).finishOperation(b);

    expect(
      new DpAgent(store).lastActivated(),
      '남의 저널이 선언한 평면으로 이 후보의 완결을 판정했다',
    ).toBeUndefined();
  });
});

describe('고아 저널을 덮을 때는 닫고 덮는다 (반례 D)', () => {
  /**
   * 비종단 저널 + 실행권 없음(고아) 상태에서 새 오퍼레이션이 들어오면, `reserveAll` 이
   * 그 저널을 **그냥 덮었다.** 옛 전환은 종단 기록 없이 증발하고 **예약이 남는다** —
   * 그 좌표는 아무도 못 쓴다. 6차 ④ · 16차 ② 와 같은 부류다(이번엔 실행권이 아니라 슬롯).
   *
   * 17차 검수가 "미확인" 으로 올렸고, 재현했다.
   */
  const orphan = async (): Promise<{ store: MemoryStore; a: ApplyOperation }> => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const a = OP('A', 'gen-A', '0', '1');
    await agent.reserveAll(a, { op: a, phase: 'preflight', reloadAttempts: 0, progress: {} });
    await agent.writeJournal({
      op: a, phase: 'published', reloadAttempts: 0,
      seq: (agent.readJournal()?.seq ?? 0) + 1,
      progress: { http: 'reserved', stream: 'reserved' },
    });
    await agent.finishOperation(a); // 실행권만 놓는다 — 저널과 예약은 남는다
    return { store, a };
  };

  it('새 오퍼레이션이 들어와도 옛 예약이 남지 않는다', async () => {
    const { store } = await orphan();
    expect(
      new DpAgent(store).reservationOwner('http', '1'),
      '전제가 성립하지 않는다 — 고아 예약이 있어야 한다',
    ).toBeDefined();

    const b = OP('B', 'gen-B', '0', '2');
    await new DpAgent(store).reserveAll(b, {
      op: b, phase: 'preflight', reloadAttempts: 0, progress: {},
    });

    expect(
      new DpAgent(store).reservationOwner('http', '1'),
      '옛 예약이 남았다 — 그 좌표는 아무도 못 쓴다',
    ).toBeUndefined();
  });

  it('옛 전환이 종단 기록 없이 사라지지 않는다', async () => {
    const { store } = await orphan();
    const b = OP('B', 'gen-B', '0', '2');
    await new DpAgent(store).reserveAll(b, {
      op: b, phase: 'preflight', reloadAttempts: 0, progress: {},
    });

    const payload = store.load()!.payload as { terminal?: Record<string, string> };
    expect(
      Object.keys(payload.terminal ?? {}),
      '옛 전환이 종단 기록 없이 증발했다 — 무엇이 됐는지 답할 수 없다',
    ).not.toHaveLength(0);
  });

  it('진행 중인 남의 저널은 여전히 못 덮는다 — 실행권이 있으면 막힌다', async () => {
    const store = new MemoryStore();
    const a = OP('A', 'gen-A', '0', '1');
    await new DpAgent(store).reserveAll(a, {
      op: a, phase: 'preflight', reloadAttempts: 0, progress: {},
    });

    const b = OP('B', 'gen-B', '0', '2');
    await expect(
      new DpAgent(store).reserveAll(b, {
        op: b, phase: 'preflight', reloadAttempts: 0, progress: {},
      }),
      '진행 중인 전환을 밀고 들어갔다',
    ).rejects.toMatchObject({ kind: 'operation_in_flight' });
  });
});

describe('관측 창 안에서 생긴 후보도 수렴이 본다 (18차 반례 #1)', () => {
  /**
   * 17차 A 를 고치면서 후보 검사를 **라운드 머리에서 한 번**만 했다. 그 뒤 관측 두 번을
   * 지나 판정하는데, 판정 직전의 읽고-확인에는 `#stillBaseline` 만 있고 후보가 없었다.
   *
   * 14차에 "읽고-확인" 집합을 만들어 놓고, 17차에 새로 만든 "믿을 수 없는 상태"(후보)를
   * **그 집합에 넣지 않은 것**이다. 열 회차 연속으로 직전 수정이 구멍을 남겼다.
   *
   * 재현: 수렴이 `observeActivation` 응답을 기다리는 사이 다른 인스턴스가 gen-B 를 전
   * 평면 커밋한다(finish 전). 관측은 유효하지만 배달이 늦었을 뿐이다.
   *
   * ```
   * 기대: dirty — 끝나지 않은 활성화가 있으면 기준을 믿을 수 없다
   * 실제: converged(gen-A)   ← 좌표는 epoch 2, 후보는 gen-B
   * ```
   */
  it('관측 중에 후보가 생기면 converged 라고 답하지 않는다', async () => {
    const store = new MemoryStore();
    const seed = new FakeEffects();
    await LocalDataplaneDriver.create({ store, effects: seed }).applyConfig(OP('A', 'gen-A', '0', '1'));

    let slipped = false;
    const late = new (class extends FakeEffects {
      override async observeActivation() {
        if (!slipped) {
          slipped = true;
          const other = new DpAgent(store);
          const b = OP('B', 'gen-B', '1', '2');
          await other.reserveAll(b, { op: b, phase: 'preflight', reloadAttempts: 0, progress: {} });
          for (const plane of ['http', 'stream'] as const) {
            await other.stage(tupleFor(b, plane), null);
            await other.commit(tupleFor(b, plane), { acceptingGeneration: 'gen-B' });
          }
        }
        return super.observeActivation();
      }
    })();
    late.publishedRecord = seed.publishedRecord;
    late.acceptingGeneration = 'gen-A';

    const r = await LocalDataplaneDriver.create({ store, effects: late }).reconcileConfig();

    expect(slipped, '창을 만들지 못했다 — 반례를 재현하지 못한 것이다').toBe(true);
    expect(new DpAgent(store).coordinate('http').activationEpoch, '전제가 성립하지 않는다').toBe('2');
    expect(r.kind, '좌표가 지나갔는데 옛 기준으로 수렴했다고 답했다').not.toBe('converged');
  });
});

describe('수렴은 끝난 활성화를 되돌리지 않는다 (19차 반례 #3)', () => {
  /**
   * **답 게이트에는 후보를 넣고 부작용 게이트에는 안 넣었다.**
   *
   * 18차에 `#settled`(기준 + 미완 활성화)를 만들어 `converged`·`repaired` 를 막았다.
   * 그런데 **되돌리기 직전의 검사**(`#stillBaseline`)와 **부작용 직전의 표**
   * (`#lease.assertValid`)에는 후보 절을 안 넣었다. 열 회차 반복된 그 모양이다 —
   * 규칙을 만들고 자리 하나를 빠뜨린다. 18차가 그 패턴을 지적했는데 같은 회차에서 또 했다.
   *
   * ```
   * 기대: 되돌리기 중단 — 후보가 있으면 기준을 믿을 수 없다
   * 실제: publish(gen-A) 1회 · HUP 1회   ← 좌표는 epoch 2, 후보는 gen-B
   * ```
   *
   * **증거까지 남긴 활성화를 컨트롤 플레인 자신의 수렴이 세상에서 되돌렸다.**
   * §3.3 은 "이미 넘어간 좌표는 건드리지 않는다 — 롤백은 새 활성화 사건" 이라고 한다.
   * ▲ 넷의 근거가 전부 "수렴이 덮는다" 인데, 여기서는 **거꾸로 덮었다.**
   */
  it('되돌리는 사이 후보가 생기면 게시도 HUP 도 나가지 않는다', async () => {
    const store = new MemoryStore();
    const seed = new FakeEffects();
    await LocalDataplaneDriver.create({ store, effects: seed }).applyConfig(OP('A', 'gen-A', '0', '1'));

    let slipped = false;
    const fx = new (class extends FakeEffects {
      override async observePublished(): Promise<PublishedState> {
        return { kind: 'none' }; // 포인터 유실 — 되돌리기 경로로 들어간다
      }
      override async observeActivation() {
        if (!slipped) {
          slipped = true;
          const other = new DpAgent(store);
          const b = OP('B', 'gen-B', '1', '2');
          await other.reserveAll(b, { op: b, phase: 'preflight', reloadAttempts: 0, progress: {} });
          for (const plane of ['http', 'stream'] as const) {
            await other.stage(tupleFor(b, plane), null);
            await other.commit(tupleFor(b, plane), { acceptingGeneration: 'gen-B' });
          }
        }
        return super.observeActivation();
      }
    })();
    fx.acceptingGeneration = 'gen-A';
    const publishes = fx.publishCalls;
    const reloads = fx.reloadSignals;

    await LocalDataplaneDriver.create({ store, effects: fx }).reconcileConfig();

    expect(slipped, '창을 만들지 못했다 — 반례를 재현하지 못한 것이다').toBe(true);
    expect(new DpAgent(store).coordinate('http').activationEpoch, '전제가 성립하지 않는다').toBe('2');
    expect(fx.publishCalls - publishes, '끝난 활성화 위로 옛 기준을 게시했다').toBe(0);
    expect(fx.reloadSignals - reloads, '끝난 활성화 위로 HUP 을 보냈다').toBe(0);
  });
});

describe('끝나지 않은 전환을 converged 로 가리지 않는다 (19차 반례 #1)', () => {
  /**
   * 17차 A 는 "활성화가 끝났는데 안 올라간 후보" 를 드러내게 했다. 그런데 **정반대 쪽**
   * — "시작했는데 안 끝난 오퍼레이션" — 은 그대로 `converged` 로 가려졌다.
   *
   * ```
   * applyConfig(A)                    → activated, 기준 gen-A
   * applyConfig(B) 가 게시 직전 끊긴다  → 저널 publish_intent · 실행권 B · intent gen-B
   * reconcileConfig()                 → converged(gen-A)
   * applyConfig(C)                    → operation_in_flight   ← 전부 막혀 있다
   * ```
   *
   * `converged` 는 "손 떼도 된다" 는 뜻이다. 그런데 그 순간 apply 경로는 봉쇄고, 복구
   * 한 번이면 기준이 gen-B 로 바뀐다. **답이 복구 한 번 거리의 거짓이었다.**
   *
   * §9.2 는 수렴을 주기적으로 부른다고 못박았으므로 "크래시 뒤엔 복구가 먼저" 는 방어가
   * 되지 않는다 — 17차 A 때도 같은 방어를 받아들이지 않았다.
   */
  it('끊긴 오퍼레이션이 남아 있으면 수렴했다고 답하지 않는다', async () => {
    const store = new MemoryStore();
    const fx = new FakeEffects();
    const driver = LocalDataplaneDriver.create({ store, effects: fx });
    await driver.applyConfig(OP('A', 'gen-A', '0', '1'));

    fx.crashBeforeEffect = 'publish';
    await driver.applyConfig(OP('B', 'gen-B', '1', '2')).catch(() => undefined);
    fx.crashBeforeEffect = undefined;

    expect(new DpAgent(store).activeOperation()?.operationId, '전제가 성립하지 않는다').toBe('B');

    const r = await driver.reconcileConfig();
    expect(r.kind, '막힌 apply 경로를 수렴이라고 답했다').toBe('unfinished');
  });

  it('그 답을 받고 복구하면 끝난다 — 무한 루프가 아니다', async () => {
    const store = new MemoryStore();
    const fx = new FakeEffects();
    const driver = LocalDataplaneDriver.create({ store, effects: fx });
    await driver.applyConfig(OP('A', 'gen-A', '0', '1'));

    fx.crashBeforeEffect = 'publish';
    await driver.applyConfig(OP('B', 'gen-B', '1', '2')).catch(() => undefined);
    fx.crashBeforeEffect = undefined;

    expect((await driver.reconcileConfig()).kind).toBe('unfinished');
    await driver.recoverConfig();
    expect((await driver.reconcileConfig()).kind, '복구했는데도 안 끝난다').toBe('converged');
  });
});
