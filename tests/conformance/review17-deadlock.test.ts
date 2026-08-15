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
import { DpAgent, DpRejection, MemoryStore, tupleFor } from '../../src/dp/agent.js';
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

describe('갈라진 것이 없으면 갈라졌다고 하지 않는다 (19차 반례 #2)', () => {
  /**
   * 되돌린 뒤 관측하는 사이 후보가 생기면 `diverged{ expected: gen-A, found: gen-A }` 가
   * 나왔다 — **둘이 같은 기록**인데 "갈라졌다" 고 답한다.
   *
   * 게이트가 참/거짓만 돌려줘서, 자리마다 실패를 알아서 해석했다. 후보 때문에 실패한
   * 것도 `diverged` 로 나간 것이다. `dirty` 를 가른 것과 같은 병 — 한 이름에 여러 뜻.
   *
   * 게이트가 **왜 아닌지**까지 답하게 했다. 후보면 `unfinished`, 기준이 옮겨 갔으면
   * 다시 본다. 변종을 새로 만들 필요가 없었다.
   */
  it('되돌린 뒤 후보가 생기면 unfinished 다', async () => {
    const store = new MemoryStore();
    const seed = new FakeEffects();
    await LocalDataplaneDriver.create({ store, effects: seed }).applyConfig(OP('A', 'gen-A', '0', '1'));

    let observes = 0;
    let slipped = false;
    const fx = new (class extends FakeEffects {
      override async observePublished(): Promise<PublishedState> {
        observes += 1;
        return observes === 1 ? { kind: 'none' } : super.observePublished();
      }
      override async observeActivation() {
        if (observes >= 2 && !slipped) {
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
    fx.publishedRecord = seed.publishedRecord;
    fx.acceptingGeneration = 'gen-A';

    const r = await LocalDataplaneDriver.create({ store, effects: fx }).reconcileConfig();

    expect(slipped, '창을 만들지 못했다 — 반례를 재현하지 못한 것이다').toBe(true);
    expect(r.kind, '갈라진 것이 없는데 갈라졌다고 답했다').toBe('unfinished');
  });
});

describe('status 가 봉쇄를 보여준다 (19차)', () => {
  /**
   * 끊긴 러너가 실행권을 쥐고 있으면 모든 apply 가 `operation_in_flight` 로 막히는데,
   * `status()` 는 그걸 안 보여줬다. **컨트롤 플레인이 봉쇄를 볼 창구가 `applyConfig`
   * 실패뿐**이었다 — 실패해 봐야 아는 것은 관측이 아니다.
   */
  it('끊긴 전환이 남아 있으면 status 가 그것을 답한다', async () => {
    const store = new MemoryStore();
    const fx = new FakeEffects();
    const driver = LocalDataplaneDriver.create({ store, effects: fx });
    await driver.applyConfig(OP('A', 'gen-A', '0', '1'));
    expect((await driver.status()).unfinished, '정상인데 뭔가 있다고 했다').toBeUndefined();

    fx.crashBeforeEffect = 'publish';
    await driver.applyConfig(OP('B', 'gen-B', '1', '2')).catch(() => undefined);
    fx.crashBeforeEffect = undefined;

    expect(
      (await driver.status()).unfinished?.generation,
      '봉쇄돼 있는데 status 가 조용하다',
    ).toBe('gen-B');

    await driver.recoverConfig();
    expect((await driver.status()).unfinished, '복구했는데도 남아 있다고 한다').toBeUndefined();
  });
});

describe('고아를 닫는 것이 새 오퍼레이션을 막지 않는다 (20차 CE-3)', () => {
  /**
   * 17차 D 를 고치면서 고아 저널을 `supersede` 로 닫게 했다. 그런데 **두 자리가 틀렸다.**
   *
   *   ① 청소가 **슬롯 획득 뒤에** 온다 — 고아의 예약이 아직 있어서 새 오퍼레이션이
   *      `slot_taken` 으로 죽는다. "그 좌표는 아무도 못 쓴다" 를 없애려던 수정이 같은
   *      증상을 한 칸 옆에 다시 만들었다.
   *   ② `supersede` 가 `delete s.activeOperation` 을 **무조건** 한다 — fence 경로에서는
   *      지울 대상이 곧 holder 라 맞지만, 여기서는 **방금 앉힌 신임 실행권**을 지운다.
   *
   * 20차 검수가 찾았다. 열세 번째로 직전 수정이 만든 구멍이다.
   */
  const orphaned = async (): Promise<MemoryStore> => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const a = OP('A', 'gen-A', '0', '1');
    await agent.reserveAll(a, { op: a, phase: 'preflight', reloadAttempts: 0, progress: {} });
    await agent.writeJournal({
      op: a, phase: 'published', reloadAttempts: 0,
      seq: (agent.readJournal()?.seq ?? 0) + 1,
      progress: { http: 'reserved', stream: 'reserved' },
    });
    await agent.finishOperation(a);
    return store;
  };

  it('고아가 남아 있어도 새 오퍼레이션이 들어간다', async () => {
    const store = await orphaned();
    const driver = LocalDataplaneDriver.create({ store, effects: new FakeEffects() });

    const r = await driver.applyConfig(OP('B', 'gen-B', '0', '1'));
    expect(r.phase, '고아가 새 오퍼레이션을 막았다').toBe('activated');
  });

  it('신임 실행권을 스스로 지우지 않는다', async () => {
    const store = await orphaned();
    const b = OP('B', 'gen-B', '0', '1');

    await new DpAgent(store).reserveAll(b, {
      op: b, phase: 'preflight', reloadAttempts: 0, progress: {},
    });

    expect(
      new DpAgent(store).activeOperation()?.operationId,
      '고아를 닫으면서 방금 앉힌 실행권을 지웠다',
    ).toBe('B');
  });

  it('거부당한 오퍼레이션이 나중에 활성화되지 않는다', async () => {
    const store = await orphaned();
    const driver = LocalDataplaneDriver.create({ store, effects: new FakeEffects() });

    const b = await driver.applyConfig(OP('B', 'gen-B', '0', '1'))
      .then((x) => x.phase, () => 'rejected');
    await driver.recoverConfig().catch(() => undefined);

    const baseline = new DpAgent(store).lastActivated()?.generation;
    if (b === 'rejected') {
      expect(baseline, '거부해 놓고 나중에 올렸다 — 9차 "조용한 거짓 성공" 의 거울상이다')
        .not.toBe('gen-B');
    } else {
      expect(baseline, '활성화했다면서 기준이 없다').toBe('gen-B');
    }
  });
});

describe('포기한 전환은 끝난 것이다 (20차 CE-1)', () => {
  /**
   * `abortConfig` 의 계약은 "예약을 반납하고 전환을 **종단 상태로 닫는다**" 인데,
   * **저널을 안 닫았다.** `unfinished` 는 저널 phase 만 보므로 죽은 전환을 "안 끝났다" 고
   * 답한다. 운영자가 포기를 선언했는데 시스템은 "복구해라" 라고 하고, 그동안 진짜
   * 드리프트 수리를 거부한다.
   */
  it('abort 뒤에는 status 도 수렴도 끝났다고 말한다', async () => {
    const store = new MemoryStore();
    const fx = new FakeEffects();
    const driver = LocalDataplaneDriver.create({ store, effects: fx });
    const a = OP('A', 'gen-A', '0', '1');

    fx.crashAfterEffect = 'publish';
    await driver.applyConfig(a).catch(() => undefined);
    fx.crashAfterEffect = undefined;
    await driver.abortConfig(a).catch(() => undefined);

    expect((await driver.status()).unfinished, '포기한 전환을 안 끝났다고 답했다').toBeUndefined();
    expect(
      (await driver.reconcileConfig()).kind,
      '포기한 전환 때문에 수리 경로가 막혔다',
    ).not.toBe('unfinished');
  });
});

describe('처방이 죽지 않는다 (20차 CE-2)', () => {
  /**
   * `unfinished` 는 "**복구를 부르면 끝난다**" 는 뜻이다. 그런데 낡은 토큰의 고아 저널
   * 에서는 `recoverConfig` 가 `stale_leader` 로 죽는다 — **문서화된 처방이 거짓이 된다.**
   * 그동안 수렴은 영영 `unfinished` 만 답한다.
   */
  it('낡은 토큰의 고아도 복구가 마감한다 — abort 를 안 거쳤어도', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const a = OP('A', 'gen-A', '0', '1');
    await agent.reserveAll(a, { op: a, phase: 'preflight', reloadAttempts: 0, progress: {} });
    await agent.writeJournal({
      op: a, phase: 'published', reloadAttempts: 0,
      seq: (agent.readJournal()?.seq ?? 0) + 1,
      progress: { http: 'reserved', stream: 'reserved' },
    });
    await agent.finishOperation(a);        // 고아 — 비종단 저널 + 실행권 없음
    await new DpAgent(store).fence('11');  // 신임이 들어온다

    const driver = LocalDataplaneDriver.create({ store, effects: new FakeEffects() });
    await driver.recoverConfig();

    expect(
      (await driver.status()).unfinished,
      '복구가 낡은 고아를 못 닫아서 수렴이 영영 unfinished 다',
    ).toBeUndefined();
    expect((await driver.reconcileConfig()).kind, '수렴이 봉쇄됐다').not.toBe('unfinished');
  });

  it('신임이 들어온 뒤에도 복구가 고아를 마감한다', async () => {
    const store = new MemoryStore();
    const fx = new FakeEffects();
    const driver = LocalDataplaneDriver.create({ store, effects: fx });
    const a = OP('A', 'gen-A', '0', '1');

    fx.crashAfterEffect = 'publish';
    await driver.applyConfig(a).catch(() => undefined);
    fx.crashAfterEffect = undefined;
    await driver.abortConfig(a).catch(() => undefined);
    await new DpAgent(store).fence('11');

    const r = await driver.recoverConfig();
    expect(['failed', 'superseded', 'no_operation', 'activated', 'partial_exhausted'],
      `복구가 마감하지 못했다: ${r.phase}`).toContain(r.phase);
    expect((await driver.status()).unfinished, '복구했는데도 남아 있다').toBeUndefined();
  });
});

describe('새 판정 자리도 신원을 본다 (21차)', () => {
  /**
   * **열네 번째다. 그리고 병형이 늘 같다** — 새 판정 자리를 만들 때마다 기존 신원
   * 비교(id + 토큰) 관례를 한 번씩 빠뜨린다. `releaseHolderSlots`(9차) ·
   * `finishOperation`(10차) 이 각각 그렇게 물렸고, 20차에 만든 `closeJournal` 이 또 그랬다.
   */
  it('낡은 리더의 abort 가 신임의 저널을 닫지 못한다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    await agent.fence('11');

    const fresh: ApplyOperation = { ...OP('same', 'gen-N', '0', '1'), leaderToken: '11' };
    await agent.reserveAll(fresh, {
      op: fresh, phase: 'preflight', reloadAttempts: 0, progress: {},
    });

    // 낡은 리더(토큰 10)의 지연 abort. 개별 동작은 전부 거부되는데 저널만 닫혔다.
    const stale: ApplyOperation = { ...OP('same', 'gen-O', '0', '1'), leaderToken: '10' };
    await LocalDataplaneDriver.create({ store, effects: new FakeEffects() })
      .abortConfig(stale).catch(() => undefined);

    expect(
      new DpAgent(store).readJournal()?.phase,
      '낡은 토큰이 신임의 진행 중 전환을 죽였다 — §3.5 펜싱 계약 위반',
    ).toBe('preflight');
  });

  it('복구가 낡은 고아를 닫을 때 예약도 반납한다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const a = OP('A', 'gen-A', '0', '1');
    await agent.reserveAll(a, { op: a, phase: 'preflight', reloadAttempts: 0, progress: {} });
    await agent.writeJournal({
      op: a, phase: 'published', reloadAttempts: 0,
      seq: (agent.readJournal()?.seq ?? 0) + 1,
      progress: { http: 'reserved', stream: 'reserved' },
    });
    await agent.finishOperation(a);
    await new DpAgent(store).fence('11');

    const driver = LocalDataplaneDriver.create({ store, effects: new FakeEffects() });
    await driver.recoverConfig();

    expect((await driver.status()).unfinished, '전제가 성립하지 않는다').toBeUndefined();
    const next: ApplyOperation = { ...OP('B', 'gen-B', '0', '1'), leaderToken: '11' };
    const r = await driver.applyConfig(next);
    expect(
      r.phase,
      'status 는 깨끗하다는데 apply 가 죽는다 — 처방이 반쪽이면 운영자가 갈 곳이 없다',
    ).toBe('activated');
  });
});

