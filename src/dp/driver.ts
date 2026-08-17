/**
 * `DataplaneDriver` — 정본 계약 (DESIGN.md §9.2 · §9.1.1 blocker 3)
 *
 * **하나의 봉투가 모든 변이를 지난다.**
 *
 * 5차 검수가 지목한 것: §9.2 의 설정 경로(prepare/commit/abort)에는 리더 토큰도
 * operation tuple 도 없었다. 멤버십만 튜플을 받았다. 그러면 설정 경로가 멤버십 튜플
 * **밖에서** 부작용을 낼 수 있다 — 옛 리더가 낸 세대가 그대로 활성화된다.
 *
 * 설정을 게시하고 HUP 을 보내는 것은 멤버십 못지않은 부작용이다. 오히려 더 크다.
 * 멤버십은 peer 하나를 바꾸지만 설정은 프로세스 전체를 바꾼다.
 *
 * v0.1 이 고정하는 것은 **설정 평면뿐이다** (§9.1.1). 멤버십 메서드는 §6.5 커서와 함께
 * v0.3 에서 이 인터페이스에 붙는다 — 구현하지 않은 계약을 먼저 고정했다가 5차 검수에서
 * 깨진 것이 그것이었다.
 */
import type {
  ApplyLease,
  ActivationEvidence,
  ApplyOperation,
  ApplyPhase,
  ApplyResult,
  Plane,
  PublishedState,
  PublishRecord,
} from './operation.js';
import { isTerminalPhase, CHECKED_TOKEN, planesOf, provesActivation } from './operation.js';
import { DpAgent, DpRejection, tupleFor, type DurableStore, type PlaneAck } from './agent.js';
import { ApplyRunner, type Effects } from './apply.js';

const sameRecord = (a: PublishRecord, b: PublishRecord): boolean =>
  a.generation === b.generation
  && a.generationDigest === b.generationDigest
  && a.operationId === b.operationId
  && a.transitionId === b.transitionId
  && a.leaderToken === b.leaderToken;

/** 평면의 현재 좌표. */
export type PlaneStatus = {
  activationEpoch: string;
  membershipRevision: string;
  payloadDigest: string;
};

export type DriverStatus = {
  maxLeaderToken: string;
  planes: Record<Plane, PlaneStatus>;
  /**
   * 지금 게시된 것과 **그것이 누구 것인지**.
   *
   * 세대 이름만 노출하면 컨트롤 플레인이 "내가 믿는 것과 실제가 갈라졌다" 를 볼 수 없다.
   */
  published: PublishedState;
  /** 마지막으로 관측한 활성화 증거. */
  lastEvidence: ActivationEvidence | undefined;
  /**
   * **끝나지 않은 전환이 있는가** (19차 검수).
   *
   * 없으면 컨트롤 플레인이 apply 봉쇄를 볼 창구가 `applyConfig` 실패뿐이다 — 끊긴 러너가
   * 실행권을 쥐고 있으면 모든 apply 가 `operation_in_flight` 로 막히는데, `status()` 는
   * 그걸 안 보여줬다. `reconcileConfig` 가 `unfinished` 로 답하는 것과 같은 사실을
   * **묻지 않고도** 보게 한다.
   *
   * 여기 값이 있으면 `recoverConfig()` 를 부르면 된다.
   */
  unfinished: PublishRecord | undefined;
};

/**
 * DP 를 조작하는 **유일한** 표면.
 *
 * 모든 메서드가 봉투를 받는다. 봉투 없이 부작용을 내는 경로는 없어야 한다.
 */
export interface DataplaneDriver {
  /**
   * §3.5 — 신임 리더는 **어떤 operation 보다 먼저** 이걸 끝낸다.
   * 이게 ACK 되기 전에 낸 변이는 전부 거부된다.
   */
  fence(leaderToken: string): Promise<{ maxToken: string }>;

  /**
   * 설정 세대를 활성화한다. 게시 → staging → HUP → 활성화 판정 → 좌표 이동.
   *
   * **재진입 가능해야 한다.** 같은 `ApplyOperation` 으로 다시 부르면 진행된 만큼은
   * 건너뛰고 남은 것만 한다 (§6.2). 크래시 후 복구가 그렇게 이어받는다.
   */
  applyConfig(op: ApplyOperation): Promise<ApplyResult>;

