/**
 * 5차 검수 반례 — ApplyOperation 스키마와 변이 봉투
 * (DESIGN.md §9.1.1 blocker 2·3)
 *
 * blocker 2 — apply 가 평면 하나만 다뤘다. 그런데 HUP 은 nginx 전체에 적용된다.
 *   러너를 두 번 돌리면 **첫 HUP 때 다른 평면은 아직 staging 되지 않았다.** 실패했을 때
 *   어느 평면이 반영됐는지 durable 하게 말할 방법도 없었다.
 *   활성화 증거도 세대 문자열 하나였다 — §6.3 의 config test·error log·워커 집합을
 *   표현할 수도 검증할 수도 없었다.
 *
 * blocker 3 — 설정 경로에 리더 토큰도 튜플도 없었다. 설정을 게시하고 HUP 을 보내는 것은
 *   멤버십 못지않은 부작용인데(오히려 더 크다 — 프로세스 전체를 바꾼다) 봉투 밖에 있었다.
 */
import { describe, expect, it } from 'vitest';
import { FakeEffects } from '../../src/testing/apply-fakes.js';
import { DpAgent, DpRejection, MemoryStore, tupleFor } from '../../src/dp/agent.js';
import { LocalDataplaneDriver, type DataplaneDriver } from '../../src/dp/driver.js';
import { ApplyRunner, recordOf } from '../../src/dp/apply.js';
import type {
  Checked, ApplyLease } from '../../src/dp/operation.js';
import {
  provesActivation,
  type ActivationEvidence,
  type ApplyOperation,
  type Plane,
} from '../../src/dp/operation.js';