describe('포기해도 넘어간 평면은 넘어갔다고 적는다 (21차 CE-C)', () => {
  /**
   * `abortConfig` 의 저널 닫기가 커밋된 평면 유무를 안 보고 무조건 `failed` 였다.
   * 부분 활성화 뒤 abort 하면 http 가 새 세대를 서빙 중인데 `partialTransition=false`
   * 로 보고된다 — **15차에 `failAll` 에서 고친 §3.4 거짓말이 한 칸 옆에서 재발했다.**
   */
  it('한 평면이 넘어간 뒤 abort 하면 부분 전환으로 닫힌다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const a = OP('A', 'gen-A', '0', '1');

    await agent.reserveAll(a, { op: a, phase: 'preflight', reloadAttempts: 0, progress: {} });
    await agent.stage(tupleFor(a, 'http'), null);
    await agent.commit(tupleFor(a, 'http'), { acceptingGeneration: 'gen-A' });
    await agent.writeJournal({
      op: a, phase: 'partially_activated', reloadAttempts: 1,
      seq: (agent.readJournal()?.seq ?? 0) + 1,
      progress: { http: 'committed', stream: 'staged' },
    });

    await LocalDataplaneDriver.create({ store, effects: new FakeEffects() })
      .abortConfig(a).catch(() => undefined);

    expect(new DpAgent(store).coordinate('http').activationEpoch, '전제가 성립하지 않는다').toBe('1');
    expect(
      new DpAgent(store).readJournal()?.phase,
      'http 가 넘어갔는데 "다 실패했다" 고 적었다',
    ).toBe('partial_exhausted');
  });
});

describe('포기한 세대를 복구가 다시 게시하지 않는다 (22차 R4)', () => {
  /**
   * `abortConfig` 는 직렬 쓰기 넷이다 — abort×평면 · releaseHolderSlots ·
   * finishOperation · **closeJournal**. 마지막 직전에 죽으면 `terminal='aborted'` 인데
   * 저널은 비종단으로 남는다.
   *
   * 그 상태에서 복구가 돌면 **포기한 세대를 게시한다.** 러너의 게시 경로가 자기 전환의
   * `terminal` 기록을 안 보기 때문이다 — 그 검사는 `stage`/`commit` 의 `admit` 에서야
   * 나온다. HUP 까지는 안 가고 수렴이 덮지만, **되돌릴 수 없는 연산이 나간 것은 사실이다.**
   */
  it('terminal 로 닫힌 전환은 복구가 게시하지 않는다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const a = OP('A', 'gen-A', '0', '1');
    await agent.reserveAll(a, { op: a, phase: 'preflight', reloadAttempts: 0, progress: {} });
    for (const plane of ['http', 'stream'] as const) await agent.abort(tupleFor(a, plane));
    await agent.releaseHolderSlots(a);
    await agent.finishOperation(a, ['http', 'stream']);

    const fx = new FakeEffects();
    await LocalDataplaneDriver.create({ store, effects: fx }).recoverConfig().catch(() => undefined);

    expect(fx.publishCalls, '포기한 세대를 게시했다').toBe(0);
    expect(fx.reloadSignals, '포기한 세대로 HUP 을 보냈다').toBe(0);
  });
});

describe('전부 넘어갔으면 부분이 아니다 (22차 R2)', () => {
  /**
   * `moved.length > 0` 만 보면 **전 평면이 커밋된 전환도** `partial_exhausted` 로 닫혀
   * `partialTransition=true` 가 된다. 좌표는 참인데 라벨만 거짓이다.
   *
   * §3.4 계열의 **세 번째 재발**이다 — 13차 ③(`failAll`) · 21차 CE-C(`abortConfig`) ·
   * 이번. 매번 "넘어간 평면을 무시하고 한 덩어리로 적는" 같은 모양이었다.
   */
  it('전 평면이 넘어간 뒤 abort 하면 activated 로 닫힌다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const a = OP('A', 'gen-A', '0', '1');

    await agent.reserveAll(a, { op: a, phase: 'preflight', reloadAttempts: 0, progress: {} });
    for (const plane of ['http', 'stream'] as const) {
      await agent.stage(tupleFor(a, plane), null);
      await agent.commit(tupleFor(a, plane), { acceptingGeneration: 'gen-A' });
    }
    await agent.writeJournal({
      op: a, phase: 'reload_observed', reloadAttempts: 1,
      seq: (agent.readJournal()?.seq ?? 0) + 1,
      progress: { http: 'committed', stream: 'committed' },
    });

    await LocalDataplaneDriver.create({ store, effects: new FakeEffects() })
      .abortConfig(a).catch(() => undefined);

    expect(
      new DpAgent(store).readJournal()?.phase,
      '전 평면이 넘어갔는데 "부분" 이라고 적었다',
    ).toBe('activated');
  });
});

