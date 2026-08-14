/**
 * 14차 검수 — 기준 후보를 **상태로** 끝낸다
 *
 * 13차 ② 를 고치면서 `finishOperation({ promote })` 을 두고 호출자가 boolean 을 넘기게
 * 했다. 그러면 **경로 하나를 빠뜨리는 순간** 기준이 새거나 사라진다. 실제로 셋을 빠뜨렸다.
 *
 *   · `recover()` 종단 경로 — `promote` 를 안 넘겨서 활성화한 기준이 사라졌다 (e280e93)
 *   · `fence` 승계 — 전 평면이 넘어간 후보가 그대로 고아가 됐다
 *   · `applyConfig` 재진입 — 종단을 만나고 실행권을 쥔 채 돌아갔다
 *
 * 셋 다 같은 병이다. 그래서 boolean 을 없앴다. `finalizeCandidate` 가 **좌표를 직접 보고**
 * 판정한다 — 선언한 평면이 전부 목표 epoch 에 도착했으면 기준이 되고, 아니면 버린다.
 * 호출자가 무엇을 아는지와 무관하게 같은 답이 나온다.
 */
import { describe, expect, it } from 'vitest';
import { DpAgent, DpRejection, MemoryStore, tupleFor } from '../../src/dp/agent.js';
import { FakeEffects } from '../../src/dp/apply.js';
import { LocalDataplaneDriver } from '../../src/dp/driver.js';
import type { ApplyOperation } from '../../src/dp/operation.js';

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

/** 전 평면을 넘긴다. 저널은 아직 비종단이다 — 여기서 무슨 일이 나든 기준은 확정돼야 한다. */
async function bothPlanesCommitted(store: MemoryStore, op: ApplyOperation): Promise<DpAgent> {
  const agent = new DpAgent(store);
  await agent.reserveAll(op);
  for (const plane of ['http', 'stream'] as const) {
    await agent.stage(tupleFor(op, plane), null);
    await agent.commit(tupleFor(op, plane), { acceptingGeneration: op.targetGeneration });
  }
  await agent.writeJournal({
    op, phase: 'reload_observed', reloadAttempts: 1, seq: 1,
    progress: { http: 'committed', stream: 'committed' },
  });
  expect(agent.lastActivated(), '아직 기준이 아니어야 반례가 성립한다').toBeUndefined();
  return agent;
}

describe('승계도 끝내는 것이다 — 후보를 고아로 두지 않는다', () => {
  it('fence 로 승계되면 전 평면 완료 후보가 기준이 된다', async () => {
    const store = new MemoryStore();
    const agent = await bothPlanesCommitted(store, OP('y', 'gen-A', '10'));

    await agent.fence('11');

    expect(
      new DpAgent(store).lastActivated()?.generation,
      '활성화는 일어났는데 승계가 기준을 버렸다',
    ).toBe('gen-A');
  });

  it('한 평면만 넘어간 채 승계되면 기준이 되지 않는다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const op = OP('half', 'gen-A', '10');
    await agent.reserveAll(op);
    await agent.stage(tupleFor(op, 'http'), null);
    await agent.commit(tupleFor(op, 'http'), { acceptingGeneration: 'gen-A' });
    await agent.writeJournal({
      op, phase: 'reload_observed', reloadAttempts: 1, seq: 1,
      progress: { http: 'committed', stream: 'reserved' },
    });

    await agent.fence('11');

    expect(
      new DpAgent(store).lastActivated(),
      '부분 활성화를 되돌릴 기준으로 삼았다',
    ).toBeUndefined();
  });
});

describe('종단에 재진입해도 실행권을 쥐고 있지 않는다', () => {
  it('같은 오퍼레이션으로 다시 apply 하면 실행권을 놓는다', async () => {
    const store = new MemoryStore();
    const fx = new FakeEffects();
    const driver = LocalDataplaneDriver.create({ store, effects: fx });
    const op = OP('z', 'gen-A', '10');

    expect((await driver.applyConfig(op)).phase).toBe('activated');
    expect((await driver.applyConfig(op)).phase, '재진입이 종단을 못 알아본다').toBe('activated');

    expect(
      new DpAgent(store).activeOperation(),
      '재진입이 실행권을 쥔 채 돌아갔다 — 다음 오퍼레이션이 막힌다',
    ).toBeUndefined();
  });

  it('그래서 재진입 뒤에도 다음 오퍼레이션이 들어간다', async () => {
    const store = new MemoryStore();
    const fx = new FakeEffects();
    const driver = LocalDataplaneDriver.create({ store, effects: fx });
    const first = OP('z', 'gen-A', '10');

    await driver.applyConfig(first);
    await driver.applyConfig(first);

    const next: ApplyOperation = {
      ...OP('next', 'gen-B', '10'),
      planes: {
        http: {
          expectedCurrent: { activationEpoch: '1', membershipRevision: '1' },
          target: { activationEpoch: '2', membershipRevision: '2' },
          payloadDigest: 'sha256:h2',
        },
        stream: {
          expectedCurrent: { activationEpoch: '1', membershipRevision: '1' },
          target: { activationEpoch: '2', membershipRevision: '2' },
          payloadDigest: 'sha256:s2',
        },
      },
    };
    expect((await driver.applyConfig(next)).phase, '실행권이 막고 있다').toBe('activated');
  });
});

describe('버리는 것도 판정이다 — 정당한 경로를 막지 않는다', () => {
  /**
   * 처음 쓴 I6 이 여기서 `InvariantViolation` 을 던졌다. "후보가 사라지면 승격됐거나
   * 저널이 activated 가 아니어야 한다" 는 명제가 **사라지는 쪽**을 본 것이 잘못이었다.
   * 한 평면만 commit 하고 저널 없이 abort 하는 것은 정상이다.
   */
  it('한 평면만 commit 한 뒤 abort 해도 불변식이 터지지 않는다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const op = OP('x', 'gen-A', '10');
    await agent.reserveAll(op);
    await agent.stage(tupleFor(op, 'http'), null);
    await agent.commit(tupleFor(op, 'http'), { acceptingGeneration: 'gen-A' });

    const abort = LocalDataplaneDriver.create({ store, effects: new FakeEffects() })
      .abortConfig(op);

    // 이미 넘어간 평면이 있으므로 `terminal` 거부가 나오는 것이 정상이다.
    // **불변식 위반이 아니어야 한다** — 그건 상태가 깨졌다는 뜻이다.
    await expect(abort).rejects.toBeInstanceOf(DpRejection);

    expect(new DpAgent(store).lastActivated(), '부분 활성화가 기준이 됐다').toBeUndefined();
  });
});
