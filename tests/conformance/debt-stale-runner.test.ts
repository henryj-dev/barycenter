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
  ActivationEvidence, ApplyLease, ApplyOperation, Checked, PublishRecord,
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

/** 활성화 **관측**에서 멈춘다 — 토큰이 없는 경로라 낡은 러너가 fence 를 산 채로 건넌다. */
class GatedObserve extends FakeEffects {
  entered: Promise<void>;
  private enter!: () => void;
  private gate: Promise<void>;
  open!: () => void;
  constructor() {
    super();
    this.entered = new Promise((r) => { this.enter = r; });
    this.gate = new Promise((r) => { this.open = r; });
  }
  override async observeActivation(): Promise<ActivationEvidence | undefined> {
    this.enter();
    await this.gate;
    return super.observeActivation();
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

/**
 * **CE-35-A — 한 함수 안에서 두 신원 비교가 갈렸다** (35차 검수)
 *
 * `reserveAll` 에는 신원 비교가 셋이다. 빚갚기가 **청소**(고아 저널 정리)만 `ownsJournal`
 * 로 바꾸고 **개방**(저널 이어받기)을 빠뜨렸다. 그러면 같은 호출 안에서:
 *
 * ```
 * 청소  ownsJournal → "남의 것" → supersede
 * 개방  id 만       → "내 것"   → 새 저널을 안 연다
 * ```
 *
 * 그 뒤 `driveLoop` 은 (34차 C 수정으로 토큰을 보게 되어) 그 옛 저널을 "남의 것" 으로
 * 읽고 물러난다. 결과는 `no_operation` **인데 예약은 잡혀 있다** — 진단이 거짓이고,
 * 같은 좌표를 미는 다른 오퍼레이션이 `slot_taken` 으로 죽는다.
 *
 * **C 수정이 이 불일치를 실체화했다.** 그래서 수정 유도 결함이다. 그리고 이 재현은
 * `driveLoop` 의 토큰 비교도 함께 밟는다 — 그 자리는 `debt-stale-runner` 의 앞 시나리오가
 * 안 밟아서 **검출력이 0 이었다**(35차 실측).
 *
 * 위 "낡은 러너" 시나리오와 달리 **중간에 다른 id 를 끼우지 않는다.** 끼우면 저널이
 * 밀려나 이 자리를 안 지나간다 — `debt-completed-prune` 의 같은-id 재발급 테스트가
 * 그래서 통과했고, 그 제목이 거짓이었다.
 */
it('CE-35-A — fence 뒤 같은 id 재발급이 중간 오퍼레이션 없이도 자리를 잡는다', async () => {
  const store = new MemoryStore();
  const zero = { epoch: '0', rev: '0' };
  const one = { epoch: '1', rev: '1' };

  // 1. 낡은 러너가 publish 에서 매달린다.
  const oldAgent = new DpAgent(store);
  const oldFx = new HangingPublish();
  const x10 = OP('X', '10', 'gen-1', zero, one);
  const stuck = new ApplyRunner(oldAgent, oldFx, { ...FAST, effectTimeoutMs: 600 })
    .run(x10).catch((e: unknown) => e);
  await oldFx.entered;

  // 2. 신임이 fence — 저널 X/10 은 superseded 로 닫히고 슬롯·홀더가 반납된다.
  const newAgent = new DpAgent(store);
  await newAgent.fence('11');
  expect(newAgent.readJournal()?.phase, '전제: 저널이 종단으로 닫혔다').toBe('superseded');

  // 3. 같은 id 를 새 토큰으로 재발급한다. **중간 오퍼레이션을 안 끼운다.**
  //    옛 캐시가 시끄럽게 막으므로 문서화된 처방(`release`)으로 지운다.
  const x11 = OP('X', '11', 'gen-1', zero, one);
  for (const plane of ['http', 'stream'] as const) {
    await newAgent.release(tupleFor(x11, plane));
  }
  const result = await new ApplyRunner(newAgent, new FakeEffects(), FAST).run(x11)
    .catch((e: unknown) => e);

  const after = new DpAgent(store);
  expect(
    {
      phase: result instanceof DpRejection ? result.kind : (result as { phase?: string }).phase,
      journalOp: after.readJournal()?.op.operationId,
      journalToken: after.readJournal()?.op.leaderToken,
      coordinate: after.coordinate('http').activationEpoch,
      slot: after.reservationOwner('http', '1')?.leaderToken,
    },
    '개방 분기가 옛 저널을 "내 것" 으로 읽어 자리를 못 잡았다 — 진단은 no_operation 인데 예약이 남는다',
  ).toEqual({
    phase: 'activated',
    journalOp: 'X',
    journalToken: '11',
    coordinate: '1',
    slot: undefined,
  });

  await stuck;
});

/**
 * **낡은 러너가 루프를 계속 돌 때** (35차 검수 3-A)
 *
 * 34차 C 수정은 두 자리를 고쳤다 — `driveInner` 의 catch 와 `driveLoop` 의 소유 검사.
 * 그런데 재현이 밟은 것은 **앞의 하나뿐**이었다: 낡은 러너가 매달려 있으면 루프를 안
 * 돌고 바로 catch 로 간다. 35차가 실측했다 — `driveLoop` 을 id-only 로 되돌려도 전
 * 스위트가 초록이었다. **커밋은 두 자리를 고쳤다고 적었는데 재현이 지킨 것은 한 자리다.**
 *
 * 여기서는 낡은 러너가 **게이트에서 풀려 루프를 계속 돈다.** 그 사이 신임이 같은 id 로
 * 자기 저널을 열어 놨다. id 만 보면 낡은 러너가 **신임의 저널을 계속 몬다** — 8차 반례
 * ③ 이 지목한 그것이다("옛 러너가 신임 오퍼레이션을 대신 끝까지 몰았다").
 */
// **제목을 고쳤다** (36차 검수). 전에는 "낡은 러너가 루프를 돌아도" 였는데 **거짓이다** —
// 러너는 루프에 못 돌아오고 publish 안 `lease.assertValid()` 에서 `stale_leader` 로 죽는다.
// 그래서 이 테스트는 `driveLoop` 의 소유 검사에 **검출력이 0** 이다(36차 실측).
// 지금 지키는 것은 "게이트에 걸린 낡은 러너가 승계 뒤 신임 저널을 안 건드린다" 뿐이다.
it('게이트에 걸린 낡은 러너는 승계된 저널을 건드리지 않는다', async () => {
  const store = new MemoryStore();
  const zero = { epoch: '0', rev: '0' };
  const one = { epoch: '1', rev: '1' };

  const oldAgent = new DpAgent(store);
  const gate = new GatedPublish();
  const x10 = OP('X', '10', 'gen-1', zero, one);
  const old = new ApplyRunner(oldAgent, gate, FAST).run(x10).catch((e: unknown) => e);
  await gate.entered;

  // 신임이 승계하고 같은 id 로 자기 저널을 연다.
  const newAgent = new DpAgent(store);
  await newAgent.fence('11');
  const x11 = OP('X', '11', 'gen-1', zero, one);
  for (const plane of ['http', 'stream'] as const) await newAgent.release(tupleFor(x11, plane));
  await newAgent.reserveAll(x11, {
    op: x11, phase: 'preflight', reloadAttempts: 0, progress: {},
  });
  expect(newAgent.readJournal()?.op.leaderToken, '전제: 신임 저널이 열렸다').toBe('11');

  // 게이트를 연다 — 낡은 러너가 루프로 돌아온다.
  gate.open();
  const oldResult = await old;

  const after = new DpAgent(store);
  expect(
    {
      old: oldResult instanceof DpRejection ? oldResult.kind : (oldResult as { phase?: string }).phase,
      journalToken: after.readJournal()?.op.leaderToken,
      journalOwner: after.readJournal()?.op.operationId,
      holderToken: after.activeOperation()?.leaderToken,
    },
    '낡은 러너가 신임의 저널을 계속 몰았다 — 8차 반례 ③ 의 재발이다',
  ).toMatchObject({
    journalToken: '11',
    journalOwner: 'X',
    holderToken: '11',
  });

  await old;
});

/**
 * **CE-36-A — 같은 병의 세 번째 자리** (36차 검수)
 *
 * `apply.ts` 의 증거 쓰기 자리는 주석이 **"내 저널에만 쓴다"**(8차 반례 ③)인데 정작
 * **id 만 비교한다.** 34차 C 가 이 병형("쓰는 토큰이 저널의 것 — 피해자의 것")을 두
 * 자리에서 고치면서 **이 자리를 안 셌고**, 35차의 전수 조사도 놓쳤다.
 *
 * 그리고 이 재현은 35차에 내가 적은 **"동치" 주장이 거짓임**을 보인다. 나는
 * *"fence 뒤에는 낡은 토큰의 쓰기가 agent 층에서 전부 `stale_leader` 로 막히므로 낡은
 * 러너는 그 검사에 닿기 전에 죽는다"* 고 적었다. **`awaitActivation` 은 토큰이 없는
 * 관측 경로다** — 낡은 러너는 거기서 fence 를 **산 채로 건넌다.** 뮤테이션이 아무도
 * 안 죽인 것은 "도달 불가" 가 아니라 **"스위트가 못 가른다"** 였다. 그 둘을 뒤바꾸는
 * 것이 이 레포가 반복해 앓은 병이고, 나는 그 병을 안다고 적은 회차에서 그것을 했다.
 *
 * **다만 증거 오염까지는 내 손으로 재현 못 했다.** 이 시나리오에서 낡은 러너는 게이트를
 * 건넌 **뒤 첫 쓰기**에서 `stale_leader` 로 죽는다. 검수자는 다른 배치로 오염을 봤다고
 * 적었고 나는 그 배치를 못 만들었다 — **못 연 것이지 없는 것이 아니다.**
 *
 * 그래서 이 테스트가 지금 지키는 것은 **"낡은 러너가 fence 를 산 채로 건너도 신임
 * 저널이 오염되지 않는다"** 이고, 그 이상을 주장하지 않는다.
 */
it('CE-36-A — 낡은 러너의 지연 관측이 남의 저널에 실리지 않는다', async () => {
  const store = new MemoryStore();
  const zero = { epoch: '0', rev: '0' };
  const one = { epoch: '1', rev: '1' };

  const oldAgent = new DpAgent(store);
  const gate = new GatedObserve();
  const x10 = OP('X', '10', 'gen-old', zero, one);
  // 세상이 옛 세대를 받아들였다고 보고하게 한다 — 그래야 관측이 증거를 돌려주고
  // 쓰기가 일어난다. (처음엔 이걸 안 세워 관측이 `undefined` 를 돌려줬고, 테스트가
  // **아무것도 안 재면서 초록**이었다. 픽스처가 통과시킨 것의 또 다른 모양이다.)
  gate.acceptingGeneration = 'gen-old';
  const old = new ApplyRunner(oldAgent, gate, FAST).run(x10).catch((e: unknown) => e);
  await gate.entered;

  // 승계 — 낡은 러너는 관측 게이트에 **산 채로** 걸려 있다.
  const newAgent = new DpAgent(store);
  await newAgent.fence('11');
  const x11 = OP('X', '11', 'gen-new', zero, one);
  for (const plane of ['http', 'stream'] as const) await newAgent.release(tupleFor(x11, plane));
  await newAgent.reserveAll(x11, {
    op: x11, phase: 'preflight', reloadAttempts: 0, progress: {},
  });
  const seqBefore = newAgent.readJournal()?.seq;

  gate.open();
  await old;

  const j = new DpAgent(store).readJournal();
  expect(
    { token: j?.op.leaderToken, evidence: j?.evidence?.acceptingGeneration, seq: j?.seq },
    '낡은 러너가 신임 저널에 자기 관측을 써넣었다 — 쓰는 토큰이 피해자의 것이라 다 통과한다',
  ).toEqual({ token: '11', evidence: undefined, seq: seqBefore });
});