describe('부분 봉투가 전체 저널을 닫는다 (23차 CE-A)', () => {
  /**
   * **22차 R2 가 만든 회귀다 — §3.4 계열의 네 번째 재발.**
   *
   * R2 는 `moved.length === all` 이면 `activated` 로 닫게 했다. 그런데 `all` 을
   * **호출자가 넘긴 봉투**(`planesOf(op)`)에서 세었다. 봉투가 한 평면만 담고 있으면
   * `all === 1` 이라, 다른 평면이 옛 세대에 남아 있어도 "전부 넘어갔다" 가 된다.
   *
   * 부분 봉투는 오용이 아니다 — 바로 위 `releaseHolderSlots` 의 주석이 12차 반례 ④ 를
   * 두고 **"넘어온 op 가 한 평면만 담고 있으면"** 이라고 적어 실전 입력으로 취급한다.
   * 그리고 저널을 닫을 자격(`ownsJournal`)은 id 와 토큰만 본다 — **평면은 안 본다.**
   * 그래서 좁은 봉투가 넓은 저널을 닫는다.
   *
   * 세는 모수는 **저널의 op** 여야 한다. 저널은 실행권 아래서 쓰였으니 호출자가 준
   * 것이 아니고, 그것이 이 전환의 진짜 크기다 — 17차가 `pendingEpochs` 를 저널에서
   * 가져오기로 한 것과 같은 근거다.
   */
  it('한 평면만 담은 봉투로 abort 해도 남은 평면을 "넘어갔다" 고 적지 않는다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const a = OP('A', 'gen-A', '0', '1');
    /** 같은 전환인데 http 만 담았다 — id · 전환 · 토큰이 같으므로 저널의 주인이다. */
    const half: ApplyOperation = { ...a, affectedPlanes: ['http'] };

    await agent.reserveAll(a, { op: a, phase: 'preflight', reloadAttempts: 0, progress: {} });
    await agent.stage(tupleFor(a, 'http'), null);
    await agent.commit(tupleFor(a, 'http'), { acceptingGeneration: 'gen-A' });
    await agent.stage(tupleFor(a, 'stream'), null);
    await agent.writeJournal({
      op: a, phase: 'reload_observed', reloadAttempts: 1,
      seq: (agent.readJournal()?.seq ?? 0) + 1,
      progress: { http: 'committed', stream: 'staged' },
    });

    await LocalDataplaneDriver.create({ store, effects: new FakeEffects() })
      .abortConfig(half).catch(() => undefined);

    const after = new DpAgent(store);
    expect(after.coordinate('stream').activationEpoch, '전제가 틀렸다').toBe('0');
    expect(
      after.readJournal()?.phase,
      'stream 은 옛 세대인데 "전부 넘어갔다" 고 적었다',
    ).toBe('partial_exhausted');
  });
});

describe('포기는 절반만 적혀 있어도 포기다 (23차 CE-B)', () => {
  /**
   * **R4 는 창의 절반만 닫았다.**
   *
   * R4 의 `closed` 는 **전 평면**이 `aborted|failed` 일 것을 요구한다. 그런데
   * `abortConfig` 의 abort 는 평면마다 따로 도는 직렬 쓰기라, 루프 **도중**에 죽으면
   * `{http:'aborted'}` 하나만 남는다. 혼합 종단은 `every` 를 통과하지 못하므로 복구가
   * 그냥 지나가고, **포기한 세대를 게시하고 HUP 까지 보낸 뒤 남은 평면을 마저 커밋한다.**
   *
   * `aborted` 를 쓰는 자리는 둘뿐이다 — 운영자의 `abortConfig`, 그리고 `reserveAll` 의
   * 고아 청소(이건 전 평면을 한 쓰기에 적고 곧바로 supersede 한다). 그래서 **평면 하나에
   * `aborted` 가 보이면 이 전환은 포기된 것**이다. `failed` 는 다르다 — 정상 apply 의
   * `failAll` 이 평면별로 남기므로 하나만으로는 아무 뜻이 아니다.
   */
  it('평면 하나만 aborted 여도 복구가 그 세대를 게시하지 않는다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const a = OP('A', 'gen-A', '0', '1');
    await agent.reserveAll(a, {
      op: a, phase: 'published', reloadAttempts: 0,
      progress: { http: 'staged', stream: 'staged' },
    });
    // abort 루프가 http 까지만 durable 하고 죽었다.
    await agent.abort(tupleFor(a, 'http'));

    const fx = new FakeEffects();
    await LocalDataplaneDriver.create({ store, effects: fx }).recoverConfig().catch(() => undefined);

    const after = new DpAgent(store);
    expect(fx.reloadSignals, '포기한 세대로 HUP 을 보냈다').toBe(0);
    expect(after.coordinate('stream').activationEpoch, '포기한 전환을 마저 커밋했다').toBe('0');
  });
});

describe('닫는 자리가 셋인데 둘만 모았다 (24차 CE-24-A)', () => {
  /**
   * **23차 CE-B 수정이 만든 회귀 — §3.4 계열의 다섯 번째 재발.**
   *
   * 22차까지 `closed` 는 `every` 였다. 그래서 참이면 `activated` 평면이 있을 수 **없었고**,
   * 그 분기의 `closeJournal(j.op, 'failed')` 하드코딩은 **항상 참말**이었다.
   *
   * 23차가 CE-B 를 고치며 `includes('aborted')` 를 넣어 혼합 종단을 이 분기로 끌어들였다.
   * 전제가 깨졌는데 하드코딩은 그대로 남았다 — `[activated, aborted]` 가 "다 실패했다" 로
   * 적힌다. 21차 CE-C 가 `abortConfig` 에서 고친 바로 그 거짓말이다.
   *
   * **23차는 자기 규칙을 두 자리에만 적용했다.** 종단을 적는 자리는 셋이다 —
   * `failAll` · `abortConfig` · 그리고 여기. `reachedPhase()` 를 만들어 놓고
   * 정작 자기가 손댄 세 번째 자리를 안 고쳤다.
   */
  it('부분 활성화 위에서 abort 가 끊겨도 "다 실패했다" 고 적지 않는다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const a = OP('A', 'gen-A', '0', '1');

    await agent.reserveAll(a, { op: a, phase: 'preflight', reloadAttempts: 0, progress: {} });
    await agent.stage(tupleFor(a, 'http'), null);
    await agent.commit(tupleFor(a, 'http'), { acceptingGeneration: 'gen-A' });
    await agent.stage(tupleFor(a, 'stream'), null);
    await agent.writeJournal({
      op: a, phase: 'partially_activated', reloadAttempts: 1,
      seq: (agent.readJournal()?.seq ?? 0) + 1,
      progress: { http: 'committed', stream: 'staged' },
    });
    // abortConfig 가 http 는 이미 activated 라 거부당하고, stream 만 찍은 채 끊겼다.
    await agent.abort(tupleFor(a, 'stream'));

    const r = await LocalDataplaneDriver.create({ store, effects: new FakeEffects() })
      .recoverConfig();

    expect(new DpAgent(store).coordinate('http').activationEpoch, '전제가 틀렸다').toBe('1');
    expect(r.phase, 'http 가 서비스 중인데 "다 실패했다" 고 적었다').toBe('partial_exhausted');
    expect(r.partialTransition, '부분 전환을 부분이 아니라고 답했다').toBe(true);
  });
});

describe('한 걸음도 못 나갈 때 끝내는 자리 (24차 — 생존 뮤턴트를 죽인다)', () => {
  /**
   * 23차 스윕에서 `await this.failAll(...)` 을 **통째로 지워도 살아남았다.** 즉 그 줄을
   * 걷는 테스트가 하나도 없었다. 분류를 미뤄 뒀는데 24차가 **길을 찾았다** — 17차에
   * "도달 불가" 로 결론냈다가 뒤집힌 그 교훈이 또 맞았다.
   *
   * 모양은 이렇다. 남이 같은 (평면, epoch) 를 점유해 양 평면 stage 가 `slot_taken` 으로
   * 막힌다. 이건 **종단이 아니라서** 위의 `closed` 분기가 안 잡고, 아무 평면도 못
   * 나가므로 `advanced === 0` 이다. 그 자리에서 `failAll` 이 유일한 출구다.
   *
   * 지우면 `published` 에서 무한히 돈다 — HARD_LIMIT 예외로 튀어나오고 **실행권이 남아
   * 다음 오퍼레이션이 영구히 막힌다.** 등급으로 치면 상(上)이 될 자리였고, 그것을
   * 스윕이 "검사되지 않은 행동" 으로 정확히 짚었다.
   */
  it('양 평면이 남에게 막히면 실패로 닫고 실행권을 놓는다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const a = OP('A', 'gen-A', '0', '1');
    const b = OP('B', 'gen-B', '0', '1');

    await agent.reserveAll(a, {
      op: a, phase: 'published', reloadAttempts: 0,
      progress: { http: 'staged', stream: 'staged' },
    });
    // A 의 슬롯만 사라지고 저널은 남았다 — 그 위를 B 가 점유한다.
    for (const plane of ['http', 'stream'] as const) {
      await agent.release(tupleFor(a, plane));
      await agent.reserve(tupleFor(b, plane));
    }

    const r = await LocalDataplaneDriver.create({ store, effects: new FakeEffects() })
      .recoverConfig();

    expect(r.phase, '한 걸음도 못 나갔는데 닫지 않았다').toBe('failed');
    expect(
      new DpAgent(store).activeOperation(),
      '실행권이 남아 다음 오퍼레이션이 막힌다',
    ).toBeUndefined();
  });
});

