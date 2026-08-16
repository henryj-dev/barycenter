/**
 * 37차 검수 재현 — reload_intent 증거 쓰기의 id-only 오염 (36차 수정 대상의 실제 도달 경로).
 *
 * CE-36-A 는 첫 관측(reload_intent 진입 직후)을 게이트했다. 그러면 낡은 러너는 깨어난 뒤
 * "첫 쓰기"(phase 전이)에서 stale_leader 로 죽어 증거 쓰기 자리에 못 간다.
 *
 * 여기서는 **두 번째 관측**(awaitActivation 안)을 게이트한다. 낡은 러너는 이미
 * reloadAttempts 쓰기와 signalReload 를 fence 전에 끝냈고, 깨어나면 곧장 증거 쓰기
 * 자리다 — 거기서 쓰는 저널은 신임 것이고 토큰도 신임 것이라 agent 층 전부를 통과한다.
 */
import { expect, it } from 'vitest';
import { DpAgent, MemoryStore, tupleFor } from '../../src/dp/agent.js';
import { ApplyRunner, FakeEffects } from '../../src/dp/apply.js';
import type { ActivationEvidence, ApplyOperation } from '../../src/dp/operation.js';

const OP = (
  id: string, token: string, gen: string,
  from: { epoch: string; rev: string }, to: { epoch: string; rev: string },
): ApplyOperation => ({
  leaderToken: token, operationId: id, transitionId: id,
  affectedPlanes: ['http', 'stream'],
  targetGeneration: gen, generationDigest: `sha256:${gen}`,
  planes: {
    http: { expectedCurrent: { activationEpoch: from.epoch, membershipRevision: from.rev },
      target: { activationEpoch: to.epoch, membershipRevision: to.rev }, payloadDigest: `sha256:h-${gen}` },
    stream: { expectedCurrent: { activationEpoch: from.epoch, membershipRevision: from.rev },
      target: { activationEpoch: to.epoch, membershipRevision: to.rev }, payloadDigest: `sha256:s-${gen}` },
  },
});

const FAST = { attempts: 1, intervalMs: 0, sleep: async () => {}, effectTimeoutMs: 5_000 };

/** N 번째 observeActivation 호출에서 멈춘다. */
class GatedNthObserve extends FakeEffects {
  entered: Promise<void>;
  private enter!: () => void;
  private gate: Promise<void>;
  open!: () => void;
  private calls = 0;
  constructor(private readonly gateAt: number) {
    super();
    this.entered = new Promise((r) => { this.enter = r; });
    this.gate = new Promise((r) => { this.open = r; });
  }
  override async observeActivation(): Promise<ActivationEvidence | undefined> {
    this.calls += 1;
    if (this.calls === this.gateAt) {
      this.enter();
      await this.gate;
    }
    return super.observeActivation();
  }
}

it('낡은 러너의 awaitActivation 지연 관측이 신임 저널에 증거를 써넣지 못한다', async () => {
  const store = new MemoryStore();
  const zero = { epoch: '0', rev: '0' };
  const one = { epoch: '1', rev: '1' };

  const oldAgent = new DpAgent(store);
  // 관측 1(진입 관측)은 통과(아직 acceptingGeneration 없음 → undefined),
  // 관측 2(awaitActivation)에서 멈춘다. 그 사이 reloadAttempts 쓰기와 HUP 이 나간다.
  const gate = new GatedNthObserve(2);
  const x10 = OP('X', '10', 'gen-old', zero, one);
  const old = new ApplyRunner(oldAgent, gate, FAST).run(x10).catch((e: unknown) => e);
  await gate.entered; // 낡은 러너: reload 신호까지 끝내고 관측에 산 채로 걸렸다

  // 승계 + 같은 id 재발급
  const newAgent = new DpAgent(store);
  await newAgent.fence('11');
  const x11 = OP('X', '11', 'gen-new', zero, one);
  for (const plane of ['http', 'stream'] as const) await newAgent.release(tupleFor(x11, plane));
  await newAgent.reserveAll(x11, { op: x11, phase: 'preflight', reloadAttempts: 0, progress: {} });
  const before = newAgent.readJournal();

  gate.open();
  const res = await old;

  const j = new DpAgent(store).readJournal();
  expect(
    { token: j?.op.leaderToken, evidence: j?.evidence?.acceptingGeneration, seq: j?.seq },
    '낡은 러너가 신임 저널에 자기 관측(gen-old)을 써넣었다 — 토큰이 저널(피해자)의 것이라 전부 통과한다',
  ).toEqual({ token: '11', evidence: undefined, seq: before?.seq });
  // 낡은 러너 자신은 조용히 물러났어야 한다 (예외가 아니라 no_operation)
  expect((res as { phase?: string }).phase).toBe('no_operation');
});
