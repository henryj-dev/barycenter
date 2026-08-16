/**
 * 35차 검수 후보 — C 재현 시도.
 *
 * 주장: `apply.ts` 의 두 자리(driveInner 의 `mine` 판정 · driveLoop 의 소유 검사)가
 * 토큰을 안 보고 id 만 비교한다. 그래서 낡은 러너(bound=X/10)가 EffectTimeout 을 맞을 때
 * 신임이 재발급한 같은 id 의 저널(X/11)을 "제 것" 으로 읽고 failAll 한다.
 *
 * 경로 (전부 공개 표면):
 *   1. 낡은 러너: run(X/10) → publish 에서 매달린다 (예산 600ms).
 *   2. 신임: fence('11') — 낡은 홀더가 supersede 되고 저널 X/10 은 'superseded' 로 닫힌다.
 *   3. 신임: run(Y/11) 완주 — 저널이 Y 로 밀려난다 (reserveAll 의 저널 개방 분기도
 *      id 만 보므로, 같은 id 재발급이 새 저널을 얻으려면 사이에 다른 id 가 필요하다).
 *   4. 신임: release(X/11 튜플) — x10 이 남긴 completed 캐시(우연한 방패)를 지운다.
 *      release 의 문서가 바로 이 용도다: "같은 operationId 로 다시 시도할 수 있어야 한다".
 *   5. 신임: run(X/11) — 같은 id 재발급. 저널 X/11 'publish_intent' 에서 자기 publish
 *      게이트에 멈춰 **진행 중**이다.
 *   6. 낡은 러너의 예산이 끝난다 → driveInner catch → mine 판정이 id 만 비교 →
 *      failAll(신임 저널). 이때 쓰는 토큰은 **저널에서 읽은 신임 토큰**이라
 *      assertLeader 도 writeJournal 도 전부 통과한다.
 */
import { expect, it } from 'vitest';
import { DpAgent, DpRejection, MemoryStore, tupleFor } from '../../src/dp/agent.js';
import { ApplyRunner, FakeEffects } from '../../src/dp/apply.js';
import type {
  ApplyLease, ApplyOperation, Checked, PublishRecord,
} from '../../src/dp/operation.js';

const OP = (
  id: string,
  token: string,
  gen: string,
  from: { epoch: string; rev: string },
  to: { epoch: string; rev: string },
): ApplyOperation => ({
  leaderToken: token,
  operationId: id,
  transitionId: id,
  affectedPlanes: ['http', 'stream'],
  targetGeneration: gen,
  generationDigest: `sha256:${gen}`,
  planes: {
    http: {
      expectedCurrent: { activationEpoch: from.epoch, membershipRevision: from.rev },
      target: { activationEpoch: to.epoch, membershipRevision: to.rev },
      payloadDigest: `sha256:h-${gen}`,
    },
    stream: {
      expectedCurrent: { activationEpoch: from.epoch, membershipRevision: from.rev },
      target: { activationEpoch: to.epoch, membershipRevision: to.rev },
      payloadDigest: `sha256:s-${gen}`,
    },
  },
});

const FAST = { attempts: 1, intervalMs: 0, sleep: async () => {}, effectTimeoutMs: 5_000 };

/** publish 에 들어간 것을 알리고 영영 안 돌아온다 — 낡은 러너용. */
class HangingPublish extends FakeEffects {
  entered: Promise<void>;
  private enter!: () => void;
  constructor() {
    super();
    this.entered = new Promise((r) => { this.enter = r; });
  }
  override async publish(): Promise<Checked> {
    this.enter();
    return new Promise<Checked>(() => undefined);
  }
}

/** publish 에 들어간 것을 알리고 게이트가 열릴 때까지 기다린다 — 신임 러너용. */
class GatedPublish extends FakeEffects {
  entered: Promise<void>;
  private enter!: () => void;
  private gate: Promise<void>;
  open!: () => void;
  constructor() {
    super();
    this.entered = new Promise((r) => { this.enter = r; });
    this.gate = new Promise((r) => { this.open = r; });
  }
  override async publish(record: PublishRecord, lease: ApplyLease): Promise<Checked> {
    this.enter();
    await this.gate;
    return super.publish(record, lease); // lease.assertValid() 는 여기서 돈다
  }
}

const kindOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return '통과';
  } catch (e) {
    return e instanceof DpRejection ? `${e.kind}:${e.terminalState ?? ''}` : (e as Error).name;
  }
};