describe('남이 옮긴 좌표를 내 공로로 적지 않는다 (25차 CE-25-A)', () => {
  /**
   * **24차 수정이 만든 회귀다 — 전제를 바꾸고 그 전제에 기대던 것을 안 고쳤다.**
   *
   * 22차까지 이 자리는 `'failed'` 하드코딩이었고 그게 **참말**이었다. 24차가 그것을
   * `reachedPhase()` 라는 **규칙**으로 바꿨는데, 그 규칙은 "좌표 epoch == 내 목표 epoch"
   * 동일성만 본다 — `payloadDigest` 를 안 본다.
   *
   * 그래서 내 전환이 **전부 포기**됐는데 남이 같은 epoch 을 **다른 payload** 로 점유해
   * 커밋하면, 내 저널이 `activated` 로 닫힌다. 참말이던 하드코딩이 거짓이 될 수 있는
   * 규칙으로 바뀐 것이다.
   *
   * epoch 은 좌표의 **번지**이고 digest 는 **거기 있는 것**이다. "내가 옮겼다" 를
   * 번지만으로 판정하면 남이 같은 번지에 다른 것을 놓은 경우를 못 가른다.
   */
  it('전부 포기한 전환은 남이 같은 epoch 을 채워도 failed 로 닫힌다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const a = OP('A', 'gen-A', '0', '1');
    const b = OP('B', 'gen-B', '0', '1');

    await agent.reserveAll(a, {
      op: a, phase: 'published', reloadAttempts: 0,
      progress: { http: 'staged', stream: 'staged' },
    });
    for (const plane of ['http', 'stream'] as const) await agent.abort(tupleFor(a, plane));
    // B 가 같은 좌표를 자기 payload 로 채운다 — A 는 한 걸음도 못 갔다.
    for (const plane of ['http', 'stream'] as const) {
      await agent.reserve(tupleFor(b, plane));
      await agent.stage(tupleFor(b, plane), null);
      await agent.commit(tupleFor(b, plane), { acceptingGeneration: 'gen-B' });
    }

    const r = await LocalDataplaneDriver.create({ store, effects: new FakeEffects() })
      .recoverConfig();

    expect(new DpAgent(store).coordinate('http').activationEpoch, '전제가 틀렸다').toBe('1');
    expect(r.phase, 'A 는 전부 포기했는데 남이 옮긴 것을 자기 공로로 적었다').toBe('failed');
  });
});

describe('닮음으로는 부류가 안 닫힌다 (26차 CE-26-A · CE-26-B)', () => {
  /**
   * **25차 수정이 만든 모순 — §3.4 여섯 번째 재발.**
   *
   * 25차는 digest 조임을 `reachedPhase()` 에만 넣고 **`failAll` 의 평면별 `moved`
   * 판정에는 안 넣었다.** 그래서 한 `ApplyResult` 안에서 phase 는 "다 실패했다"(digest 를
   * 보므로 참) 인데 progress 는 "다 커밋됐다"(epoch 만 보므로 거짓) 가 된다.
   *
   * 25차 이전에는 **일관되게 틀렸고**(둘 다 남의 것을 내 공로로), 25차가 한쪽만 고쳐
   * **모순**을 만들었다. 25차가 스스로 진단한 병형("규칙을 세우고 일부 자리에만 적용")을
   * 그 규칙을 쓴 커밋에서 또 저지른 것이다.
   */
  it('phase 와 progress 가 같은 기준으로 판정된다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const a = OP('A', 'gen-A', '0', '1');
    const b = OP('B', 'gen-B', '0', '1');

    await agent.reserveAll(a, {
      op: a, phase: 'reload_intent', reloadAttempts: 2,
      progress: { http: 'staged', stream: 'staged' },
    });
    for (const plane of ['http', 'stream'] as const) {
      await agent.release(tupleFor(a, plane));
      await agent.reserve(tupleFor(b, plane));
      await agent.stage(tupleFor(b, plane), null);
      await agent.commit(tupleFor(b, plane), { acceptingGeneration: 'gen-B' });
    }

    const r = await LocalDataplaneDriver.create({ store, effects: new FakeEffects() })
      .recoverConfig();

    expect(r.phase, '전제가 틀렸다').toBe('failed');
    expect(
      r.progress?.http,
      'phase 는 "다 실패" 인데 progress 는 "커밋됐다" 고 적었다 — 한 결과 안에서 모순이다',
    ).toBe('failed');
  });

  /**
   * **닮음의 기준을 아무리 얹어도 남는 구멍.**
   *
   * 남이 **같은 내용**(같은 payloadDigest)으로 같은 epoch 을 채우면 digest 를 봐도 못
   * 가른다. 그리고 같은 설정의 재시도는 운영에서 가장 흔한 패턴이다 — 좁은 구멍이 아니다.
   *
   * 이것이 "인스턴스를 여섯 번 닫아도 일곱 번째가 있다" 의 실물이고, **좌표가 누가
   * 놨는지 기억해야** 닫힌다는 근거다.
   */
  it('남이 같은 내용으로 같은 좌표를 채워도 내 공로가 아니다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const a = OP('A', 'gen-A', '0', '1');
    // 같은 설정의 재시도 — 내용이 A 와 똑같다.
    const b: ApplyOperation = {
      ...OP('B', 'gen-A', '0', '1'),
      planes: a.planes,
    };

    await agent.reserveAll(a, {
      op: a, phase: 'published', reloadAttempts: 0,
      progress: { http: 'staged', stream: 'staged' },
    });
    for (const plane of ['http', 'stream'] as const) await agent.abort(tupleFor(a, plane));
    for (const plane of ['http', 'stream'] as const) {
      await agent.reserve(tupleFor(b, plane));
      await agent.stage(tupleFor(b, plane), null);
      await agent.commit(tupleFor(b, plane), { acceptingGeneration: 'gen-A' });
    }

    const r = await LocalDataplaneDriver.create({ store, effects: new FakeEffects() })
      .recoverConfig();

    expect(r.phase, 'A 는 전부 포기했는데 남의 같은-내용 커밋을 자기 공로로 적었다')
      .toBe('failed');
  });
});

describe('일곱 번째 층 — 후보 승격도 닮음이었다 (27차 CE-27)', () => {
  /**
   * **26차에 "부류를 닫았다" 고 적은 것은 거짓이었다.**
   *
   * 좌표에 서명을 붙이고 `reachedPhase` · `failAll` · commit 재요청을 서명으로 바꿨는데,
   * **"내가 놓았는가" 를 묻는 자리가 둘 더 있었다.** `finalizeCandidate` 의 `arrived` 는
   * 좌표 epoch 만 보고(`s.planes[plane].activationEpoch === epoch`), 완결의 뜻
   * (`pendingEpochs`)은 **후보 신원에 결속돼 있지 않다.**
   *
   * 그래서 내가 http 만 옮기고 stream 을 포기한 뒤 남이 stream 을 옮기면, **혼합 저자
   * 부분 활성화가 전체 활성화 기준으로 승격된다.** 그 뒤 수렴은 그 세대를 정답으로 게시한다.
   *
   * 23·25차가 두 번 진단한 병형("규칙을 세우고 일부 자리에만 적용")의 세 번째 발병이고,
   * 이번엔 26차의 나 자신이다. 규칙을 만들 때 **자리를 세는 것**이 규칙을 만드는 일의
   * 절반이다.
   */
  it('혼합 저자 부분 활성화는 기준으로 승격되지 않는다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const x = OP('X', 'gen-X', '0', '1');
    const y: ApplyOperation = { ...OP('Y', 'gen-Y', '0', '1'), affectedPlanes: ['stream'] };

    await agent.reserveAll(x, { op: x, phase: 'preflight', reloadAttempts: 0, progress: {} });
    await agent.stage(tupleFor(x, 'http'), null);
    await agent.commit(tupleFor(x, 'http'), { acceptingGeneration: 'gen-X' });
    await agent.abort(tupleFor(x, 'stream'));

    await agent.reserve(tupleFor(y, 'stream'));
    await agent.stage(tupleFor(y, 'stream'), null);
    await agent.commit(tupleFor(y, 'stream'), { acceptingGeneration: 'gen-Y' });
    await agent.finishOperation(y, ['stream']);

    const after = new DpAgent(store);
    expect(after.coordinate('http').activationEpoch, '전제가 틀렸다').toBe('1');
    expect(
      after.lastActivated()?.generation,
      'http 는 X 가 놓았는데 Y 의 부분 활성화가 전체 기준으로 승격됐다',
    ).toBeUndefined();
  });
});

