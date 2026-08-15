/**
 * 12차 검수 반례 — 수렴을 **하나의 bounded 루프**로 닫는다
 *
 * 11차에서 넣은 deadline 이 **또 새 구멍을 만들었다.** 일곱 라운드 연속이다.
 *
 *   ① 예산 초과 정리가 **신임 오퍼레이션을 훼손한다.** A 의 publish 를 기다리다 끊었는데,
 *      그 사이 B 가 들어와 저널을 열었으면 A 가 **B 의 저널을** failAll 한다.
 *   ② **최초 apply 의 늦은 HUP 은 되돌릴 기준이 없다.** lastActivated 는 commit 에서만
 *      생기므로, 한 번도 활성화하지 못한 채 늦은 효과가 착지하면 reconcile 이 영영
 *      `no_baseline` 이다.
 *   ③ reconcile 이 기준 변경을 만나면 **재관측 없이 converged 라고 답한다.**
 *      preflight 도 안 부르고 예산도 없다.
 *   ④ "항상 두 평면" 이 타입에 없다. singleton 으로 abort 하면 다른 평면 예약이 고아가 된다.
 *   ⑤ partial 재시도를 소진하면 저널은 비종단인데 실행권은 풀려 있어, 두 번째 복구가
 *      `not_reserved` 로 깨진다.
 */
import { describe, expect, it } from 'vitest';
import { DpAgent, MemoryStore, tupleFor } from '../../src/dp/agent.js';
import { ApplyRunner, FakeEffects } from '../../src/dp/apply.js';
import { LocalDataplaneDriver } from '../../src/dp/driver.js';
import type {
  Checked, ApplyLease, ApplyOperation, PublishRecord } from '../../src/dp/operation.js';

const OP = (id: string, gen = 'gen-1', o: Partial<ApplyOperation> = {}): ApplyOperation => ({
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
  ...o,
});

const FAST = { attempts: 1, intervalMs: 0, sleep: async () => {}, effectTimeoutMs: 40 };

const kindOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return '통과';
  } catch (e) {
    return (e as { kind?: string }).kind ?? (e as Error).name;
  }
};

// ── ① 예산 초과 정리가 남을 훼손한다 ───────────────────────────────────

describe('① 끊긴 러너는 **자기 것만** 정리한다', () => {
  it('예산 초과 정리가 **진행 중인** 신임 오퍼레이션을 망가뜨리지 않는다', async () => {
    const store = new MemoryStore();
    const oldAgent = new DpAgent(store);
    const newAgent = new DpAgent(store);

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });

    class Hanging extends FakeEffects {
      override async publish(_r: PublishRecord, _l: ApplyLease): Promise<Checked> {
        await gate; // 예산을 넘긴다
        return new Promise<Checked>(() => undefined);
      }
    }

    const stuck = new ApplyRunner(oldAgent, new Hanging(), FAST).run(OP('A')).catch((e) => e);
    await new Promise((r) => setTimeout(r, 10));

    // 새 리더가 들어와 **자기 저널을 열고 진행 중**이다 (아직 안 끝났다).
    await newAgent.fence('11');
    const b = OP('B', 'gen-2', { leaderToken: '11' });
    await newAgent.reserveAll(b);
    await newAgent.writeJournal({
      op: b, phase: 'preflight', reloadAttempts: 0,
      seq: (newAgent.readJournal()?.seq ?? 0) + 1, progress: { http: 'reserved', stream: 'reserved' },
    });

    await stuck;   // 여기서 A 가 예산 초과로 끊기며 "정리" 한다
    release();

    // **B 는 아직 진행 중이다.** A 의 정리가 B 의 저널·예약·실행권을 건드리면 안 된다.
    expect(newAgent.readJournal()?.op.operationId, 'A 가 B 의 저널을 가져갔다').toBe('B');
    expect(newAgent.readJournal()?.phase, 'A 의 정리가 B 의 단계를 바꿨다').toBe('preflight');
    expect(newAgent.activeOperation()?.operationId, 'A 가 B 의 실행권을 풀었다').toBe('B');
    for (const plane of ['http', 'stream'] as const) {
      expect(
        newAgent.reservationOwner(plane, '1')?.operationId,
        `A 가 B 의 ${plane} 예약을 지웠다`,
      ).toBe('B');
    }
  });
});