it('C — 낡은 러너의 EffectTimeout 이 같은 id 로 재발급된 신임 전환을 failed 로 닫는다', async () => {
  const store = new MemoryStore();
  const oldAgent = new DpAgent(store);
  const newAgent = new DpAgent(store);

  // 1. 낡은 러너 X/10 이 publish 에서 매달린다. 예산 600ms — 그 안에 신임이 들어온다.
  const oldFx = new HangingPublish();
  const x10 = OP('X', '10', 'gen-x10', { epoch: '0', rev: '0' }, { epoch: '1', rev: '1' });
  const stuck = new ApplyRunner(oldAgent, oldFx, { ...FAST, effectTimeoutMs: 600 })
    .run(x10)
    .catch((e: unknown) => e);
  await oldFx.entered;

  // 2. 승계. 낡은 홀더는 supersede — 저널 X/10 은 'superseded' 로 닫히고 슬롯이 풀린다.
  await newAgent.fence('11');

  // 3. 신임의 다른 작업 Y/11 이 완주해 저널을 밀어낸다.
  const y = OP('Y', '11', 'gen-y', { epoch: '0', rev: '0' }, { epoch: '1', rev: '1' });
  const yResult = await new ApplyRunner(newAgent, new FakeEffects(), FAST).run(y);
  expect(yResult.phase, '전제: Y 가 정상 완주한다').toBe('activated');

  // 4. 같은 id 'X' 를 다시 쓰기 위한 정리 — release 의 문서화된 용도 그대로다.
  const x11 = OP('X', '11', 'gen-x11', { epoch: '1', rev: '1' }, { epoch: '2', rev: '2' });
  await newAgent.release(tupleFor(x11, 'http'));
  await newAgent.release(tupleFor(x11, 'stream'));

  // 5. 신임이 같은 id 를 새 토큰으로 재발급하고, 자기 publish 게이트에서 **진행 중**이다.
  const newFx = new GatedPublish();
  const newRun = new ApplyRunner(newAgent, newFx, FAST).run(x11).catch((e: unknown) => e);
  await newFx.entered;

  // 전제 확인: 신임 저널 X/11 이 비종단으로 열려 있고, 실행권도 신임 것이다.
  expect(
    {
      journalOp: newAgent.readJournal()?.op.operationId,
      journalToken: newAgent.readJournal()?.op.leaderToken,
      phase: newAgent.readJournal()?.phase,
      holderToken: newAgent.activeOperation()?.leaderToken,
      terminalHttp: newAgent.terminalOf(tupleFor(x11, 'http')),
    },
    '전제: 신임 전환 X/11 이 진행 중이다',
  ).toEqual({
    journalOp: 'X',
    journalToken: '11',
    phase: 'publish_intent',
    holderToken: '11',
    terminalHttp: undefined,
  });

  // 6. 낡은 러너의 예산이 끝난다. **여기가 판정 지점이다.**
  const oldResult = await stuck;

  // **낡은 러너는 남의 저널이므로 물러난다** — 12차 반례 ① 의 계약.
  //
  // 고치기 전에는 id 만 비교하는 `mine` 판정이 신임 저널을 "제 것" 으로 읽고 `failAll`
  // 했다. 그때 쓰는 토큰이 저널의 것(= 피해자의 것)이라 `assertLeader` 도 `writeJournal`
  // 도 `finishOperation` 도 전부 통과한다 — **아무도 못 막았다.**
  expect(
    {
      oldPhase: (oldResult as { phase?: string }).phase,
      oldFailure: (oldResult as { failure?: string }).failure?.slice(0, 30),
      journalPhase: newAgent.readJournal()?.phase,
      journalToken: newAgent.readJournal()?.op.leaderToken,
      terminalHttp: newAgent.terminalOf(tupleFor(x11, 'http')),
      terminalStream: newAgent.terminalOf(tupleFor(x11, 'stream')),
      holder: newAgent.activeOperation(),
      slotHttp: newAgent.reservationOwner('http', '2'),
    },
    '낡은 러너가 진행 중인 신임 전환을 통째로 닫았다',
  ).toEqual({
    oldPhase: 'no_operation',        // 남의 저널이라 할 일이 없다
    oldFailure: expect.stringContaining('publish'),
    journalPhase: 'publish_intent',  // 신임의 전환은 진행 중 그대로다
    journalToken: '11',
    terminalHttp: undefined,
    terminalStream: undefined,
    holder: expect.objectContaining({ leaderToken: '11' }),
    slotHttp: expect.objectContaining({ leaderToken: '11' }),
  });

  // 7. **신임은 자기 전환을 끝까지 민다.**
  //
  // 고치기 전에는 슬롯이 이미 지워져 자기 publish 의 `lease.assertValid()` 에서
  // `not_reserved` 로 쫓겨났다. 그리고 그 뒤가 더 나빴다 — `terminal` 은 안 잘리므로
  // **그 operationId:transitionId 가 영구 봉쇄**됐다(`admit` 이 영원히 거부한다).
  // 부작용 하나 못 낸 정당한 전환이 이름째 죽는 것이다.
  newFx.open();
  const newOutcome = await newRun;
  expect(
    newOutcome instanceof DpRejection ? newOutcome.kind : (newOutcome as { phase?: string }).phase,
    '신임 러너가 자기 전환에서 쫓겨났다',
  ).toBe('activated');
});