  /**
   * 진행 중이던 오퍼레이션을 이어받는다. 저널에 없으면 `no_operation`.
   * 인자가 없는 이유는 **무엇을 하던 중이었는지도 저널이 안다**는 것이 계약이기 때문이다.
   */
  recoverConfig(): Promise<ApplyResult>;

  /**
   * 전환을 포기한다. 예약한 슬롯을 반납하고 전환을 종단 상태로 닫는다.
   * 이미 활성화된 것을 되돌리지는 **않는다** — 롤백은 새 활성화 사건이다 (§3.3).
   *
   * **오퍼레이션을 통째로 받는다.** 봉투와 epoch 만 받아 튜플을 재구성하면 정본 튜플이
   * 달라져 슬롯의 주인으로 인정받지 못한다 — 그러면 abort 가 아무것도 못 지운다.
   */
  abortConfig(op: ApplyOperation): Promise<void>;

  /**
   * **활성 epoch 안에서 멤버십만 옮긴다** (§6.5 · v0.3).
   *
   * §9.1.1 이 v0.1 에서 미룬 그 메서드다 — *"구현하지 않은 계약을 먼저 고정했다가 5차
   * 검수에서 깨진 것이 그것이었다"*. 이제 구현과 함께 붙인다.
   *
   * 설정 경로와 다른 점은 **reload 가 없다**는 것이다. 좌표는 `membership_revision` 만
   * 앞으로 가고 `activation_epoch` 는 그대로다 — 그래서 세대 전환도, HUP 도, 워커 재생성도
   * 없다. S1 이 HTTP·TCP·UDP 전부에서 실증한 경로이고 이 제품의 이유다.
   *
   * 좌표 CAS 는 설정 경로와 **같은 심판**을 지난다 (§3.5 — DP Agent 가 최종 심판이다).
   * 옛 리더의 늦은 멤버십 갱신은 토큰에서 막힌다.
   */
  applyMembership(
    op: ApplyOperation, plane: Plane, slots: Record<string, string[]>,
  ): Promise<PlaneAck>;

  /**
   * 슬롯을 그대로 밀어 넣는다 — **좌표를 안 옮긴다** (§6.4 재시작 복원).
   *
   * 새 전환이 아니라 **잃어버린 것을 되돌려 놓는 것**이다. shared dict 는 프로세스
   * 수명이라 엔진 재시작에 통째로 비는데, 그건 상태가 *바뀐* 것이 아니라 *사라진* 것이다.
   * 좌표를 옮기면 있지도 않은 전환을 발명하게 된다.
   */
  pushMembershipDirect(plane: Plane, epoch: string, slots: Record<string, string[]>): Promise<void>;

  /** 지금 상태. 읽기 전용이라 봉투가 필요 없다. */
  /**
   * **종단 뒤에도 도는 수렴** (10차 검수).
   *
   * 러너는 유한하다 — `activated` 로 끝나면 더 보지 않는다. 그런데 옛 writer 는 그
   * 뒤에도 착지할 수 있고, 그러면 `current` 가 조용히 옛 세대를 가리킨 채 남는다.
   * 컨트롤 플레인이 이걸 주기적으로 불러야 "덮여서 수렴한다" 가 성립한다.
   *
   * **전제.** 옛 writer 가 언젠가는 멈춘다. 영원히 살아 있는 옛 리더와는 서로 덮어쓰기만
   * 반복한다 — 그건 리더 선출이 보장할 몫이지 여기서 할 수 있는 일이 아니다.
   */
  reconcileConfig(): Promise<ReconcileResult>;

  status(): Promise<DriverStatus>;
}

/**
 * 한 스냅샷 안에서 **끝나지 않은 전환**을 읽는다.
 *
 * 방향이 반대인 둘을 본다. 둘 다 "복구를 부르면 끝난다" 다.
 *   · 활성화가 끝났는데 기준으로 안 올라간 후보 (17차 A)
 *   · 시작했는데 안 끝난 오퍼레이션 — 비종단 저널이 남아 있다 (19차 #1)
 */
function unfinishedIn(view: {
  pendingActivation: PublishRecord | undefined;
  journal: { phase: ApplyPhase; op: ApplyOperation } | undefined;
}): PublishRecord | undefined {
  if (view.pendingActivation !== undefined) return view.pendingActivation;
  const j = view.journal;
  if (j === undefined || isTerminalPhase(j.phase)) return undefined;
  return {
    generation: j.op.targetGeneration,
    leaderToken: j.op.leaderToken,
    operationId: j.op.operationId,
    transitionId: j.op.transitionId,
    generationDigest: j.op.generationDigest,
  };
}