// ── ② 기준 없는 늦은 효과 ──────────────────────────────────────────────

describe('② 한 번도 활성화하지 못해도 되돌릴 기준이 있다', () => {
  it('최초 apply 가 끊긴 뒤에도 reconcile 이 손을 놓지 않는다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);

    class HangingReload extends FakeEffects {
      override async signalReload(_l: ApplyLease): Promise<Checked> {
        return new Promise<Checked>(() => undefined); // 영영 안 끝난다
      }
    }
    const fx = new HangingReload();
    const r = await new ApplyRunner(agent, fx, FAST).run(OP('first'));
    expect(r.phase).toBe('failed');

    // 게시는 이미 나갔다. 좌표는 0 이다. 이 상태를 reconcile 이 알아야 한다.
    const driver = LocalDataplaneDriver.create({ store, effects: fx });
    const rec = await driver.reconcileConfig();
    expect(rec.kind, '게시가 나갔는데 되돌릴 기준이 없다고 한다').not.toBe('no_baseline');
  });
});

// ── ③ reconcile 이 기준 변경을 만나면 ──────────────────────────────────

describe('③ 기준이 바뀌면 처음부터 다시 본다', () => {
  it('바뀐 기준을 관측 없이 converged 라고 하지 않는다', async () => {
    const store = new MemoryStore();
    const fx = new FakeEffects();
    const driver = LocalDataplaneDriver.create({ store, effects: fx });
    await driver.applyConfig(OP('A', 'gen-A'));

    const agent = new DpAgent(store);
    class Shifting extends FakeEffects {
      shifted = false;
      override async observePublished() {
        if (!this.shifted) {
          this.shifted = true;
          // 기준이 B 로 바뀌고, 늦은 X 가 게시된다.
          await agent.fence('11');
          await new ApplyRunner(agent, this, FAST).run(
            OP('B', 'gen-B', {
              leaderToken: '11',
              planes: {
                http: { expectedCurrent: { activationEpoch: '1', membershipRevision: '1' },
                        target: { activationEpoch: '2', membershipRevision: '2' }, payloadDigest: 'h' },
                stream: { expectedCurrent: { activationEpoch: '1', membershipRevision: '1' },
                          target: { activationEpoch: '2', membershipRevision: '2' }, payloadDigest: 's' },
              },
            }),
          );
          this.publishedRecord = {
            generation: 'gen-X', leaderToken: '9', operationId: 'X',
            transitionId: 'X', generationDigest: 'sha256:gen-X',
          };
        }
        return super.observePublished();
      }
    }
    const shifting = new Shifting();
    shifting.acceptingGeneration = fx.acceptingGeneration;
    const d2 = LocalDataplaneDriver.create({ store, effects: shifting });

    const r = await d2.reconcileConfig();
    expect(r.kind, '늦은 X 가 게시돼 있는데 수렴했다고 답했다').not.toBe('converged');
  });
});

// ── ④ singleton abort 가 다른 평면을 고아로 만든다 ─────────────────────

describe('④ abort 도 오퍼레이션 전체를 정리한다', () => {
  it('한 평면만 담은 abort 가 다른 평면 예약을 남기지 않는다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const full = OP('A');
    await agent.reserveAll(full);

    // 같은 오퍼레이션인데 http 만 담아서 abort 한다.
    const half = OP('A', 'gen-1', { affectedPlanes: ['http'], planes: { http: full.planes.http! } });
    await LocalDataplaneDriver.create({ store, effects: new FakeEffects() })
      .abortConfig(half)
      .catch(() => undefined);

    expect(
      agent.reservationOwner('stream', '1'),
      'stream 예약이 고아로 남아 다음 apply 가 slot_taken 된다',
    ).toBeUndefined();
    expect(await kindOf(agent.reserveAll(OP('next')))).toBe('통과');
  });
});

