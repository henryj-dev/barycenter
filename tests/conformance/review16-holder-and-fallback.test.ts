/**
 * 16차 검수 반례 — 셋 다 내가 만든 것이다
 *
 *   ① `pendingEpochs ?? fallback` 의 **fallback 이 옛 구멍을 그대로 두고 있었다.**
 *      15차에 "완결의 뜻은 후보가 정한다" 고 고쳐 놓고, 후보에 그 뜻이 없으면 다시
 *      호출자를 믿게 해 놨다. "이제 옮길 곳이 없다" 고 적었는데 틀렸다.
 *
 *   ② **첫 저널 전에 죽으면 실행권이 영구히 고착된다.** `reserveAll` 이 실행권을 잡고
 *      저널을 쓰기 전에 끊기면, 복구는 §6.2 #1 대로 `no_operation` 을 돌려주고 **아무것도
 *      반납하지 않는다.** 그다음 오퍼레이션은 전부 `operation_in_flight` 로 막힌다.
 *
 *   ③ 수렴이 `repaired` 를 돌려주기 전에 기준을 다시 보지 않는다. 조기 `converged` 와
 *      소진 경로에는 넣었는데 여기만 빠졌다.
 */
import { describe, expect, it } from 'vitest';
import { DpAgent, MemoryStore, tupleFor } from '../../src/dp/agent.js';
import { ApplyRunner, FakeEffects } from '../../src/dp/apply.js';
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

const FAST = { attempts: 1, intervalMs: 0, sleep: async () => {}, effectTimeoutMs: 500 };

describe('① 완결의 뜻이 없으면 승격하지 않는다 — 호출자로 되돌아가지 않는다', () => {
  it('옛 payload 처럼 pendingEpochs 가 없어도 부분 활성화가 기준이 되지 않는다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const op = OP('A', 'gen-A', '10');
    await agent.reserveAll(op);
    await agent.stage(tupleFor(op, 'http'), null);
    await agent.commit(tupleFor(op, 'http'), { acceptingGeneration: 'gen-A' });

    // 15차 앞에 저장된 상태를 흉내낸다 — 후보는 있는데 완결의 뜻이 없다.
    const stored = store.load()!;
    const payload = stored.payload as Record<string, unknown>;
    delete payload.pendingEpochs;
    await store.save({ version: stored.version + 1, payload });

    const half: ApplyOperation = {
      ...op, affectedPlanes: ['http'], planes: { http: op.planes.http! },
    };
    await new DpAgent(store).finishOperation(half);

    expect(
      new DpAgent(store).lastActivated(),
      'fallback 이 옛 구멍을 되살렸다 — 호출자가 준 평면 집합을 다시 믿었다',
    ).toBeUndefined();
  });
});

describe('② 첫 저널 전에 끊겨도 실행권이 고착되지 않는다', () => {
  it('복구가 no_operation 이면 실행권도 놓는다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    await agent.reserveAll(OP('A', 'gen-A', '10'));
    expect(agent.readJournal(), '전제가 성립하지 않는다 — 저널이 있으면 안 된다').toBeUndefined();
    expect(agent.activeOperation()?.operationId, '창을 만들지 못했다').toBe('A');

    const r = await new ApplyRunner(new DpAgent(store), new FakeEffects(), FAST).recover();
    expect(r.phase).toBe('no_operation');

    expect(
      new DpAgent(store).activeOperation(),
      '실행권이 남았다 — 다음 오퍼레이션이 영영 막힌다',
    ).toBeUndefined();
  });

  it('그래서 복구 뒤에 다음 오퍼레이션이 들어간다', async () => {
    const store = new MemoryStore();
    await new DpAgent(store).reserveAll(OP('A', 'gen-A', '10'));
    await new ApplyRunner(new DpAgent(store), new FakeEffects(), FAST).recover();

    const r = await new ApplyRunner(new DpAgent(store), new FakeEffects(), FAST)
      .run(OP('B', 'gen-B', '10'));
    expect(r.phase, '실행권이 막고 있다').toBe('activated');
  });

  it('예약도 함께 놓는다 — 좌표가 잠기면 같은 결과다', async () => {
    const store = new MemoryStore();
    const op = OP('A', 'gen-A', '10');
    await new DpAgent(store).reserveAll(op);
    await new ApplyRunner(new DpAgent(store), new FakeEffects(), FAST).recover();

    expect(
      new DpAgent(store).reservationOwner('http', '1'),
      '예약이 남아 다음 오퍼레이션이 slot_taken 된다',
    ).toBeUndefined();
  });
});