describe('26차 수정이 되돌아가면 빨개진다 (27차 — 회귀 감지가 0 이었다)', () => {
  /**
   * 27차가 실측으로 짚었다: 26차가 **재현까지 해서 고친** 두 자리를 통째로 되돌려도
   * 전 스위트가 초록이었다. 즉 고정 테스트가 없었다.
   *
   * 17차 교훈("재현 경로 없는 수정은 다음 회차에 조용히 되돌아온다")이 **그 교훈을
   * 인용한 커밋 자신**에 걸려 있었다. 반례를 재현했다는 것과 그 수정을 지킨다는 것은
   * 다른 일이다.
   */
  it('failAll 의 평면 판정이 닮음으로 돌아가면 progress 가 거짓이 된다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const a = OP('A', 'gen-A', '0', '1');
    // **같은 내용**으로 재점유한다 — epoch 도 digest 도 같아서 닮음으로는 못 가른다.
    const b: ApplyOperation = { ...OP('B', 'gen-A', '0', '1'), planes: a.planes };

    await agent.reserveAll(a, {
      op: a, phase: 'reload_intent', reloadAttempts: 2,
      progress: { http: 'staged', stream: 'staged' },
    });
    for (const plane of ['http', 'stream'] as const) {
      await agent.release(tupleFor(a, plane));
      await agent.reserve(tupleFor(b, plane));
      await agent.stage(tupleFor(b, plane), null);
      await agent.commit(tupleFor(b, plane), { acceptingGeneration: 'gen-A' });
    }

    const r = await LocalDataplaneDriver.create({ store, effects: new FakeEffects() })
      .recoverConfig();

    expect(r.progress?.http, 'A 는 아무것도 안 했는데 커밋됐다고 적었다').toBe('failed');
    expect(r.progress?.stream, 'A 는 아무것도 안 했는데 커밋됐다고 적었다').toBe('failed');
  });

  it('남이 채운 좌표에 내 지연된 commit 이 도착하면 거부된다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const a = OP('A', 'gen-A', '0', '1');
    const b: ApplyOperation = { ...OP('B', 'gen-A', '0', '1'), planes: a.planes };

    await agent.reserveAll(a, { op: a, phase: 'preflight', reloadAttempts: 0, progress: {} });
    await agent.stage(tupleFor(a, 'http'), null);
    // A 가 부작용 전에 물러섰다 — 슬롯과 멱등 기록이 사라진다.
    await agent.release(tupleFor(a, 'http'));
    // B 가 같은 좌표를 같은 내용으로 채운다.
    await agent.reserve(tupleFor(b, 'http'));
    await agent.stage(tupleFor(b, 'http'), null);
    await agent.commit(tupleFor(b, 'http'), { acceptingGeneration: 'gen-A' });

    // A 의 지연된 commit 이 이제 도착한다. **아무것도 안 했는데 성공을 받으면 안 된다.**
    const outcome = await agent.commit(tupleFor(a, 'http'), { acceptingGeneration: 'gen-A' })
      .then(() => 'ok' as const)
      .catch((e: unknown) => (e instanceof DpRejection ? e.kind : 'other'));

    expect(outcome, '남이 옮긴 좌표를 보고 내가 커밋했다고 답했다').not.toBe('ok');
  });
});

describe('서명 없는 좌표가 영구 봉쇄를 만든다 (28차 CE-28)', () => {
  /**
   * **27차 수정이 만든 스물한 번째다.**
   *
   * 26차에 `by?` 를 옵셔널로 두며 그 대가를 이렇게 적었다 — *"구버전에서 이월된 열린
   * 저널이 종단에서 **비관적으로 `failed` 로 판정**될 수 있는 1 회성 창"*.
   * **그 가격표가 거짓이었다.** 27차가 `arrived` 에 서명 대조를 넣으면서, 서명 없는
   * 좌표에서는 `arrived` 가 무조건 거짓이 됐다. 그러면 후보가 승격 없이 지워지는데,
   * 저널은 `activated` 라 **I6(b)("활성화는 기준을 남긴다")가 발화한다.**
   *
   * `assertInvariants` 는 저장 앞에서 던지므로 **아무것도 안 써지고 매 호출 같은 자리에서
   * 죽는다** — `recoverConfig` 도, `fence` 도(승계 불능), `abortConfig` 도(운영자 포기
   * 경로까지). 비관 판정이 아니라 **영구 봉쇄**다.
   *
   * 두 기록이 서로 반대를 말하는 상황이다 — 저널은 "활성화했다", 좌표는 "누가 놨는지
   * 모른다". 그때 던져서 멈추는 것은 답이 아니다. **판정을 못 하면 비관적으로 닫고
   * 앞으로 가야 한다** — 26차가 약속한 그대로.
   */
  it('서명 없는 좌표에서도 복구가 앞으로 간다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const a = OP('A', 'gen-A', '0', '1');

    await agent.reserveAll(a, {
      op: a, phase: 'reload_observed', reloadAttempts: 1,
      progress: { http: 'staged', stream: 'staged' },
    });
    for (const plane of ['http', 'stream'] as const) {
      await agent.stage(tupleFor(a, plane), null);
      await agent.commit(tupleFor(a, plane), { acceptingGeneration: 'gen-A' });
    }
    await agent.writeJournal({
      op: a, phase: 'activated', reloadAttempts: 1,
      seq: (agent.readJournal()?.seq ?? 0) + 1,
      progress: { http: 'committed', stream: 'committed' },
    });
    // 26차 이전 writer 가 남긴 상태를 흉내낸다 — 좌표에 서명이 없다.
    const raw = store.load()!;
    const payload = raw.payload as { planes: Record<string, { by?: unknown }> };
    for (const plane of Object.keys(payload.planes)) delete payload.planes[plane]!.by;
    await store.save({ ...raw, version: raw.version + 1, payload });

    const driver = LocalDataplaneDriver.create({ store, effects: new FakeEffects() });
    const outcome = await driver.recoverConfig()
      .then((r) => r.phase)
      .catch((e: unknown) => `던졌다: ${(e as Error).name}`);

    expect(outcome, '복구가 던져서 아무것도 못 쓴다 — 영구 봉쇄다').not.toMatch(/던졌다/);
    // 그리고 승계도 막히면 안 된다 — 신임 리더가 들어올 길이 있어야 한다.
    const fenced = await new DpAgent(store).fence('11')
      .then(() => 'ok')
      .catch((e: unknown) => `던졌다: ${(e as Error).name}`);
    expect(fenced, '신임 리더도 못 들어온다').toBe('ok');
  });

  /**
   * **가격표를 겨눈다** (29차 지적).
   *
   * 위 테스트는 "던지지 않는다 · fence 가 된다" 만 봤다. **약속한 것이 실제로 무엇인지 —
   * 판정이 무엇으로 닫히고 기준이 어디로 가는지 — 를 안 봤다.** 그 미검사 구간에서
   * CE-29(세상 되감김)가 나왔다. 가격표를 세 번 틀렸는데 세 번 다 가격표를 겨눈 단언이
   * 없었다.
   */
  it('서명 없는 좌표에서도 기준이 제대로 올라간다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const a = OP('A', 'gen-A', '0', '1');

    await agent.reserveAll(a, {
      op: a, phase: 'reload_observed', reloadAttempts: 1,
      progress: { http: 'staged', stream: 'staged' },
    });
    for (const plane of ['http', 'stream'] as const) {
      await agent.stage(tupleFor(a, plane), null);
      await agent.commit(tupleFor(a, plane), { acceptingGeneration: 'gen-A' });
    }
    await agent.writeJournal({
      op: a, phase: 'activated', reloadAttempts: 1,
      seq: (agent.readJournal()?.seq ?? 0) + 1,
      progress: { http: 'committed', stream: 'committed' },
    });
    const raw = store.load()!;
    const payload = raw.payload as { planes: Record<string, { by?: unknown }> };
    for (const plane of Object.keys(payload.planes)) delete payload.planes[plane]!.by;
    await store.save({ ...raw, version: raw.version + 1, payload });

    await LocalDataplaneDriver.create({ store, effects: new FakeEffects() }).recoverConfig();

    expect(
      new DpAgent(store).lastActivated()?.generation,
      '활성화가 끝난 세대인데 기준으로 안 올랐다 — 수렴이 옛 기준을 정답으로 삼는다',
    ).toBe('gen-A');
  });
});

