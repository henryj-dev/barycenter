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
import type { ApplyOperation } from '../../src/dp/operation.js';

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
    if (r.kind === 'converged') {
      expect(
        r.record.generation,
        '좌표는 gen-B 로 갔는데 gen-A 를 수렴이라고 답했다',
      ).not.toBe('gen-A');
    }
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