describe('③ repaired 를 돌려주기 전에도 기준을 다시 본다', () => {
  it('되돌리는 사이 기준이 옮겨 갔으면 repaired 라고 하지 않는다', async () => {
    const store = new MemoryStore();
    const seed = new FakeEffects();
    await LocalDataplaneDriver.create({ store, effects: seed }).applyConfig(OP('A', 'gen-A', '10'));

    let observes = 0;
    const shifting = new (class extends FakeEffects {
      override async observePublished(): Promise<PublishedState> {
        observes += 1;
        // 두 번째 관측(되돌린 뒤)에서 기준이 옮겨 간다.
        if (observes === 2) {
          const stored = store.load()!;
          const payload = stored.payload as { lastActivated?: unknown };
          payload.lastActivated = {
            generation: 'gen-Z', leaderToken: '10', operationId: 'Z',
            transitionId: 'Z', generationDigest: 'sha256:gen-Z',
          };
          await store.save({ version: stored.version + 1, payload });
        }
        return observes === 1 ? { kind: 'none' } : super.observePublished();
      }
    })();
    shifting.publishedRecord = seed.publishedRecord;
    shifting.acceptingGeneration = 'gen-A';

    const r = await LocalDataplaneDriver.create({ store, effects: shifting }).reconcileConfig();

    expect(observes, '반례를 재현하지 못했다').toBeGreaterThanOrEqual(2);
    expect(r.kind, '기준이 옮겨 갔는데 되돌렸다고 답했다').not.toBe('repaired');
  });
});

describe('막기만 하는 게 아니다 — 정당한 경로는 그대로 지난다', () => {
  /**
   * 16차 수정 셋은 전부 "덜 하게" 만드는 방향이다. 그러면 **정당한 것까지 덜 하게 될
   * 위험**이 따라온다. 막는 쪽만 짚고 통과하는 쪽을 안 짚으면 반쪽이다.
   */
  it('정상 apply 는 여전히 기준을 세운다', async () => {
    const store = new MemoryStore();
    const r = await LocalDataplaneDriver.create({ store, effects: new FakeEffects() })
      .applyConfig(OP('A', 'gen-A', '10'));

    expect(r.phase).toBe('activated');
    expect(
      new DpAgent(store).lastActivated()?.generation,
      '승격을 포기하는 쪽으로 고쳤더니 정상 경로까지 잃었다',
    ).toBe('gen-A');
  });

  it('실행권이 있으면 완결의 뜻이 후보에 함께 적힌다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const op = OP('A', 'gen-A', '10');
    await agent.reserveAll(op);
    await agent.stage(tupleFor(op, 'http'), null);
    await agent.commit(tupleFor(op, 'http'), { acceptingGeneration: 'gen-A' });

    const payload = store.load()!.payload as { pendingEpochs?: Record<string, string> };
    expect(payload.pendingEpochs, '뜻이 안 적혔다 — 그러면 영영 승격 못 한다')
      .toEqual({ http: '1', stream: '1' });
  });

  it('같은 오퍼레이션 재진입은 저널을 새로 열지 않는다', async () => {
    const store = new MemoryStore();
    const fx = new FakeEffects();
    const driver = LocalDataplaneDriver.create({ store, effects: fx });
    await driver.applyConfig(OP('A', 'gen-A', '10'));
    const before = new DpAgent(store).readJournal()?.seq;

    await driver.applyConfig(OP('A', 'gen-A', '10'));

    expect(new DpAgent(store).readJournal()?.seq, '재진입이 저널을 새로 열었다').toBe(before);
    expect(new DpAgent(store).activeOperation(), '재진입이 실행권을 쥔 채 돌아갔다').toBeUndefined();
  });

  it('다른 오퍼레이션이 진행 중이면 잡기가 막힌다 — 저널을 함께 써도', async () => {
    const store = new MemoryStore();
    const a = OP('A', 'gen-A', '10');
    const b = OP('B', 'gen-B', '10');
    const opening = (op: ApplyOperation) => ({
      op, phase: 'preflight' as const, reloadAttempts: 0, progress: {},
    });
    await new DpAgent(store).reserveAll(a, opening(a));

    await expect(
      new DpAgent(store).reserveAll(b, opening(b)),
      '남의 실행권을 밀고 들어갔다',
    ).rejects.toMatchObject({ kind: 'operation_in_flight' });
  });
});