describe('서명 비교의 세 축이 전부 일한다 (28차 — 넷이 미검사였다)', () => {
  /**
   * 26차에 `authoredBy` 를 만들며 **"`ownsJournal` 과 같은 삼중 비교다 — id 만으로는
   * fence 뒤 같은 id 재사용을 못 가른다"** 고 적었다. 그런데 28차에 각 절을 뮤테이션해
   * 보니 **넷 다 살았다** — `transitionId` 도, `leaderToken` 도, epoch 절도, 정규화도
   * 아무 테스트가 안 겨눴다. 실제로 일하고 있던 것은 `operationId` 하나뿐이었다.
   *
   * 이번 회차의 병("적었으니 됐다")이 **서명 비교 자신**에도 있었다. 근거를 적는 것이
   * 검사를 대체하면, 세 축 중 둘이 장식이어도 아무도 모른다.
   *
   * 그래서 비교를 **직접** 겨눈다. 저널·실행권을 거쳐 가면 그 기계들이 먼저 막아
   * 정작 비교가 일하는지 못 본다 — 15차에 배운 "픽스처가 통과시킨 것" 과 같은 함정이다.
   */
  const withCommitted = async (): Promise<{ store: MemoryStore; op: ApplyOperation }> => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const op = OP('A', 'gen-A', '0', '1');
    await agent.reserveAll(op, { op, phase: 'preflight', reloadAttempts: 0, progress: {} });
    for (const plane of ['http', 'stream'] as const) {
      await agent.stage(tupleFor(op, plane), null);
      await agent.commit(tupleFor(op, plane), { acceptingGeneration: 'gen-A' });
    }
    return { store, op };
  };

  it('operationId 가 같아도 transitionId 가 다르면 내 것이 아니다', async () => {
    const { store, op } = await withCommitted();
    const retry: ApplyOperation = { ...op, transitionId: 'A-t2' };
    expect(
      new DpAgent(store).movedByMe(retry, 'http'),
      '앞 전환이 놓은 좌표를 이번 전환의 공로로 셌다',
    ).toBe(false);
  });

  it('fence 뒤 같은 id 를 다시 내면 옛 토큰의 좌표는 내 것이 아니다', async () => {
    const { store, op } = await withCommitted();
    const reissued: ApplyOperation = { ...op, leaderToken: '11' };
    expect(
      new DpAgent(store).movedByMe(reissued, 'http'),
      '옛 리더가 놓은 좌표를 신임의 공로로 셌다 — 삼중 비교의 세 번째 축이다',
    ).toBe(false);
  });

  it('서명이 맞아도 좌표가 다른 epoch 이면 도착이 아니다', async () => {
    const { store, op } = await withCommitted();
    const ahead: ApplyOperation = {
      ...op,
      planes: {
        http: {
          payloadDigest: op.planes.http!.payloadDigest,
          expectedCurrent: { activationEpoch: '1', membershipRevision: '1' },
          target: { activationEpoch: '2', membershipRevision: '2' },
        },
        stream: op.planes.stream!,
      },
    };
    expect(
      new DpAgent(store).movedByMe(ahead, 'http'),
      '서명만 보고 좌표를 안 봤다 — 아직 안 간 곳을 갔다고 셌다',
    ).toBe(false);
  });

  it('토큰 표기가 달라도 같은 토큰이면 내 것이다', async () => {
    const { store, op } = await withCommitted();
    // `'010'` 과 `'10'` 은 같은 토큰이다 (6차 반례 ⑦ 의 정규화). 정규화를 빼면 **거짓
    // 음성**이 난다 — 내가 놓은 것을 남의 것으로 읽고 비관적으로 닫는다.
    const padded: ApplyOperation = { ...op, leaderToken: '010' };
    expect(
      new DpAgent(store).movedByMe(padded, 'http'),
      '표기만 다른 같은 토큰을 남의 것으로 읽었다',
    ).toBe(true);
  });
});

describe('면제가 세상을 되감는 길을 열었다 (29차 CE-29)', () => {
  /**
   * **28차 수정이 만든 스물두 번째다 — 그리고 이번엔 상(上)이다.**
   *
   * 27차 수정은 서명 없는 좌표에서 **봉쇄**를 만들었다(CE-28). 28차가 I6(b) 면제로 그
   * 봉쇄를 풀었다 — "판정을 못 하면 비관적으로 두고 앞으로 간다" 는 근거였다.
   *
   * **그 "앞으로" 가 문제였다.** 기준을 안 올린 채 통과하면, 저널·terminal·좌표가 전부
   * "gen-B 가 활성화됐다" 고 말하는데 기준만 gen-A 다. 그리고 수렴은 **기준을 정답으로
   * 삼는다** — 실제로 서빙 중인 gen-B 를 gen-A 로 **되감고** `repaired` 라고 답한다.
   * 게시와 HUP 이 실제로 나간다. 되돌릴 수 없는 연산이다.
   *
   * 가격표가 세 번째로 틀렸다.
   * ```
   * 26차  "비관적으로 failed 로 판정"     실제: 영구 봉쇄
   * 28차  "비관적으로 두고 앞으로 간다"   실제: activated 로 답하고 세상을 되감는다
   * ```
   *
   * **판정을 못 한다고 적어 놓고, 판정이 필요한 자리를 그냥 통과시킨 것이 병이다.**
   * 서명이 없어도 신원 있는 증거는 있다 — `terminal` 원장은 키가
   * `operationId:transitionId:plane` 이다. 닮음이 아니라 신원이다.
   */
  it('서명 없는 좌표라도 신원 있는 증거가 있으면 기준을 올린다', async () => {
    const store = new MemoryStore();
    const fx = new FakeEffects();
    // **되감을 옛 기준이 있어야 한다.** gen-A 를 정상으로 세운다.
    await LocalDataplaneDriver.create({ store, effects: fx })
      .applyConfig(OP('A', 'gen-A', '0', '1'));

    const agent = new DpAgent(store);
    const b = OP('B', 'gen-B', '1', '2');

    await agent.reserveAll(b, {
      op: b, phase: 'published', reloadAttempts: 0,
      progress: { http: 'staged', stream: 'staged' },
    });
    for (const plane of ['http', 'stream'] as const) {
      await agent.stage(tupleFor(b, plane), null);
      await agent.commit(tupleFor(b, plane), { acceptingGeneration: 'gen-B' });
    }
    await agent.writeJournal({
      op: b, phase: 'activated', reloadAttempts: 1,
      seq: (agent.readJournal()?.seq ?? 0) + 1,
      progress: { http: 'committed', stream: 'committed' },
    });
    // 구버전 writer 가 남긴 모양 — 좌표에 서명이 없다.
    const raw = store.load()!;
    const payload = raw.payload as { planes: Record<string, { by?: unknown }> };
    for (const plane of Object.keys(payload.planes)) delete payload.planes[plane]!.by;
    await store.save({ ...raw, version: raw.version + 1, payload });

    // 세상은 이미 gen-B 다 — 게시도 HUP 도 나갔다.
    fx.publishedRecord = {
      generation: 'gen-B', leaderToken: '10', operationId: 'B',
      transitionId: 'B', generationDigest: 'sha256:gen-B',
    };
    fx.acceptingGeneration = 'gen-B';

    const driver = LocalDataplaneDriver.create({ store, effects: fx });
    await driver.recoverConfig();
    const before = { publishes: fx.publishCalls, reloads: fx.reloadSignals };
    await driver.reconcileConfig();

    expect(fx.publishCalls, '수렴이 실제 활성화를 되감으려고 다시 게시했다')
      .toBe(before.publishes);
    expect(fx.reloadSignals, '되감기 HUP 이 나갔다').toBe(before.reloads);
    expect(fx.acceptingGeneration, '서빙 중인 세대가 되감겼다').toBe('gen-B');
  });
});