// ── ⑤ partial 소진 뒤 복구 ─────────────────────────────────────────────

describe('⑤ partial 재시도를 소진해도 복구가 깨지지 않는다', () => {
  it('두 번째 복구가 not_reserved 로 죽지 않는다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const op = OP('half');
    const fx = new FakeEffects();
    fx.publishedRecord = {
      generation: 'gen-1', leaderToken: '10', operationId: 'half',
      transitionId: 'half', generationDigest: 'sha256:gen-1',
    };
    fx.acceptingGeneration = 'gen-1';

    await agent.reserveAll(op);
    await agent.stage(tupleFor(op, 'http'), null);   // stream 은 stage 하지 않는다
    await agent.writeJournal({
      op, phase: 'reload_observed', reloadAttempts: 9, seq: 1,
      progress: { http: 'staged', stream: 'reserved' },
    });

    // 재시도를 이미 소진했으므로 **종단**으로 닫힌다.
    const first = await new ApplyRunner(agent, fx, FAST).recover();
    expect(first.phase).toBe('partial_exhausted');
    expect(first.partialTransition, '부분 전환인데 그렇게 말하지 않는다').toBe(true);

    // **두 번째 복구가 같은 답을 준다.** 비종단으로 두면서 실행권만 풀면 여기서
    // not_reserved 로 죽었다.
    const second = await new ApplyRunner(agent, fx, FAST).recover().catch((e) => e);
    expect(
      (second as { phase?: string }).phase ?? `${(second as Error).name}`,
      '두 번째 복구가 깨졌다',
    ).toBe('partial_exhausted');
  });
});

// ── 13차 반례 ② — 부분 활성화는 기준이 아니다 ──────────────────────────

describe('⑥ partial 은 수렴 기준이 되지 못한다 (13차)', () => {
  /**
   * `lastActivated` 를 **평면별 commit 마다** 갱신하고 있었다. 그래서 http 만 넘어간
   * 상태에서도 기준이 생기고, reconcile 이 `converged` 라고 답했다 —
   * **실제 좌표는 `http=1 / stream=0`** 인데.
   *
   * 기준은 **오퍼레이션 단위**여야 한다. 전 평면이 넘어갔을 때만 "여기로 되돌린다" 고
   * 말할 수 있다.
   */
  it('한 평면만 넘어간 상태를 converged 라고 하지 않는다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const op = OP('half');
    const fx = new FakeEffects();
    fx.publishedRecord = {
      generation: 'gen-1', leaderToken: '10', operationId: 'half',
      transitionId: 'half', generationDigest: 'sha256:gen-1',
    };
    fx.acceptingGeneration = 'gen-1';

    await agent.reserveAll(op);
    await agent.stage(tupleFor(op, 'http'), null);   // stream 은 stage 하지 않는다
    await agent.writeJournal({
      op, phase: 'reload_observed', reloadAttempts: 9, seq: 1,
      progress: { http: 'staged', stream: 'reserved' },
    });

    const r = await new ApplyRunner(agent, fx, FAST).recover();
    expect(r.phase).toBe('partial_exhausted');
    expect(agent.coordinate('http').activationEpoch).toBe('1');
    expect(agent.coordinate('stream').activationEpoch, '부분 활성화 상태를 만들지 못했다').toBe('0');

    const rec = await LocalDataplaneDriver.create({ store, effects: fx }).reconcileConfig();
    expect(rec.kind, '한 평면만 넘어갔는데 수렴했다고 답했다').not.toBe('converged');
  });

  it('전 평면이 넘어가면 기준이 된다 — 막는 것만 하는 게 아니다', async () => {
    const store = new MemoryStore();
    const fx = new FakeEffects();
    const driver = LocalDataplaneDriver.create({ store, effects: fx });
    expect((await driver.applyConfig(OP('full'))).phase).toBe('activated');
    expect((await driver.reconcileConfig()).kind).toBe('converged');
  });
});