/** `#settled` 의 답. **왜 아닌지**까지 말한다. */
type SettleCheck =
  | { kind: 'settled'; proof: Settled }
  /** 끝나지 않은 전환이 있다 — 복구를 부르면 끝난다. */
  | { kind: 'unfinished'; pending: PublishRecord }
  /** 기준이 그 사이 옮겨 갔다 — 새 기준으로 다시 본다. */
  | { kind: 'moved' };

declare const SETTLED_BRAND: unique symbol;

/**
 * **"판정 직전에 다시 봤다" 는 표** (18차 검수 뒤).
 *
 * 열 회차 동안 같은 모양으로 물렸다 — 믿을 수 없는 상태를 하나 새로 만들고, 그걸 **판정
 * 자리 전부에** 넣는 것을 잊는다. 14차에 "읽고-확인" 집합을 만들었는데 17차가 거기에
 * 후보를 안 넣었고, 18차가 그 구멍을 찾았다.
 *
 * "잊지 말자" 는 계약이 아니다. `Checked` 로 lease 를 강제한 것과 같은 수법을 쓴다 —
 * **`converged`·`repaired` 는 이 표 없이 만들 수 없다.** 표는 `#settled` 만이 만들고,
 * `#settled` 는 기준과 미완 활성화를 **둘 다** 본다. 새로 봐야 할 것이 생기면 거기 한
 * 곳에만 넣으면 된다.
 */
type Settled = { readonly [SETTLED_BRAND]: true };
const SETTLED: Settled = Object.freeze({}) as Settled;

/** 수렴했다고 답한다. **표가 있어야 한다.** */
const converged = (record: PublishRecord, _proof: Settled): ReconcileResult =>
  ({ kind: 'converged', record });

/** 되돌렸다고 답한다. **표가 있어야 한다.** */
const repaired = (
  expected: PublishRecord,
  found: PublishedState,
  _proof: Settled,
): ReconcileResult => ({ kind: 'repaired', expected, found });

/** 부작용 하나에 주는 예산. */
const RECONCILE_EFFECT_MS = 10_000;

/**
 * `reconcileConfig` 한 번의 마감.
 *
 * apply 와 같은 큐에서 돌므로 여기 머무는 시간이 곧 apply 가 막히는 시간이다. 라운드
 * 3 회 × 부작용 여러 개면 부작용별 예산만으로는 2 분을 넘길 수 있다 (14차 검수).
 */
const RECONCILE_TOTAL_MS = 30_000;

export type ReconcileResult =
  /** 되돌릴 기준이 없다 — 게시한 적도 활성화한 적도 없다. */
  | { kind: 'no_baseline' }
  /**
   * **되돌릴 기준을 보증할 수 없다.** 출신이 둘이다.
   *
   * ① **게시는 나갔는데 활성화하지 못했다** (12차 반례 ②). 무엇으로 되돌려야 하는지
   *    DP 는 모른다 — 그 게시가 좋은 것인지 판단할 근거가 없다. 조용히 `no_baseline`
   *    이라고 답하는 대신 이 상태를 드러내고 컨트롤 플레인이 정하게 한다.
   *
   * ② **기준이 폐위됐다** (31차 CE-31). 좌표가 기준을 지나쳤는데(세상이 앞으로 갔다)
   *    그것을 어느 전환의 공로로도 셀 수 없으면, 옛 기준을 권위로 남기면 안 된다 —
   *    수렴이 그것으로 **서빙 중인 세대를 되감기** 때문이다. 그래서 기준을 지우고
   *    여기로 온다. 33차가 이 출신을 문서에 안 적었다고 지적했다: 18차에 의미 과적으로
   *    한 번 물린 자리라 출신을 갈라 적는다.
   *
   * ⚠️ **`intent` 는 "되돌릴 곳" 이 아니다.** ② 로 온 경우 `intent` 는 폐위 이전의
   * **낡은** 세대를 실어 나른다. 그것을 복원 목표로 읽으면 운영자가 손으로 되감게 된다 —
   * 코드가 안 하려고 폐위한 바로 그 일이다. `intent` 는 **마지막으로 게시하려 한 것**의
   * 기록이지 목표가 아니다.
   */
  | { kind: 'dirty'; intent: PublishRecord; found: PublishedState }
  /**
   * **활성화는 끝났는데 아직 기준으로 올라가지 않았다** (18차 검수).
   *
   * 17차에 이 상태를 `dirty` 에 실었다가 지적받았다. `dirty` 는 "무엇으로 되돌릴지 DP 가
   * 모르니 **네가 정해라**" 이고, 이건 "**복구를 부르면 끝난다**" 다 — 운영자가 할 일이
   * 다른데 호출자가 구분할 수 없었다. 타입이 아니라 **의미**가 움직인 것이라 표면 해시도
   * 못 잡았다.
   *
   * 갈라 둔다. 여기 오면 `recoverConfig()` 를 부르고 다시 수렴하면 된다.
   *
   * **양쪽을 다 담는다** (19차 반례 #1). 17차에는 "활성화가 끝났는데 안 올라간 후보" 만
   * 봤는데, 정반대 쪽 — "시작했는데 안 끝난 오퍼레이션"(끊긴 러너의 비종단 저널과
   * 실행권) — 은 `converged` 로 가려졌다. 그 상태에서는 apply 경로가 봉쇄고 복구 한 번이면
   * 기준이 바뀐다. 둘 다 **"복구를 부르면 끝난다"** 이므로 한 변종이 맞다.
   */
  | { kind: 'unfinished'; pending: PublishRecord; found: PublishedState }
  /** 게시가 기준과 같다. 아무것도 하지 않았다. */
  | { kind: 'converged'; record: PublishRecord }
  /** 갈라져 있었고 다시 게시했다. */
  | { kind: 'repaired'; expected: PublishRecord; found: PublishedState }
  /** 다시 게시했는데도 기준과 다르다 — 옛 writer 가 아직 살아 있다. */
  | { kind: 'diverged'; expected: PublishRecord; found: PublishedState };