describe('원장 폴백은 창의 부분집합만 닫았다 (30차 CE-30)', () => {
  /**
   * **29차 수정이 만든 스물세 번째다. 봉쇄가 돌아왔다.**
   *
   * 29차의 논증은 *"이제 `finalizeCandidate` 가 `terminal` 원장으로 제대로 승격하므로
   * 그 상태 자체가 안 생긴다"* 였다. **이 전칭 명제가 거짓이다.** 원장 폴백이 승격하는
   * 것은 **후보가 모든 평면을 자기 전환 키로 활성화한** 경우뿐이고, 29차가 넣은 테스트
   * 둘이 정확히 그 부분집합만 만든다. **검증한 부분집합에서 전체 창으로 조용히
   * 일반화했다** — 이 시리즈가 다섯 회차째 반복하는 병이다.
   *
   * 혼합 저자에서는 폴백이 false 를 답하고, 면제는 뺐으므로 I6(b)가 발화한다.
   *
   * 그리고 30차가 뿌리를 짚었다: **판정이 불능인데 결과 선택지가 승격/폐기 둘뿐이다.**
   * 28차는 폐기를 통과시켰고(→ 되감김), 29차는 일부를 승격으로 옮겼다(→ 나머지가 봉쇄).
   * 같은 창을 양쪽으로 오갔을 뿐이다.
   */
  it('혼합 저자 + 서명 없는 좌표에서도 복구·승계·포기가 앞으로 간다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const x = OP('X', 'gen-X', '0', '1');
    const y: ApplyOperation = {
      ...OP('Y', 'gen-X', '0', '1'), affectedPlanes: ['stream'], planes: x.planes,
    };

    await agent.reserveAll(x, { op: x, phase: 'preflight', reloadAttempts: 0, progress: {} });
    await agent.abort(tupleFor(x, 'stream'));
    // 남이 같은 내용으로 재시도한다 — 26차가 "가장 흔한 패턴" 이라 적은 그것이다.
    await agent.reserve(tupleFor(y, 'stream'));
    await agent.stage(tupleFor(y, 'stream'), null);
    await agent.commit(tupleFor(y, 'stream'), { acceptingGeneration: 'gen-X' });
    await agent.finishOperation(y, ['stream']);

    await agent.stage(tupleFor(x, 'http'), null);
    await agent.commit(tupleFor(x, 'http'), { acceptingGeneration: 'gen-X' });
    await agent.writeJournal({
      op: x, phase: 'activated', reloadAttempts: 1,
      seq: (agent.readJournal()?.seq ?? 0) + 1,
      progress: { http: 'committed', stream: 'committed' },
    });
    const raw = store.load()!;
    const payload = raw.payload as { planes: Record<string, { by?: unknown }> };
    for (const plane of Object.keys(payload.planes)) delete payload.planes[plane]!.by;
    await store.save({ ...raw, version: raw.version + 1, payload });

    const driver = LocalDataplaneDriver.create({ store, effects: new FakeEffects() });
    const recovered = await driver.recoverConfig()
      .then(() => 'ok').catch((e: unknown) => `던졌다: ${(e as Error).name}`);
    expect(recovered, '복구가 던져서 아무것도 못 쓴다').toBe('ok');

    const fenced = await new DpAgent(store).fence('11')
      .then(() => 'ok').catch((e: unknown) => `던졌다: ${(e as Error).name}`);
    expect(fenced, '신임 리더도 못 들어온다').toBe('ok');
  });
});

describe('세 번째 결과를 만들지 않았다 (31차 CE-31)', () => {
  /**
   * **30차 수정이 만든 스물네 번째다. 다섯 회차째 같은 창이다.**
   *
   * 30차는 뿌리를 정확히 적었다 — *"판정이 불능인데 결과 선택지가 승격/폐기 둘뿐이다."*
   * **그리고는 셋째 결과를 만들지 않고 나머지를 폐기 쪽에 배정했다.**
   *
   * 폐기는 낡은 `lastActivated` 를 정답 권위로 남긴다. 좌표·저널·terminal 은 전부
   * "gen-B" 인데 기준만 gen-A 다. 수렴은 기준을 정답으로 삼아 **서빙 중인 gen-B 를
   * gen-A 로 되감고 `repaired` 라 답한다** — CE-29 와 똑같은 되감김이다.
   *
   * ```
   * 27차 봉쇄 → 28차 폐기 통과 → 되감김(전체 창)
   *          → 29차 부분 승격 + 나머지 봉쇄 → 30차 나머지 폐기 통과 → 되감김(나머지 창)
   * ```
   *
   * 그리고 **CE-30 테스트는 "복구·승계가 앞으로 간다" 만 단언하고 앞으로 간 뒤의 세상을
   * 안 봤다.** "봉쇄가 풀렸다" 를 검증하고 "안전하게 풀렸다" 로 조용히 일반화했다 —
   * 29차와 정확히 같은 병형이다.
   */
  it('폐기된 후보 뒤에서 수렴이 세상을 되감지 않는다', async () => {
    const store = new MemoryStore();
    const fx = new FakeEffects();
    await LocalDataplaneDriver.create({ store, effects: fx })
      .applyConfig(OP('A', 'gen-A', '0', '1'));

    const agent = new DpAgent(store);
    const x = OP('X', 'gen-B', '1', '2');
    const y: ApplyOperation = {
      ...OP('Y', 'gen-B', '1', '2'), affectedPlanes: ['stream'], planes: x.planes,
    };

    await agent.reserveAll(x, { op: x, phase: 'preflight', reloadAttempts: 0, progress: {} });
    await agent.abort(tupleFor(x, 'stream'));
    await agent.reserve(tupleFor(y, 'stream'));
    await agent.stage(tupleFor(y, 'stream'), null);
    await agent.commit(tupleFor(y, 'stream'), { acceptingGeneration: 'gen-B' });
    await agent.finishOperation(y, ['stream']);
    await agent.stage(tupleFor(x, 'http'), null);
    await agent.commit(tupleFor(x, 'http'), { acceptingGeneration: 'gen-B' });
    await agent.writeJournal({
      op: x, phase: 'activated', reloadAttempts: 1,
      seq: (agent.readJournal()?.seq ?? 0) + 1,
      progress: { http: 'committed', stream: 'committed' },
    });
    const raw = store.load()!;
    const payload = raw.payload as { planes: Record<string, { by?: unknown }> };
    for (const plane of Object.keys(payload.planes)) delete payload.planes[plane]!.by;
    await store.save({ ...raw, version: raw.version + 1, payload });

    // 세상은 이미 gen-B 를 서빙한다 — 게시도 HUP 도 나갔다.
    fx.publishedRecord = {
      generation: 'gen-B', leaderToken: '10', operationId: 'X',
      transitionId: 'X', generationDigest: 'sha256:gen-B',
    };
    fx.acceptingGeneration = 'gen-B';

    const driver = LocalDataplaneDriver.create({ store, effects: fx });
    await driver.recoverConfig();
    const before = { publishes: fx.publishCalls, reloads: fx.reloadSignals };
    await driver.reconcileConfig();

    expect(fx.publishCalls, '수렴이 옛 기준으로 세상을 되감았다').toBe(before.publishes);
    expect(fx.acceptingGeneration, '서빙 세대가 되감겼다').toBe('gen-B');
  });

  /**
   * **폐위는 좌표가 기준을 지나쳤을 때만이다.**
   *
   * 도착 여부를 안 보고 폐기할 때마다 폐위하면, **정상적인 부분 실패**에서도 기준이
   * 날아간다 — 거기서는 세상이 아직 기준에 있으므로 되돌릴 곳이 바로 그 기준이다.
   * 기준을 지우면 멀쩡히 수렴할 수 있는 상태를 `dirty` 로 만들어 운영자를 부른다.
   *
   * 넓게 만든 뮤턴트가 573 전부 통과하길래(= `positionsReached` 가 미검사였다) 겨눈다.
   * 이 시리즈가 다섯 회차째 앓은 병("검증한 부분집합에서 조용히 일반화")을 이번엔
   * **내 수정 자신에게** 적용해 본 것이다.
   */
  it('세상이 기준에 그대로 있으면 폐위하지 않는다', async () => {
    const store = new MemoryStore();
    const fx = new FakeEffects();
    await LocalDataplaneDriver.create({ store, effects: fx })
      .applyConfig(OP('A', 'gen-A', '0', '1'));

    const agent = new DpAgent(store);
    const b = OP('B', 'gen-B', '1', '2');
    // **후보는 생겼는데 도착은 못 했다** — http 만 넘어가고 stream 은 기준에 남았다.
    // (커밋이 하나도 없으면 후보 자체가 안 생겨 이 분기를 아예 안 지나간다. 첫 시도가
    // 그렇게 짜여서 뮤턴트를 못 잡았다 — 픽스처가 통과시킨 것이다.)
    await agent.reserveAll(b, { op: b, phase: 'preflight', reloadAttempts: 0, progress: {} });
    for (const plane of ['http', 'stream'] as const) await agent.stage(tupleFor(b, plane), null);
    await agent.commit(tupleFor(b, 'http'), { acceptingGeneration: 'gen-B' });
    await LocalDataplaneDriver.create({ store, effects: fx }).abortConfig(b).catch(() => undefined);

    expect(
      new DpAgent(store).lastActivated()?.generation,
      '되돌릴 곳이 멀쩡히 있는데 기준을 지웠다 — 수렴이 dirty 로 운영자를 부른다',
    ).toBe('gen-A');
  });
});