const OP = (o: Partial<ApplyOperation> = {}): ApplyOperation => ({
  leaderToken: '10',
  operationId: 'op-1',
  transitionId: 't-1',
  affectedPlanes: ['http', 'stream'],
  targetGeneration: 'gen-1',
  generationDigest: 'sha256:gen',
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

/** 두 평면을 한 오퍼레이션으로 옮긴다. */
const BOTH = (o: Partial<ApplyOperation> = {}): ApplyOperation =>
  OP({
    affectedPlanes: ['http', 'stream'],
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

const FAST = { attempts: 1, intervalMs: 0, sleep: async () => {} };

/**
 * 이 스위트는 Agent 를 직접 들여다보므로 그 Agent 위의 드라이버가 필요하다.
 * 공개 경로는 `LocalDataplaneDriver.create({store, effects})` 다 (7차 반례 ④).
 */
const driverOn = (agent: DpAgent, effects: FakeEffects): LocalDataplaneDriver =>
  Reflect.construct(LocalDataplaneDriver, [agent, effects]) as LocalDataplaneDriver;

const kindOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return '거부되지 않았다';
  } catch (e) {
    return e instanceof DpRejection ? e.kind : `${(e as Error).message}`;
  }
};

// ── blocker 2 · 두 평면을 한 오퍼레이션으로 ──────────────────────────────

describe('두 평면은 한 오퍼레이션으로 함께 넘어간다 (§3.4)', () => {
  it('둘 다 활성화되고 결과가 평면별로 나온다', async () => {
    const agent = new DpAgent(new MemoryStore());
    const result = await new ApplyRunner(agent, new FakeEffects(), FAST).run(BOTH());

    expect(result.phase).toBe('activated');
    expect(result.progress.http).toBe('committed');
    expect(result.progress.stream).toBe('committed');
    expect(result.partialTransition).toBe(false);
    expect(agent.coordinate('http').activationEpoch).toBe('1');
    expect(agent.coordinate('stream').activationEpoch).toBe('1');
  });

  it('**HUP 앞에 두 평면이 모두 staging 된다** — 한쪽만 올린 채로 신호를 보내지 않는다', async () => {
    const agent = new DpAgent(new MemoryStore());

    /** HUP 을 보내는 **그 순간** 두 슬롯을 들여다본다. */
    class Watching extends FakeEffects {
      staged: Partial<Record<Plane, string | undefined>> = {};
      override async signalReload(lease: ApplyLease): Promise<Checked> {
        this.staged = {
          http: agent.stagedDigest('http', '1'),
          stream: agent.stagedDigest('stream', '1'),
        };
        return super.signalReload(lease);
      }
    }

    const effects = new Watching();
    await new ApplyRunner(agent, effects, FAST).run(BOTH());
    expect(effects.staged.http, 'HUP 시점에 http 슬롯이 없었다').toBe('sha256:h');
    expect(effects.staged.stream, 'HUP 시점에 stream 슬롯이 없었다').toBe('sha256:s');
  });

  it('한 평면의 예약이 막히면 **아무 부작용도 내지 않는다**', async () => {
    const agent = new DpAgent(new MemoryStore());
    // stream 좌표를 먼저 옮겨 둔다 → BOTH 의 stream expectedCurrent 가 어긋난다.
    const pre = OP({
      operationId: 'pre',
      transitionId: 'pre',
      affectedPlanes: ['http', 'stream'],
      planes: {
        http: {
          expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
          target: { activationEpoch: '1', membershipRevision: '1' },
          payloadDigest: 'sha256:pre-h',
        },
        stream: {
          expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
          target: { activationEpoch: '1', membershipRevision: '1' },
          payloadDigest: 'sha256:pre',
        },
      },
    });
    await new ApplyRunner(agent, new FakeEffects(), FAST).run(pre);

    const effects = new FakeEffects();
    // 두 평면이 이미 (1,1) 인데 BOTH 는 (0,0) 을 기대한다 → 좌표 CAS 에서 막힌다.
    expect(await kindOf(new ApplyRunner(agent, effects, FAST).run(BOTH())))
      .toBe('coordinate_mismatch');
    expect(effects.publishCalls, '한 평면이 막혔는데 게시했다').toBe(0);
    expect(effects.reloadSignals).toBe(0);
    // 먼저 성공한 평면의 **예약**도 남으면 안 된다 — 좌표가 영구히 잠긴다.
    // `stagedDigest` 로는 못 잡는다. 예약만 하고 stage 는 안 했으므로 어느 쪽이든
    // undefined 다 — 슬롯의 **주인**을 봐야 한다.
    expect(agent.reservationOwner('http', '1'), 'http 예약이 반납되지 않았다').toBeUndefined();
    // pre 가 두 평면을 모두 옮겼으므로 좌표는 1 이다. 중요한 것은 **BOTH 가 아무것도
    // 바꾸지 못했다**는 것 — 부작용도 예약도 없다.
    expect(agent.coordinate('http').activationEpoch).toBe('1');
  });

  it('실패하면 두 평면 다 옛 좌표에 남는다 — 부분 전환이 아니다', async () => {
    const agent = new DpAgent(new MemoryStore());
    const effects = new FakeEffects();
    effects.reloadTakesEffect = false;

    const result = await new ApplyRunner(agent, effects, FAST).run(BOTH());
    expect(result.phase).toBe('failed');
    expect(result.partialTransition, '아무것도 안 넘어갔는데 부분 전환이라고 했다').toBe(false);
    expect(result.progress.http).toBe('failed');
    expect(result.progress.stream).toBe('failed');
    expect(agent.coordinate('http').activationEpoch).toBe('0');
    expect(agent.coordinate('stream').activationEpoch).toBe('0');
  });
});

// ── blocker 2 · 활성화 증거 ─────────────────────────────────────────────

describe('활성화 증거는 세대 문자열 하나가 아니다 (§6.3)', () => {
  it('세대가 맞아도 config test 가 실패했으면 활성화가 아니다', () => {
    const e: ActivationEvidence = { acceptingGeneration: 'gen-1', configTestPassed: false };
    expect(provesActivation(e, 'gen-1')).toBe(false);
  });

  it('세대가 맞아도 error log 가 늘었으면 활성화가 아니다 — S7 의 음성 신호', () => {
    const e: ActivationEvidence = { acceptingGeneration: 'gen-1', errorLogGrowth: 3 };
    expect(provesActivation(e, 'gen-1')).toBe(false);
  });

  it('워커가 덜 보고했으면 활성화가 아니다', () => {
    const e: ActivationEvidence = {
      acceptingGeneration: 'gen-1',
      workersExpected: 4,
      workersReported: 3,
    };
    expect(provesActivation(e, 'gen-1')).toBe(false);
  });

  it('관측하지 못한 것은 반증이 아니다 — undefined 와 false 는 다르다', () => {
    expect(provesActivation({ acceptingGeneration: 'gen-1' }, 'gen-1')).toBe(true);
    expect(
      provesActivation({ acceptingGeneration: 'gen-1', errorLogGrowth: 0, configTestPassed: true }, 'gen-1'),
    ).toBe(true);
  });

  it('세대가 다르면 나머지가 아무리 좋아도 활성화가 아니다', () => {
    const e: ActivationEvidence = {
      acceptingGeneration: 'gen-0',
      configTestPassed: true,
      errorLogGrowth: 0,
    };
    expect(provesActivation(e, 'gen-1')).toBe(false);
  });

  it('러너는 음성 신호를 보면 좌표를 옮기지 않는다', async () => {
    const agent = new DpAgent(new MemoryStore());
    const effects = new FakeEffects();
    // 세대는 넘어갔다고 답하지만 error log 가 늘었다 — 포트 점유 등 (S7).
    effects.errorLogGrowth = 5;

    const result = await new ApplyRunner(agent, effects, FAST).run(OP());
    expect(result.phase).toBe('failed');
    expect(agent.coordinate('http').activationEpoch, '음성 신호를 무시하고 좌표를 옮겼다').toBe('0');
  });

  it('좌표를 옮긴 근거가 저장된다 — 나중에 왜 옮겼는지 답할 수 있어야 한다', async () => {
    const agent = new DpAgent(new MemoryStore());
    const effects = new FakeEffects();
    effects.errorLogGrowth = 0;
    effects.configTestPassed = true;

    const result = await new ApplyRunner(agent, effects, FAST).run(OP());
    expect(result.phase).toBe('activated');
    expect(result.evidence?.acceptingGeneration).toBe('gen-1');
    expect(result.evidence?.configTestPassed).toBe(true);
    expect(agent.evidenceFor('http', '1')?.acceptingGeneration).toBe('gen-1');
  });
});

// ── blocker 3 · 설정 경로도 봉투를 지난다 ───────────────────────────────

describe('설정 경로도 리더 토큰을 지난다 (§9.1.1 blocker 3)', () => {
  it('낮은 토큰의 설정 apply 는 게시조차 못 한다', async () => {
    const agent = new DpAgent(new MemoryStore());
    await agent.fence('99');
    const effects = new FakeEffects();

    expect(await kindOf(new ApplyRunner(agent, effects, FAST).run(OP({ leaderToken: '10' }))))
      .toBe('stale_leader');
    expect(effects.publishCalls).toBe(0);
  });

  it('봉투에 평면이 없으면 거부된다 — 무엇을 바꾸는지 말하지 않는 변이는 없다', async () => {
    const agent = new DpAgent(new MemoryStore());
    const effects = new FakeEffects();
    expect(
      await kindOf(
        new ApplyRunner(agent, effects, FAST).run(OP({ affectedPlanes: [], planes: {} })),
      ),
    ).toBe('empty_envelope');
    expect(effects.publishCalls).toBe(0);
  });

  it('봉투가 말한 평면과 목표가 어긋나면 거부된다', async () => {
    const agent = new DpAgent(new MemoryStore());
    const effects = new FakeEffects();
    // stream 을 건드린다고 해 놓고 목표를 안 실었다.
    expect(
      await kindOf(new ApplyRunner(agent, effects, FAST).run(
        OP({ affectedPlanes: ['http', 'stream'], planes: { http: OP().planes.http! } }),
      )),
    ).toBe('envelope_mismatch');
    expect(effects.publishCalls).toBe(0);
  });

  it('목표를 실어 놓고 봉투에서 뺀 평면도 거부된다', async () => {
    const agent = new DpAgent(new MemoryStore());
    const effects = new FakeEffects();
    expect(
      await kindOf(
        new ApplyRunner(agent, effects, FAST).run(
          BOTH({ affectedPlanes: ['http'] }),
        ),
      ),
    ).toBe('envelope_mismatch');
    expect(effects.publishCalls).toBe(0);
  });
});

// ── blocker 3 · 드라이버 계약이 실제로 선다 ─────────────────────────────

describe('DataplaneDriver 는 구현과 함께 선다 (§9.1 · §9.2)', () => {
  it('참조 구현이 계약을 만족한다 — 인터페이스만 두고 미루지 않는다', async () => {
    const agent = new DpAgent(new MemoryStore());
    const effects = new FakeEffects();
    const driver: DataplaneDriver = driverOn(agent, effects);

    await driver.fence('10');
    const before = await driver.status();
    expect(before.maxLeaderToken).toBe('10');
    expect(before.planes.http.activationEpoch).toBe('0');
    expect(before.published.kind).toBe('none');

    const result = await driver.applyConfig(BOTH());
    expect(result.phase).toBe('activated');

    const after = await driver.status();
    expect(after.published).toMatchObject({ kind: 'owned', record: { generation: 'gen-1' } });
    expect(after.planes.http.activationEpoch).toBe('1');
    expect(after.planes.stream.activationEpoch).toBe('1');
    expect(after.lastEvidence?.acceptingGeneration).toBe('gen-1');
  });

  it('abort 는 오퍼레이션을 통째로 받는다 — 슬롯의 주인으로 인정받아야 지운다', async () => {
    const agent = new DpAgent(new MemoryStore());
    const driver = driverOn(agent, new FakeEffects());
    const op = BOTH();

    await agent.reserve(tupleFor(op, 'http'));
    await agent.stage(tupleFor(op, 'http'), null);
    expect(agent.stagedDigest('http', '1')).toBe('sha256:h');

    await driver.abortConfig(op);
    expect(agent.stagedDigest('http', '1'), 'abort 가 자기 슬롯을 못 지웠다').toBeUndefined();
  });

  it('낮은 토큰은 드라이버 표면에서도 막힌다', async () => {
    const agent = new DpAgent(new MemoryStore());
    const effects = new FakeEffects();
    const driver = driverOn(agent, effects);
    await driver.fence('99');
    expect(await kindOf(driver.applyConfig(OP({ leaderToken: '10' })))).toBe('stale_leader');
    expect(effects.publishCalls).toBe(0);
  });
});