// ── 참조 구현 ────────────────────────────────────────────────────────────

/**
 * 같은 프로세스 안의 DP Agent 에 붙는 구현.
 *
 * **인터페이스만 두고 구현을 미루지 않는다.** 구현하지 않은 계약을 먼저 고정했다가
 * 5차 검수에서 깨진 것이 멤버십이었다 (§9.1). 계약은 구현과 함께 선다.
 */
export class LocalDataplaneDriver implements DataplaneDriver {
  private constructor(
    private readonly agent: DpAgent,
    private readonly effects: Effects,
  ) {}

  /**
   * **공개 표면만으로 만들 수 있어야 한다** (7차 반례 ④).
   *
   * 전에는 생성자가 `DpAgent` 를 받았는데 그건 공개 표면이 아니다 — 계약을 내보내 놓고
   * 그 계약을 만들 방법을 안 준 셈이었다. Agent 는 드라이버 뒤에 있고, 호출자는
   * 저장소와 부작용만 고르면 된다.
   */
  static create(opts: { store: DurableStore; effects: Effects }): LocalDataplaneDriver {
    return new LocalDataplaneDriver(new DpAgent(opts.store), opts.effects);
  }

  #runner(): ApplyRunner {
    return new ApplyRunner(this.agent, this.effects);
  }

  fence(leaderToken: string): Promise<{ maxToken: string }> {
    return this.agent.fence(leaderToken);
  }

  applyConfig(op: ApplyOperation): Promise<ApplyResult> {
    return this.#runner().run(op);
  }

  async applyMembership(
    op: ApplyOperation, plane: Plane, slots: Record<string, string[]>,
  ): Promise<PlaneAck> {
    const target = op.planes[plane];
    if (target === undefined) {
      throw new DpRejection('envelope_mismatch', `평면 '${plane}' 의 목표가 없다`);
    }
    if (this.effects.pushMembership === undefined) {
      throw new Error('이 배포는 멤버십 평면을 쓸 수 없다 (pushMembership 없음)');
    }
    // **좌표를 먼저 옮긴다.** 부작용이 먼저 나가면, 좌표 CAS 가 거부됐을 때 이미 슬롯이
    // 바뀐 뒤다 — 옛 리더가 남긴 값이 그대로 서빙된다. Agent 가 최종 심판이므로 그
    // 심판을 지나기 전에는 아무것도 안 민다 (§3.5).
    const ack = await this.agent.applyHealth(tupleFor(op, plane), slots);
    await this.effects.pushMembership(plane, target.target.activationEpoch, slots);
    return ack;
  }

  async pushMembershipDirect(
    plane: Plane, epoch: string, slots: Record<string, string[]>,
  ): Promise<void> {
    if (this.effects.pushMembership === undefined) {
      throw new Error('이 배포는 멤버십 평면을 쓸 수 없다');
    }
    await this.effects.pushMembership(plane, epoch, slots);
  }

  recoverConfig(): Promise<ApplyResult> {
    return this.#runner().recover();
  }

  async abortConfig(op: ApplyOperation): Promise<void> {
    // **오퍼레이션 단위다** (9차 반례 ⑤). 평면 하나가 이미 종단이라 거부해도 나머지
    // 정리를 멈추면 안 된다 — 부분 활성화 뒤 abort 가 그렇게 중단돼서 예약과 실행권이
    // 남았다. 각 평면의 거부는 모아서 끝에 알린다.
    const refused: string[] = [];
    for (const plane of planesOf(op)) {
      try {
        await this.agent.abort(tupleFor(op, plane));
      } catch (e) {
        if (!(e instanceof DpRejection)) throw e;
        refused.push(`${plane}: ${e.kind}`);
      }
    }
    // 실행권은 **어떤 경우에도** 놓는다. 안 놓으면 다음 오퍼레이션이 영영 막힌다.
    // **holder 가 잡은 평면 전부**를 기준으로 정리한다 (12차 반례 ④) — 넘어온 op 가
    // 한 평면만 담고 있으면 나머지 예약이 고아가 되고 다음 apply 가 slot_taken 된다.
    // **순서가 중요하다.** `finishOperation` 이 먼저 실행권을 지우면 그 뒤의 정리가
    // 무엇을 잡았는지 모르게 된다 — 실행권이 그 목록을 들고 있기 때문이다.
    await this.agent.releaseHolderSlots(op);
    await this.agent.finishOperation(op, planesOf(op));
    // **저널도 닫는다** (20차 CE-1). 계약이 "종단 상태로 닫는다" 인데 저널을 두고 가면
    // `unfinished` 가 죽은 전환을 살아 있다고 답하고 수리 경로를 막는다.
    //
    // **넘어간 평면이 있으면 `failed` 가 아니다** (21차 CE-C). 좌표를 보고 정한다 —
    // 15차에 `failAll` 에서 고친 §3.4 거짓말이 이 자리에서 재발했다. "다 실패했다" 고
    // 적으면 운영자는 http 가 새 세대로 서비스 중인 것을 못 본다.
    //
    // **여기서 세지 않는다** (23차 CE-A). 22차에 이 자리에서 직접 셌더니 호출자의 봉투를
    // 모수로 삼아, 한 평면짜리 봉투가 오면 나머지가 옛 세대인데도 "전부 넘어갔다" 가
    // 됐다. `reachedPhase()` 는 저널에서 평면 집합을 가져온다 — 넘길 수가 없으니
    // 잘못 넘길 수도 없다.
    // 폴백을 안 단다 (35차). **다만 그때 적은 근거의 첫 절이 거짓이었다**(36차 검수) —
    // "여기 오려면 저널이 있어야 한다" 는 틀렸다. 저널이 한 번도 없던 상태에서도
    // `abortConfig` 는 여기 **도달한다**. 폴백이 죽은 진짜 이유는 도달 불가가 아니라
    // **`closeJournal` 이 저널 없으면 어차피 no-op** 이라 무효과이기 때문이다.
    // 결론은 같지만 근거가 달랐고, 근거를 안 재고 적은 것이 병이다.
    // **24차와 25차에 같은 모양을 두 번 지우고 여기 세 번째를 남겼다** — 규칙을 세운
    // 사람이 그 규칙을 못 지키는 자리가 매번 하나씩 남는다.
    await this.agent.closeJournal(
      op,
      this.agent.reachedPhase() as 'activated' | 'partial_exhausted' | 'failed',
    );
    if (refused.length > 0) {
      throw new DpRejection('terminal', `일부 평면이 이미 끝나 있었다 — ${refused.join(', ')}`);
    }
  }

  async reconcileConfig(): Promise<ReconcileResult> {
    // **apply 와 같은 큐에서 돈다** (11차 반례 ②). 그래서 여기 오래 머무는 것은 그대로
    // apply 를 막는 것이다 — 마감을 호출 시작에서 한 번 정한다 (14차 검수).
    return this.agent.exclusiveApply(async () => {
      this.#deadline = Date.now() + RECONCILE_TOTAL_MS;
      try {
        return await this.#reconcileOnce();
      } finally {
        this.#deadline = undefined;
      }
    });
  }

  /** 이번 `reconcileConfig` 호출의 마감. 돌고 있지 않으면 `undefined`. */
  #deadline: number | undefined;

  /**
   * 한 바퀴 돈다. **기준이 바뀌면 처음부터 다시 본다** (12차 반례 ③) — 전에는 바뀐
   * 기준을 관측도 안 하고 `converged` 라고 답했다. 유한하게 돈다.
   */
  async #reconcileOnce(rounds = 3): Promise<ReconcileResult> {
    for (let i = 0; i < rounds; i += 1) {
      // **끝나지 않은 활성화가 있으면 기준을 믿을 수 없다** (17차 반례 A).
      //
      // 전 평면이 넘어갔는데 아직 기준으로 안 올라간 후보가 있으면, 좌표는 후보 쪽으로
      // 갔고 `lastActivated` 는 그 전 것으로 남아 있다. 그 상태에서 기준을 정답으로 읽으면
      // **이미 지나간 세대를 "수렴했다" 고 답한다.** 복구가 먼저 정리해야 하는 자리다.
      const unfinished = this.#unfinished();
      if (unfinished !== undefined) {
        return { kind: 'unfinished', pending: unfinished, found: await this.#observe() };
      }
      const expected = this.agent.lastActivated();
      if (expected === undefined) {
        const intent = this.agent.lastPublishIntent();
        if (intent === undefined) return { kind: 'no_baseline' };
        return { kind: 'dirty', intent, found: await this.#observe() };
      }

      const seen = await this.#observe();
      const activation = await this.#budget(() => this.effects.observeActivation());
      const pointerOk = seen.kind === 'owned' && sameRecord(seen.record, expected);
      const activeOk = provesActivation(activation, expected.generation);
      // **읽고-확인한다** (14차 검수). `expected` 를 읽고 두 번 await 한 뒤라 그 사이
      // 기준이 옮겨 갔을 수 있다. 그대로 `converged(expected)` 를 돌려주면 호출자에게
      // "손 떼도 된다" 고 **옛 기준으로** 말하는 것이 된다 — 틀리면 비싼 답이다.
      if (pointerOk && activeOk) {
        // **후보도 여기서 다시 본다** (18차 반례 #1). 라운드 머리에서 한 번 보고 끝냈더니,
        // 관측 두 번을 기다리는 사이 생긴 후보를 못 봤다 — 좌표는 이미 지나갔는데
        // 옛 기준으로 `converged` 를 답했다. 14차에 만든 "읽고-확인" 집합에 17차가 새로
        // 만든 "믿을 수 없는 상태" 를 안 넣은 것이다.
        const check = this.#settled(expected);
        if (check.kind === 'settled') return converged(expected, check.proof);
        if (check.kind === 'unfinished') {
          return { kind: 'unfinished', pending: check.pending, found: seen };
        }
        continue; // 기준이 옮겨 갔거나 끝나지 않은 활성화가 생겼다 — 다시 본다
      }

      // **관측은 누구나 한다. 고치는 것은 리더만 한다** (13차 반례 ① · 14차 보정).
      //
      // 처음엔 이 검사를 관측 **앞에** 뒀다. 그랬더니 fence 만 오르고 바깥은 그대로인
      // 정합한 상태까지 `diverged` 라고 답했다 — 아무것도 갈라지지 않았는데. 읽기를
      // 막을 이유가 없다. 막아야 하는 것은 **되돌릴 수 없는 연산**뿐이다.
      //
      // `exclusiveApply` 는 인스턴스 안의 큐라 두 리더 사이에서는 아무것도 막지 못한다.
      // 막을 수 있는 것은 durable 한 토큰뿐이다.
      if (BigInt(expected.leaderToken) < BigInt(this.agent.maxLeaderToken())) {
        return { kind: 'diverged', expected, found: seen };
      }

      // **부작용 앞에서도 후보를 본다** (19차 반례 #3). 답 게이트에만 넣고 여기를
      // 빠뜨렸더니, 되돌리는 사이 끝난 활성화 위로 옛 기준을 게시하고 HUP 을 보냈다.
      const before = this.#settled(expected);
      if (before.kind === 'unfinished') {
        return { kind: 'unfinished', pending: before.pending, found: seen };
      }
      if (before.kind !== 'settled') continue;

      const lease = this.#lease(expected);
      if (!pointerOk) await this.#budget(() => this.effects.publish(expected, lease));
      await this.#budget(() => this.effects.signalReload(lease));

      const midway = this.#settled(expected);
      if (midway.kind === 'unfinished') {
        return { kind: 'unfinished', pending: midway.pending, found: seen };
      }
      if (midway.kind !== 'settled') continue;
      const afterPublish = await this.#observe();
      const afterActive = await this.#budget(() => this.effects.observeActivation());
      const ok = afterPublish.kind === 'owned'
        && sameRecord(afterPublish.record, expected)
        && provesActivation(afterActive, expected.generation);
      // **여기서도 읽고-확인한다** (16차 검수). 조기 `converged` 와 소진 경로에는 넣었는데
      // 이 자리만 빠져 있었다. 되돌리고 관측하는 사이 기준이 옮겨 갔으면, 우리가 되돌린
      // 것은 이미 옛 기준이다 — `repaired` 는 "제자리로 돌려놨다" 는 뜻이라 거짓이 된다.
      const after = this.#settled(expected);
      if (after.kind === 'unfinished') {
        return { kind: 'unfinished', pending: after.pending, found: afterPublish };
      }
      return ok && after.kind === 'settled'
        ? repaired(expected, seen, after.proof)
        : { kind: 'diverged', expected, found: afterPublish };
    }
    // 기준이 계속 바뀐다 — 지금은 우리 차례가 아니다.
    //
    // **여기서 `converged` 를 돌려주고 있었다** (13차 반례 ④). 아무것도 관측하지 않은
    // 채로. "우리 차례가 아니다" 와 "수렴했다" 는 완전히 다른 말이고, 후자는 호출자가
    // 손을 떼도 된다는 뜻이다. 관측 한 번으로 답을 만들고, 확인되지 않으면 갈라졌다고
    // 말한다 — 다시 부르면 된다.
    const now = this.agent.lastActivated();
    if (now === undefined) return { kind: 'no_baseline' };
    const found = await this.#observe();
    const activation = await this.#budget(() => this.effects.observeActivation());
    const observed = found.kind === 'owned'
      && sameRecord(found.record, now)
      && provesActivation(activation, now.generation);
    const tail = this.#settled(now);
    if (tail.kind === 'unfinished') return { kind: 'unfinished', pending: tail.pending, found };
    return observed && tail.kind === 'settled'
      ? converged(now, tail.proof)
      : { kind: 'diverged', expected: now, found };
  }

  #observe(): Promise<PublishedState> {
    return this.#budget(() => this.effects.observePublished());
  }

  /** 수렴에도 예산을 씌운다 (12차 반례 ③) — 안 그러면 같은 큐가 다시 교착한다. */
  /**
   * 부작용 하나의 예산. **호출 전체의 마감보다 길 수 없다** (14차 검수).
   *
   * 전에는 부작용마다 10 초가 새로 시작됐다. 기준이 매 라운드 바뀌고 각 관측이 10 초
   * 직전에 끝나는 스케줄이면, 한 번의 `reconcileConfig` 가 **2 분 넘게 인스턴스 큐를
   * 잡는다** — 그동안 apply 도 못 들어온다. 마감은 호출 시작에서 한 번 정해진다.
   */
  /**
   * **지금 이 기준을 정답이라고 말해도 되는가** (18차 반례 #1).
   *
   * 둘을 함께 본다.
   *   · 기준이 그 사이 옮겨 가지 않았다 (14차)
   *   · **끝나지 않은 활성화가 없다** (17차 A · 18차에 판정 직전까지 넓혔다)
   *
   * 후보가 있으면 좌표는 이미 후보 쪽으로 갔고 기준은 그 전 것이다. 그 상태에서
   * `converged`·`repaired` 를 답하면 호출자에게 **옛 세대로 "손 떼도 된다"** 고 말한다.
   */
  /**
   * **왜 아닌지까지 답한다** (19차 반례 #2).
   *
   * 전에는 참/거짓만 돌려줬고, 실패하면 자리마다 알아서 `continue` 하거나 `diverged` 를
   * 냈다. 그래서 후보가 생겨 실패한 것도 `diverged` 로 나갔다 — `expected` 와 `found` 가
   * **같은 기록**인데 "갈라졌다" 고 답한다. `dirty` 를 가른 것과 같은 병이다.
   *
   * 이유를 함께 돌려주면 각 자리가 맞는 답을 낸다.
   */
  #settled(expected: PublishRecord): SettleCheck {
    // **한 스냅샷으로 본다** (19차 검수). 따로 읽으면 그 사이가 벌어지고, `DurableStore`
    // 는 공개 표면이라 락 없는 구현에서 그 틈이 실제로 열린다.
    //
    // **방어적이다** — 따로 읽게 되돌려도 아무것도 안 빨개진다(확인했다). 인프로세스에서는
    // `snapshot()` 이 동기라 사이가 안 벌어지고, 우리 `FileStore` 는 락이 막는다. 남의
    // 구현을 위한 것이고, 그건 우리 테스트가 못 만든다.
    const view = this.agent.decisionView();
    const pending = unfinishedIn(view);
    if (pending !== undefined) return { kind: 'unfinished', pending };
    if (view.lastActivated === undefined) return { kind: 'moved' };
    if (!sameRecord(view.lastActivated, expected)) return { kind: 'moved' };
    return { kind: 'settled', proof: SETTLED };
  }

  /**
   * **끝나지 않은 전환** — 있으면 기준을 정답이라고 말할 수 없다.
   *
   * 둘을 본다. 방향이 반대이고 둘 다 "복구를 부르면 끝난다" 다.
   *   · 활성화가 끝났는데 기준으로 안 올라간 후보 (17차 A)
   *   · 시작했는데 안 끝난 오퍼레이션 — 비종단 저널이 남아 있다 (19차 #1)
   *
   * **절을 여기 한 곳에만 넣으면 된다.** `Settled` 표를 만든 이유가 그것이다 — 판정
   * 자리와 부작용 자리를 훑어 다니지 않아도 된다.
   */
  #unfinished(): PublishRecord | undefined {
    return unfinishedIn(this.agent.decisionView());
  }

  /**
   * 되돌릴 수 없는 연산 직전에 확인하는 표 (15차 검수).
   *
   * 전에는 게시 lease 가 **기준만** 봤고 HUP lease 는 `() => undefined` — **아무것도**
   * 안 봤다. 그래서 규약을 지켜 `assertValid()` 를 부르는 구현도 낡은 리더 밑에서 그대로
   * 진행했다. `fence` 는 기준(`lastActivated`)을 바꾸지 않으므로 기준 검사만으로는
   * 리더 교체를 못 본다 — **둘은 서로를 대신하지 못한다.**
   *
   * 규약이 "이걸 확인하면 안전하다" 인데 확인해도 안전하지 않으면 규약이 거짓말이 된다.
   */
  #lease(expected: PublishRecord): ApplyLease {
    return {
      leaderToken: expected.leaderToken,
      assertValid: () => {
        if (BigInt(expected.leaderToken) < BigInt(this.agent.maxLeaderToken())) {
          throw new DpRejection('stale_leader', '되돌리는 사이 리더가 바뀌었다');
        }
        // **되돌릴 수 없는 연산 직전이다.** 여기도 `#settled` 를 본다 (19차 반례 #3) —
        // 기준만 보면 그 사이 끝난 활성화를 우리가 되돌린다.
        //
        // 지금은 바로 위의 재검사가 이미 막아서 **이 절만 지워도 안 빨개진다**(확인했다).
        // 반납이 네 자리에 있는 것과 같은 중복이다. 그래도 둔다 — 이건 **부작용 직전의
        // 마지막 문**이고, 위의 검사와 여기 사이에 await 가 생기는 변경이 오면 여기만 남는다.
        if (this.#settled(expected).kind !== 'settled') {
          throw new DpRejection('stale_leader', '되돌리는 사이 기준이 바뀌었거나 새 활성화가 끝났다');
        }
        return CHECKED_TOKEN;
      },
    };
  }

  #budget<T>(run: () => Promise<T>): Promise<T> {
    const left = this.#deadline === undefined ? RECONCILE_EFFECT_MS : this.#deadline - Date.now();
    if (left <= 0) {
      return Promise.reject(new DpRejection('stale_state', `수렴 마감 ${RECONCILE_TOTAL_MS}ms 초과`));
    }
    const ms = Math.min(RECONCILE_EFFECT_MS, left);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new DpRejection('stale_state', `수렴 예산 ${ms}ms 초과`)), ms);
      run().then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
  }

  async status(): Promise<DriverStatus> {
    const journal = this.agent.readJournal();
    return {
      maxLeaderToken: this.agent.maxLeaderToken(),
      planes: { http: this.agent.coordinate('http'), stream: this.agent.coordinate('stream') },
      published: await this.effects.observePublished(),
      lastEvidence: journal?.evidence,
      unfinished: this.#unfinished(),
    };
  }
}