describe('폐위는 레거시 창의 것이 아니다 (32차 CE-32-A)', () => {
  /**
   * **여섯 회차 동안 쓴 프레이밍이 거짓이었다.**
   *
   * 27~31차 내내 이 창을 *"26차 이전 writer 가 남긴 상태"* 라고 불렀다. 그런데 폐위 절은
   * `by === undefined` 를 **안 본다** — 서명이 온전한 26차 이후 세상에서도 혼합 저자 +
   * 지연 finalize 면 같은 상태가 만들어지고, 폐위가 없으면 **세상 되감김**이다.
   *
   * 즉 31차는 서명 경로의 상(上)급 되감김을 **우연히** 함께 고쳤고, 그것을 겨눈 테스트는
   * 0 개였다. 주석과 커밋이 이 절을 "레거시 창의 셋째 결과" 라고 서술하므로, 다음 회차가
   * 절을 창에 맞춰 **좁히는 순간** 상급 되감김이 전 스위트 초록인 채 돌아온다.
   *
   * **이름을 잘못 붙이면 다음 사람이 그 이름을 믿고 좁힌다.** 그래서 이 테스트는 수정을
   * 지키는 것이 아니라 **이름을 지킨다.**
   */
  it('서명이 온전해도 폐기된 후보 뒤에서 세상을 되감지 않는다', async () => {
    const store = new MemoryStore();
    const fx = new FakeEffects();
    await LocalDataplaneDriver.create({ store, effects: fx })
      .applyConfig(OP('A', 'gen-A', '0', '1'));

    const agent = new DpAgent(store);
    const x = OP('X', 'gen-B', '1', '2');
    const y: ApplyOperation = {
      ...OP('Y', 'gen-B', '1', '2'), affectedPlanes: ['stream'], planes: x.planes,
    };

    await agent.reserveAll(x, { op: x, phase: 'preflight', reloadAttempts: 0, progress: {} });
    await agent.abort(tupleFor(x, 'stream'));
    await agent.reserve(tupleFor(y, 'stream'));
    await agent.stage(tupleFor(y, 'stream'), null);
    await agent.commit(tupleFor(y, 'stream'), { acceptingGeneration: 'gen-B' });
    await agent.finishOperation(y, ['stream']);
    await agent.stage(tupleFor(x, 'http'), null);
    await agent.commit(tupleFor(x, 'http'), { acceptingGeneration: 'gen-B' });
    // **서명은 그대로 둔다** — 수술 없음. 이것이 26차 이후의 평범한 세상이다.

    fx.publishedRecord = {
      generation: 'gen-B', leaderToken: '10', operationId: 'X',
      transitionId: 'X', generationDigest: 'sha256:gen-B',
    };
    fx.acceptingGeneration = 'gen-B';

    const driver = LocalDataplaneDriver.create({ store, effects: fx });
    await driver.abortConfig(x).catch(() => undefined);
    const before = { publishes: fx.publishCalls, reloads: fx.reloadSignals };
    await driver.reconcileConfig();

    expect(fx.publishCalls, '수렴이 옛 기준으로 세상을 되감았다').toBe(before.publishes);
    expect(fx.acceptingGeneration, '서빙 세대가 되감겼다').toBe('gen-B');
  });
});

describe('원장 폴백의 판별 방향 (32차 CE-32-B)', () => {
  /**
   * 폴백의 **긍정 방향**(원장이 내 활성화를 증명하면 승격)은 CE-28 테스트가 지킨다.
   * **판별 방향**(원장이 증명 못 하면 승격하지 않는다)은 검출력 0 이었다 — 조건을
   * `=== 'activated'` 에서 `true` 로 넓혀도 574 전부 초록이었다(32차 실측).
   *
   * 막는 해악은 이렇다: 레거시 상태에서 남이 **다른 세대**로 한 평면을 채웠는데, 폴백이
   * 판별을 안 하면 내 세대가 **전체 활성화 기준**으로 승격된다. 기준이 오염되면 수렴이
   * 그것을 정답으로 밀므로 CE-27 급이다.
   *
   * I6(b)·I7 처럼 **살아 있는데 아무도 안 지나가는 판정 자리**를 하나 더 두지 않는다.
   */
  it('원장이 증명 못 하는 평면은 서명이 없어도 내 것이 아니다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const x = OP('X', 'gen-B', '0', '1');
    // 남이 **다른 세대**로 stream 을 같은 좌표에 채운다.
    const y: ApplyOperation = {
      ...OP('Y', 'gen-C', '0', '1'), affectedPlanes: ['stream'],
    };

    await agent.reserveAll(x, { op: x, phase: 'preflight', reloadAttempts: 0, progress: {} });
    await agent.abort(tupleFor(x, 'stream'));
    await agent.reserve(tupleFor(y, 'stream'));
    await agent.stage(tupleFor(y, 'stream'), null);
    await agent.commit(tupleFor(y, 'stream'), { acceptingGeneration: 'gen-C' });
    await agent.finishOperation(y, ['stream']);
    await agent.stage(tupleFor(x, 'http'), null);
    await agent.commit(tupleFor(x, 'http'), { acceptingGeneration: 'gen-B' });

    // 26차 이전 writer 를 흉내낸다 — 서명이 없다.
    const raw = store.load()!;
    const payload = raw.payload as { planes: Record<string, { by?: unknown }> };
    for (const plane of Object.keys(payload.planes)) delete payload.planes[plane]!.by;
    await store.save({ ...raw, version: raw.version + 1, payload });

    await new DpAgent(store).finishOperation(x, ['http', 'stream']);

    expect(
      new DpAgent(store).lastActivated()?.generation,
      'stream 은 gen-C 를 서빙하는데 gen-B 를 전체 활성화 기준으로 올렸다',
    ).not.toBe('gen-B');
  });
});

describe('폐위 뒤에 갈 곳이 있다 (33차 — 실측을 고정한다)', () => {
  /**
   * 32차가 `dirty` 뒤의 출구를 **실측**했고 STATUS 에 적었다. 33차가 지적하기를 —
   * **고정 안 된 실측은 이 시리즈에서 세 번 되돌아왔다**(가격표 두 번, `positionsReached`
   * 한 번). 그래서 못박는다.
   *
   * 폐위의 정당성은 "되감지 않는다" 만으로는 부족하다. **막다른 곳이 아니어야** 한다 —
   * 운영자가 새 세대를 적용하면 정상으로 돌아와야 한다. 그게 아니면 폐위는 봉쇄의
   * 다른 이름일 뿐이고, 이 시리즈는 봉쇄를 상(上)으로 세어 왔다.
   */
  it('폐위된 뒤 새 세대를 적용하면 다시 수렴한다', async () => {
    const store = new MemoryStore();
    const fx = new FakeEffects();
    await LocalDataplaneDriver.create({ store, effects: fx })
      .applyConfig(OP('A', 'gen-A', '0', '1'));

    const agent = new DpAgent(store);
    const x = OP('X', 'gen-B', '1', '2');
    const y: ApplyOperation = {
      ...OP('Y', 'gen-B', '1', '2'), affectedPlanes: ['stream'], planes: x.planes,
    };
    await agent.reserveAll(x, { op: x, phase: 'preflight', reloadAttempts: 0, progress: {} });
    await agent.abort(tupleFor(x, 'stream'));
    await agent.reserve(tupleFor(y, 'stream'));
    await agent.stage(tupleFor(y, 'stream'), null);
    await agent.commit(tupleFor(y, 'stream'), { acceptingGeneration: 'gen-B' });
    await agent.finishOperation(y, ['stream']);
    await agent.stage(tupleFor(x, 'http'), null);
    await agent.commit(tupleFor(x, 'http'), { acceptingGeneration: 'gen-B' });

    const driver = LocalDataplaneDriver.create({ store, effects: fx });
    await driver.abortConfig(x).catch(() => undefined);
    expect((await driver.reconcileConfig()).kind, '전제가 성립하지 않는다').toBe('dirty');

    // **출구**: 운영자가 새 세대를 적용한다.
    const applied = await driver.applyConfig(OP('C', 'gen-C', '2', '3'));
    expect(applied.phase, '폐위된 뒤에 새 전환이 못 들어간다 — 봉쇄의 다른 이름이다')
      .toBe('activated');
    expect((await driver.reconcileConfig()).kind, '새 기준으로 수렴하지 못한다')
      .toBe('converged');
  });
});
