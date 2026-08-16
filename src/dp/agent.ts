/**
 * DP Agent 상태기계 — DESIGN.md §3.5 · §3.6
 *
 * 컨트롤 플레인은 자기가 리더라고 *믿을* 수 있을 뿐이다. 실제 심판은 여기다.
 *
 * **왜 직렬인가.** S11 스파이크는 순차 테스트로 14 PASS 를 냈지만 동시 요청에서 깨졌다 —
 * 토큰을 검사한 뒤 body 를 읽느라 yield 하고, 재개 후 재검사 없이 슬롯을 썼다. 그 사이 더
 * 높은 토큰이 완주하면 낮은 토큰의 쓰기가 살아남는다.
 *
 * 그래서 여기서는 두 가지를 구조로 강제한다.
 *   1. **payload 는 진입 전에 이미 손에 있다.** 임계구역 안에서 I/O 를 기다리지 않는다.
 *   2. **검사 → 상태 변경 → durable 저장이 하나의 직렬 구간**이다. 다음 요청은 그게 끝나야
 *      시작한다. 큐가 그 순서를 보장한다.
 *
 * 좌표는 전부 **decimal string** 이다. `activation_epoch` 는 오래 도는 단조 시퀀스라
 * JavaScript `number` 의 안전 정수를 넘길 수 있고, 넘기는 순간 비교와 JSON 왕복이 조용히
 * 깨진다.
 */

import type {
  ActivationEvidence,
  ApplyOperation,
  ApplyPhase,
  Coordinate,
  Plane,
  PlaneProgress,
  ApplyLease,
  PublishRecord,
} from './operation.js';
import { CHECKED_TOKEN, isTerminalPhase, planesOf, provesActivation } from './operation.js';
export type { ActivationEvidence, Coordinate, Plane };

/**
 * **이 좌표를 누가 놨는가** (26차 — 부류를 닫는다).
 *
 * 좌표에 서명이 없어서 §3.4 가 **여섯 번 재발했다.** 매번 "내가 옮겼는가" 를 **닮음**
 * 으로 물었기 때문이다 — 평면 집합이 같은가(22·23차) → 하드코딩 전제(24차) →
 * epoch 가 같은가 → digest 도 같은가(25차). 닮음의 기준을 하나 얹을 때마다 인스턴스
 * 하나가 닫혔고 다음 회차에 그 아래 층이 열렸다.
 *
 * 26차가 마지막 층을 재현했다: **남이 같은 내용으로 같은 좌표를 채우면** digest 를 봐도
 * 못 가른다. 그리고 같은 설정의 재시도는 운영에서 가장 흔한 패턴이다.
 *
 * 그래서 추론을 그만두고 **적는다.** 닮음의 기준을 몇 개 얹든 못 가르는 경우가 남지만,
 * 서명은 안 남는다.
 */
export type PlaneAuthor = { operationId: string; transitionId: string; leaderToken: string };

export type PlaneState = Coordinate & {
  payloadDigest: string;
  /**
   * 이 `activationEpoch` 로 좌표를 옮긴 **commit 의 신원**.
   *
   * 없을 수 있다 — 초기 좌표(epoch 0)에는 작성자가 없고, 이 필드 이전에 저장된 상태에도
   * 없다. **없으면 "내가 옮겼다" 가 아니다.** 닮음 폴백을 두지 않는다: 두면 부류가 안
   * 닫히고, 업그레이드 창이 지나면 죽은 폴백으로 남아 스윕이 짚는다(24차 규칙).
   *
   * 그 대가는 구버전에서 이월된 **열린 저널**이 종단에서 비관적으로 `failed` 로 판정될
   * 수 있는 1 회성 창이다. 방향이 안전하다 — 남의 공로를 흡수하는 것보다 비관이 싸다.
   */
  by?: PlaneAuthor;
};

/** §3.6 — epoch 하나로는 "허가된 operation" 을 증명하지 못한다. 튜플 전체를 싣는다. */
export type OperationTuple = {
  leaderToken: string;
  operationId: string;
  transitionId: string;
  plane: Plane;
  /** DP 가 지금 이 좌표에 있어야 한다. CAS 의 기대값. */
  expectedCurrent: Coordinate;
  target: Coordinate;
  payloadDigest: string;
  /** 활성화할 세대. **증거 판정에 쓴다** — 이게 없으면 commit 이 증거를 검사할 수 없다. */
  targetGeneration: string;
  /** 그 세대의 내용 digest. 이름만으로는 무엇을 활성화하는지 말하지 못한다 (§7.2). */
  generationDigest: string;
};

export type PlaneAck = PlaneState & {
  plane: Plane;
  transitionId: string;
  /** 같은 좌표·같은 digest 의 재요청이었다. */
  cached: boolean;
};

export type RejectionKind =
  | 'stale_leader'
  /** 이 전환은 이미 끝났다. `terminalState` 가 어떻게 끝났는지 말한다. */
  | 'terminal'
  /** (plane, target_activation_epoch) 슬롯을 남이 갖고 있다. */
  | 'slot_taken'
  /** 예약 없이 하려 했다. 예약은 부작용보다 **먼저** 온다 (§3.5). */
  | 'not_reserved'
  /** 같은 키인데 튜플이 다르다. 캐시된 ACK 를 주면 안 되는 경우다. */
  | 'tuple_mismatch'
  | 'stale_state'
  | 'coordinate_mismatch'
  | 'digest_mismatch'
  | 'epoch_not_monotonic'
  | 'not_staged'
  /** 다른 오퍼레이션이 apply 경로를 쥐고 있다 (§3.6). */
  | 'operation_in_flight'
  /** 저널이 그 사이 앞으로 갔다. 다시 읽고 따라가야 한다. */
  | 'journal_conflict'
  /** 좌표가 10진 정수 문자열이 아니다. */
  | 'invalid_coordinate'
  /** 봉투가 어떤 평면도 말하지 않았다 (§9.1.1 blocker 3). */
  | 'empty_envelope'
  /** 봉투의 `affectedPlanes` 와 실린 목표가 어긋난다. */
  | 'envelope_mismatch'
  /** 증거가 활성화를 증명하지 못한다 (§6.3). */
  | 'not_activated';

/** 전환이 끝나는 방식. **셋은 상호 배타적**이다 — 하나에 들어가면 다른 곳으로 못 간다. */
export type TerminalKind = 'activated' | 'failed' | 'aborted';

/** durable 상태가 다른 writer 에게 밀렸다. 다시 읽고 다시 판정해야 한다. */
export class StoreConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreConflict';
  }
}

export class DpRejection extends Error {
  readonly terminalState?: TerminalKind;
  constructor(readonly kind: RejectionKind, message: string, terminalState?: TerminalKind) {
    super(message);
    if (terminalState !== undefined) this.terminalState = terminalState;
    this.name = 'DpRejection';
  }
}

// ── durable 상태 ─────────────────────────────────────────────────────────

/**
 * `(plane, target_activation_epoch)` 슬롯의 **주인**. §9.1.1 blocker 1.
 *
 * 5차 검수 전까지 이 자리에는 digest 문자열 하나뿐이었다. 그래서 "이 좌표는 누구
 * 것인가" 를 아무도 몰랐고, 서로 다른 operation 이 같은 좌표를 잡고 서로의 슬롯을
 * 덮고 지웠다. 튜플 전체를 실어야 주인이 정해진다.
 */
export type Reservation = {
  /** 정본 튜플. 이 슬롯의 주인이다. */
  op: OperationTuple;
  /** stage 된 payload digest. 아직 올리지 않았으면 undefined. */
  stagedDigest?: string;
};

/** 좌표를 옮긴 근거 (§6.3). `plane:epoch` 로 색인한다. */
export type EvidenceRecord = { evidence: ActivationEvidence };

/** apply 경로의 주인. **한 번에 하나다** — 저널도 current 도 HUP 도 전역이기 때문이다. */
export type ActiveOperation = {
  operationId: string;
  transitionId: string;
  leaderToken: string;
  /**
   * 이 오퍼레이션이 잡은 평면들 (8차 반례 ②).
   *
   * 승계할 때 저널을 보고 예약을 찾으면, **저널을 쓰기 전에 죽은 경우** 예약이 남는다.
   * 실행권 자체가 자기가 무엇을 잡았는지 알아야 한다.
   */
  planes: Plane[];
  /** 평면별 목표 epoch. 예약 슬롯을 찾는 열쇠다. */
  epochs: Record<string, string>;
};

export type AgentState = {
  /**
   * durable CAS 용 단조 버전. `save` 는 `version === 직전 + 1` 일 때만 성공한다.
   *
   * **인스턴스 안의 직렬화만으로는 부족하다.** 같은 store 를 보는 두 Agent 는 서로의
   * 큐를 모르므로 둘 다 같은 상태를 읽고 각자 쓴다. 5차 검수가 그렇게 리더 토큰을
   * 12 에서 11 로 되감았다.
   */
  maxLeaderToken: string;
  planes: Record<Plane, PlaneState>;
  /** epoch → 예약. 아직 활성화되지 않은 슬롯 (§6.5 staging). */
  reservations: Record<Plane, Record<string, Reservation>>;
  /**
   * `operationId:transitionId:plane:step` → 그때 돌려준 ACK 와 정본 튜플. 재요청 판정용.
   *
   * ⚠️ **가지치기를 넣으려면 신원 비교를 같은 커밋에서 고쳐라** (22·23차).
   *
   * 이 표는 전환마다 영구 누적된다 — 즉 **무한히 자란다.** 언젠가 잘라야 한다. 그런데
   * ⚠️ **아래 서술은 22~27차의 것이고 지금은 낡았다** (37차 검수). 가지치기는 **이미
   * 실물**이고("가지치기가 그 경로를 만든다 … 둘은 한 커밋이다" 는 완료된 일이다),
   * 열거된 다섯 중 셋(`reserveAll` 고아 청소 · `driveLoop` · `EffectTimeout` 정리)이
   * **이미 토큰을 본다**(빚갚기 · 34차 C). 남은 둘은 `epochsFromJournal` 과
   * `finalizeCandidate` 이고, **둘 다 아직 id 만 본다** — `finalizeCandidate` 의 안전은
   * 하류 `candidateArrived`/`authoredBy`(26~30차)가 맡는다.
   *
   * (37차에 이 현행화를 쓰면서 **구성원을 틀리게 적었다** — `EffectTimeout` 정리를
   * 빼고 `finalizeCandidate` 를 넣었다. 38차가 짚었다. **거짓 기록을 고치는 회차에
   * 같은 부류를 남기는 것이 세 회차째다.**)
   *
   * 그대로 두는 이유는 그 시절의 판단이 왜 그랬는지가 기록으로 값이 있어서다. **다만
   * 현재 상태로 읽으면 거짓이다** — 36차가 거짓 기록 셋을 고친 바로 그 회차에 같은
   * 부류를 하나 남겼고, 37차가 짚었다.
   *
   * ─────────────────────────────────────────────────────────────────
   * **아래는 22~27차의 기록이다. 현재 상태가 아니다.** (39차 CE-39-b — 정정 문단과
   * 낡은 문단이 한 블록에 병치돼 어느 쪽이 지금인지 문단 단위로 안 갈렸다.)
   * ─────────────────────────────────────────────────────────────────
   *
   * 지금 이 표는 **캐시가 아니라 방패**로도 쓰이고 있다. `reserveAll` 의 고아 청소 ·
   * `driveLoop` · `EffectTimeout` 정리 · `epochsFromJournal` · `finalizeCandidate` 는
   * 전환을 **id 로만** 비교한다(토큰을 안 본다). 그게 지금 안전한 이유는 비교가 옳아서가
   * 아니라 **같은 id 의 옛 전환이 이 표에 늘 남아 있어서** `admit` 이 `digest_mismatch`
   * 로 먼저 시끄럽게 거부하기 때문이다. 방어가 아니라 부작용이다.
   *
   * 23차가 가지치기를 모의해 확인했다: 옛 리더의 op 'X' 가 fence 로 승계된 뒤 신임이
   * **같은 id** 'X' 를 새 토큰으로 내면, 그 호출이 **조용히 `superseded` 를 반환**하고
   * (자기 일은 하나도 안 했는데) 홀더가 남아 다음 오퍼레이션이 `operation_in_flight` 로
   * **봉쇄된다.** `recoverConfig` 도 못 푼다 — 푸는 것은 다음 fence 뿐이다.
   *
   * 지금 고치지 않는 것은 판단이다. 저 다섯 자리는 현재 도달 경로가 없어서 고쳐도
   * 뮤테이션 스윕이 지켜 주지 못한다(재현 경로 없는 수정은 다음 회차에 조용히 되돌아온다 —
   * 이 시리즈가 배운 그대로다). **가지치기가 그 경로를 만든다.** 그러니 둘은 한 커밋이다.
   */
  completed: Record<string, { tuple: string; payloadDigest: string; ack: PlaneAck; transition?: string }>;
  /** 끝난 전환. 지연된 RPC 가 되살리지 못하게 막는다. */
  terminal: Record<string, TerminalKind>;
  /**
   * `plane:activationEpoch` → 그 좌표로 옮긴 근거 (§6.3).
   *
   * **왜 옮겼는지 답할 수 없으면 옮기지 말았어야 한다.** 사후에 "이 세대가 왜 활성으로
   * 판정됐나" 를 물을 수 있어야 장애 분석이 된다.
   */
  activationEvidence: Record<string, ActivationEvidence>;
  /**
   * 지금 apply 경로를 쥔 오퍼레이션 (6차 반례 ③).
   *
   * 예약은 `(plane, epoch)` 슬롯만 독점한다. 그런데 저널·`current` 심볼릭 링크·HUP 은
   * **전역**이라, 서로 다른 슬롯을 잡은 두 오퍼레이션이 같은 nginx 를 동시에 흔들 수 있다.
   */
  activeOperation?: ActiveOperation;
  /**
   * 마지막으로 **활성화를 인정한** 게시 (10차 검수).
   *
   * 러너는 유한하다 — 종단에 닿으면 끝난다. 그런데 옛 writer 는 그 뒤에도 착지할 수
   * 있다. 그러면 "덮여서 수렴한다" 는 주장이 성립하지 않는다. 수렴을 보장하려면
   * **종단 뒤에도 도는 무언가**가 있어야 하고, 그러려면 무엇으로 되돌릴지를 기억해야 한다.
   */
  lastActivated?: PublishRecord;
  /**
   * 마지막으로 **게시한** 것 — 활성화까지 갔는지는 모른다 (12차 반례 ②).
   *
   * `lastActivated` 는 commit 에서만 생긴다. 그래서 최초 apply 가 게시만 하고 끊기면
   * reconcile 이 영영 `no_baseline` 이었다 — 게시는 나갔는데 되돌릴 기준이 없다고
   * 답하는 것은 거짓이다. 활성화하지 못한 게시가 있다는 사실 자체를 드러내야 한다.
   */
  lastPublishIntent?: PublishRecord;
  /**
   * 평면 하나가 넘어갈 때마다 여기 적힌다. **아직 기준이 아니다** (13차 반례 ②).
   * 전 평면이 넘어가야 `lastActivated` 로 올라간다.
   */
  pendingActivation?: PublishRecord;
  /**
   * 그 후보가 **완결되려면 어디에 도착해야 하는가** (15차 검수).
   *
   * 전에는 `finishOperation` 이 넘어온 오퍼레이션이 담은 평면만 보고 판정했다. 그래서
   * 같은 id 로 평면 하나만 담아 끝내면 부분 활성화가 기준으로 올라갔다. 호출자가 무엇을
   * 아는지에 기대는 것이 문제였다 — 완결의 뜻은 **후보가 만들어질 때** 정해진다.
   */
  pendingEpochs?: Record<string, string>;
  /**
   * 진행 중인 apply 오퍼레이션의 저널 (§6.2).
   *
   * **여기 있어야 한다.** 저널과 멤버십 좌표가 서로 다른 소유자를 가지면 같은 store 를
   * 두고 덮어쓴다 — 5차 반례 ④ 가 그것이었다. 하나의 직렬 구간이 둘 다 소유한다.
   */
  journal?: JournalEntry;
};

/**
 * §6.2 의 apply 단계. **오퍼레이션을 통째로** 들고 있어야 복구가 같은 것을 재개한다.
 *
 * 5차 검수 전에는 평면 하나짜리 튜플이었다. 그래서 두 평면을 함께 옮기는 오퍼레이션을
 * 표현할 수 없었고, 실패했을 때 어느 평면이 반영됐는지 말할 수도 없었다 (§3.4).
 */
export type JournalEntry = {
  op: ApplyOperation;
  phase: ApplyPhase;
  reloadAttempts: number;
  /**
   * 단계 전이 CAS (6차 반례 ③).
   *
   * 러너 여럿이 같은 저널을 읽고 각자 다음 단계로 밀면 HUP 이 그 수만큼 나간다.
   * 쓰기가 `seq === 직전 + 1` 일 때만 성공하면 **한 명만 이긴다.** 진 쪽은 다시 읽고
   * 이미 앞으로 간 상태에서 따라간다.
   */
  seq: number;
  /** 평면별로 어디까지 갔는가. */
  progress?: Partial<Record<Plane, PlaneProgress>>;
  /** 마지막으로 관측한 활성화 증거 (§6.3). */
  evidence?: ActivationEvidence;
};

/**
 * 오퍼레이션에서 평면 하나의 튜플을 뽑는다.
 *
 * Agent 의 원시 연산(`reserve`/`stage`/`commit`)은 **평면 단위**로 남는다 — 좌표 CAS 가
 * 평면별이기 때문이다. 여러 평면을 한 오퍼레이션으로 묶는 것은 러너의 일이다.
 */
export function tupleFor(op: ApplyOperation, plane: Plane): OperationTuple {
  const t = op.planes[plane];
  if (t === undefined) {
    throw new DpRejection('envelope_mismatch', `오퍼레이션에 평면 '${plane}' 의 목표가 없다`);
  }
  return {
    leaderToken: normalizeNumeric(op.leaderToken, 'leaderToken'),
    operationId: op.operationId,
    transitionId: op.transitionId,
    plane,
    // **여기서 정규화한다.** 슬롯 키도 정본 튜플도 저장값도 전부 이걸 쓴다.
    expectedCurrent: normalizeCoordinate(t.expectedCurrent, 'expectedCurrent'),
    target: normalizeCoordinate(t.target, 'target'),
    payloadDigest: t.payloadDigest,
    targetGeneration: op.targetGeneration,
    generationDigest: op.generationDigest,
  };
}

/**
 * 저장소가 보는 상태 — **내용은 불투명하다** (8차 반례 ④).
 *
 * 전에는 `AgentState` 를 그대로 노출했다. 그러면 예약·완료캐시·저널·실행권까지 **내부
 * 상태기계 전체가 동결 대상**이 된다. 이번 회차에 그 모양이 또 바뀐 것 자체가 증거다 —
 * `superseded` 단계가 생기고 `activeOperation` 에 필드가 붙었다.
 *
 * 저장소가 알아야 하는 것은 하나뿐이다: **`version` 으로 CAS 하고 나머지는 그대로
 * 보관했다가 그대로 돌려준다.**
 */
export type StoredState = {
  /** durable CAS 용 단조 버전. `save` 는 `version === 직전 + 1` 일 때만 성공한다. */
  readonly version: number;
  /**
   * **저장소는 이걸 해석하지 않는다.** 그대로 보관했다 그대로 돌려주면 된다.
   *
   * 9차 검수: `AgentState` 를 그대로 노출하면 `{version}` 만 보관하는 정직한 구현이
   * 두 번째 쓰기에서 깨진다. 불투명하다고 적어 놓고 실제로는 모양을 요구하고 있었다.
   */
  readonly payload: unknown;
};

export interface DurableStore {
  load(): StoredState | undefined;
  /**
   * **fsync 까지 끝나고 나서** resolve 해야 한다.
   *
   * `state.version` 이 저장된 것의 바로 다음이 아니면 `StoreConflict` 로 거부한다.
   * 이게 없으면 프로세스·인스턴스 간 lost update 를 막을 수단이 없다.
   */
  save(state: StoredState): Promise<void>;
}

/** 테스트용. `delayMs` 로 durable 저장을 느리게 만들어 동시성 구멍을 드러낸다. */
export class MemoryStore implements DurableStore {
  private state: StoredState | undefined;
  constructor(private readonly delayMs = 0) {}
  load(): StoredState | undefined {
    return this.state === undefined ? undefined : structuredClone(this.state);
  }
  async save(state: StoredState): Promise<void> {
    // 지연은 **검사 앞**에 둔다. 그래야 둘 다 load 를 통과한 뒤 CAS 에서 갈린다 —
    // 그게 실제 fsync 가 만드는 창이다.
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    const expected = (this.state?.version ?? 0) + 1;
    if (state.version !== expected) {
      throw new StoreConflict(`버전 충돌: ${expected} 를 기대했는데 ${state.version} 이 왔다`);
    }
    this.state = structuredClone(state);
  }
}

const ZERO: PlaneState = { activationEpoch: '0', membershipRevision: '0', payloadDigest: '' };

const initial = (): AgentState => ({
  maxLeaderToken: '0',
  planes: { http: { ...ZERO }, stream: { ...ZERO } },
  reservations: { http: {}, stream: {} },
  completed: {},
  terminal: {},
  activationEvidence: {},
});

/**
 * 좌표를 **정규형**으로 만든다 (6차 반례 ⑦).
 *
 * `'1'` 과 `'01'` 은 같은 epoch 인데 문자열로는 다르다. 슬롯 키·정본 튜플·저장값이 전부
 * 문자열이므로, 정규화하지 않으면 같은 좌표를 두 오퍼레이션이 각자 잡는다.
 */
export function normalizeNumeric(v: string, what: string): string {
  if (!/^[0-9]+$/.test(v)) {
    throw new DpRejection('invalid_coordinate', `${what} 는 10진 정수 문자열이어야 한다: ${JSON.stringify(v)}`);
  }
  return BigInt(v).toString();
}

const normalizeCoordinate = (c: Coordinate, what: string): Coordinate => ({
  activationEpoch: normalizeNumeric(c.activationEpoch, `${what}.activationEpoch`),
  membershipRevision: normalizeNumeric(c.membershipRevision, `${what}.membershipRevision`),
});

const sameCoordinate = (a: Coordinate, b: Coordinate): boolean =>
  BigInt(a.activationEpoch) === BigInt(b.activationEpoch) &&
  BigInt(a.membershipRevision) === BigInt(b.membershipRevision);

// ── Agent ────────────────────────────────────────────────────────────────

/**
 * 불변식 위반 — **상태가 깨졌다.** 거부(`DpRejection`)와 다르다.
 *
 * 거부는 "그 요청은 안 된다" 이고, 이건 "우리가 이미 잘못 썼다" 이다. 삼키면 안 된다.
 */
export class InvariantViolation extends Error {
  constructor(readonly invariant: string, message: string) {
    super(`불변식 위반 [${invariant}] — ${message}`);
    this.name = 'InvariantViolation';
  }
}

/**
 * 상태에 대한 불변식 — **모든 durable write 앞에서 검사한다** (13차 검수).
 *
 * 열세 라운드 동안 반례를 하나씩 고쳤고, 그중 일곱 번은 직전 수정이 만든 구멍이었다.
 * 점 수정이 점을 늘리기만 한 것이다. 검수의 처방은 "불변식을 먼저 명시하라" 였다.
 *
 * 여기 거는 이유: `serial()` 은 상태가 store 로 내려가는 **유일한 통로**다. 여기 걸면
 * 기존 테스트 전부가 그대로 불변식 테스트가 된다 — 새 시나리오를 안 써도 된다.
 *
 * ── 검수가 준 다섯 중 여기 **없는 둘** ────────────────────────────────────────
 *
 * **I2 "동일 baseline 재관측 + 전 평면 일치만 converged"** — 상태 술어가 아니다. 외부
 * 관측과 시간이 들어간다. `reconcileConfig` 쪽 판정이고 conformance 가 맡는다.
 *
 * **I4 "terminal 이면 holder 0"** — **이 설계에서는 틀린 명제다.** 넣어 보고 알았다:
 * 86 개 테스트가 터진다. 우리는 일부러 **종단 저널을 먼저 쓰고 실행권을 나중에 반납한다**
 * ("기록이 먼저, 반납이 나중이다" — apply.ts). 반대로 하면 자기 종단 기록이 자기 소유권
 * 검사에 막힌다. 그래서 둘 사이에 실행권이 살아 있는 durable 상태가 **정상적으로** 존재한다.
 *
 * 옳은 형태는 시점 불변식이 아니라 **활성 속성**이다 — "종단이면 *언젠가* 반납된다".
 * 그 언젠가를 보장하는 것은 `finishOperation` 과, 죽었을 때의 `recover()` 다. 그건
 * conformance 가 이미 짚는다(6차 반례 ④ · 12차 반례 ⑤).
 *
 * 불변식을 적어 보지 않았으면 이걸 몰랐을 것이다. 검수가 준 다섯 중 하나는 틀렸고,
 * 하나는 여기서 잴 수 없다. **셋만 참이다.**
 *
 * ── 이 층이 지금 얼마나 값을 하는가 (15차 앞에서 잰 것) ──────────────────────
 *
 * **지금까지 시도한 어떤 버그도 불변식만이 잡은 것은 없다.** 재봤다 — 버그를 하나씩
 * 넣고 불변식을 켠 채와 끈 채로 돌렸다.
 *
 * ```
 *              conformance+unit        전체(모델 포함)
 *   intent 가드 제거   ON 0 / OFF 0        ON 1 / OFF 1   ← 모델만 잡는다
 *   고아 재획득 제거   ON 0 / OFF 0        ON 1 / OFF 1   ← 모델만 잡는다
 *   finalizer 도착     ON 5 / OFF 5        ON 1 / OFF 1   ← conformance 가 잡는다
 * ```
 *
 * 그러니 **"불변식이 잡았다" 고 말하면 안 된다.** 정확히는 이렇다.
 *
 *   · 값이 나오는 곳은 지금 **모델**이다 — 위 둘은 모델이 아니면 아무도 못 잡는다.
 *   · 불변식은 **쓰기 지점에서** 터지므로 진단이 정확하고, 465 개 테스트 전부에 걸린다.
 *   · 그리고 **앞으로의 변경**을 막는다 — 지금 코드의 버그가 아니라 미래의 것을.
 *
 * 없앨 이유는 아니지만, 이 층을 근거로 "상태 축은 검사됐다" 고 넓게 읽으면 안 된다.
 *
 * ── 그리고 우리가 하나 더 찾았다 (I6) ──────────────────────────────────────
 *
 * 14차에서 고친 반례 넷이 **전부 I1·I3·I5 밖**이었다. 게시는 외부 효과라 상태 술어로
 * 표현되지 않는다고 넘겼는데, 그중 하나는 **끌어올 수 있었다.** 사고가 난 자리는 "게시가
 * 무엇인가" 가 아니라 "**기준 후보가 어떻게 사라지는가**" 였고, 그건 순수한 상태 전이다.
 *
 * I6 이 그것이다. 넣고 나서 그 버그를 되돌려 보니 **명시적 단언이 없던 시나리오 세 개에서도
 * 잡혔다** — 반례 하나를 고정하는 것보다 넓다. 이음매라고 다 못 재는 것이 아니다.
 */
/**
 * 기준 후보를 **상태로** 판정한다 (14차 검수).
 *
 * 전에는 호출자가 `promote: boolean` 을 넘겼다. 그러면 경로 하나를 빠뜨리는 순간 기준이
 * 새거나 사라진다 — 실제로 `recover()` 가 그랬고(e280e93), fence 로 승계될 때는 전 평면이
 * 넘어간 후보가 그대로 고아가 됐다.
 *
 * 여기서는 **좌표를 직접 본다.** 선언한 평면이 전부 목표 epoch 에 도착했으면 기준이 되고,
 * 아니면 후보를 버린다. 호출자가 무엇을 아는지와 무관하게 같은 답이 나온다.
 */
/**
 * **이 후보가 정말 도착했는가.** 승격자와 불변식이 같이 쓴다 (30차 CE-30).
 *
 * 자리가 둘이면 언젠가 갈린다 — 25차에 판정 기준을 `reachedPhase()` 에만 넣고
 * `failAll` 에 안 넣어 phase 와 progress 가 모순됐던 그것이다. 여기서는 **승격을
 * 결정하는 판정**과 **승격을 강제하는 불변식**이 갈리면 안 된다.
 */
function candidateArrived(
  s: AgentState,
  candidate: PublishRecord,
  epochs: Record<string, string> | undefined,
): boolean {
  if (epochs === undefined) return false;
  return Object.entries(epochs).every(([plane, epoch]) => {
    const at = s.planes[plane as Plane];
    if (at?.activationEpoch !== epoch) return false;
    // 서명이 있으면 서명이 답한다. 없으면(26차 이전 상태) **신원 있는 다른 증거**를
    // 읽는다 — `terminal` 원장의 키는 `operationId:transitionId:plane` 이다.
    return at.by === undefined
      ? s.terminal[`${candidate.operationId}:${candidate.transitionId}:${plane}`] === 'activated'
      : authoredBy(at, candidate);
  });
}

function finalizeCandidate(
  s: AgentState,
  ids: { operationId: string; transitionId: string },
): void {
  const candidate = s.pendingActivation;
  if (candidate === undefined) return;
  if (candidate.operationId !== ids.operationId) return;
  if (candidate.transitionId !== ids.transitionId) return;

  // **뜻은 상태에서 온다. 호출자에게서 오지 않는다.**
  //
  // 15차: 넘어온 오퍼레이션이 담은 평면만 보고 판정했다 → 평면 하나만 담아 끝내면 부분
  // 활성화가 기준이 됐다. 그래서 후보에 완결의 뜻을 함께 적었다(`pendingEpochs`).
  //
  // 16차: 그런데 `?? fallback` 으로 호출자에게 되돌아가는 길을 남겨 뒀다. 걷어냈다.
  //
  // 17차: 걷어내기만 했더니 **뜻 없는 후보 + `activated` 저널이 영구 교착**이 됐다.
  // I6(b)는 "활성화했으면 기준을 남겨라" 고 하고 여기는 "뜻이 없으면 못 올린다" 고 해서,
  // 둘이 서로 반대를 명령한다. 복구도 fence 도 apply 도 전부 그 자리에서 던진다.
  // 게다가 수렴은 **낡은 기준을 정답이라고 답한다** — "기준이 없으면 no_baseline 으로
  // 드러난다" 던 16차의 근거가 이전 기준이 있을 때 틀린 것이다.
  //
  // 그래서 **저널**에서 가져온다. 저널의 op 는 실행권 아래서 쓰였으므로 상태다 —
  // 호출자가 준 것이 아니라 우리가 그때 적은 것이다. 16차가 막으려던 것에 해당하지 않는다.
  // **여기도 서명을 읽는다** (27차 CE-27 — 일곱 번째 층).
  //
  // 26차에 좌표에 서명을 붙이고 "부류를 닫았다" 고 적었는데 **거짓이었다.**
  // `reachedPhase` · `failAll` · commit 재요청은 서명으로 바꿨으면서 **여기를 빠뜨렸다.**
  // 이 자리는 epoch 만 봤다 — 즉 여전히 닮음이다.
  //
  // 그래서 내가 http 만 옮기고 stream 을 포기한 뒤 남이 stream 을 옮기면, **혼합 저자
  // 부분 활성화가 전체 활성화 기준으로 승격**됐다. 좌표는 둘 다 목표 epoch 에 있으니
  // 닮음으로는 "도착" 이다. 그리고 그 뒤 수렴이 그 세대를 정답으로 게시한다.
  //
  // 이것으로 `pendingEpochs` 가 **후보 신원에 결속돼 있지 않은** 문제도 같이 닫힌다 —
  // 남의 선언이 실려 있어도, 그 평면들을 후보가 놓지 않았으면 도착이 아니다.
  //
  // 23·25·27차가 세 번 같은 진단을 했다: **규칙을 세우고 일부 자리에만 적용.**
  // 규칙을 만들 때 **자리를 세는 것**이 규칙을 만드는 일의 절반이다.
  //
  // **서명이 없으면 신원 있는 다른 증거를 읽는다** (29차 CE-29).
  //
  // 27차에 서명 대조를 넣자 서명 없는 좌표(26차 이전 writer)에서 승격이 무조건 거부됐고,
  // 그게 봉쇄를 만들었다(CE-28). 28차는 그 봉쇄를 I6(b) **면제**로 풀었다 — 판정을 못
  // 하면 비관적으로 두고 앞으로 간다는 근거였다. **그 "앞으로" 가 세상을 되감았다**:
  // 저널·terminal·좌표가 전부 "gen-B 가 활성화됐다" 고 말하는데 기준만 옛것이고,
  // 수렴은 기준을 정답으로 삼아 **서빙 중인 세대를 되돌리고 `repaired` 라 답했다.**
  //
  // 병은 "판정을 못 한다" 고 적어 놓고 **판정할 재료를 안 찾아본 것**이다.
  // `terminal` 원장의 키가 `operationId:transitionId:plane` 이다 — **닮음이 아니라
  // 신원**이고, 서명과 독립이며, 이 창 이전부터 있었다. 그것을 읽는다.
  //
  // CE-27 은 그대로 닫혀 있다: 거기서는 남(Y)이 옮긴 평면에 대해 후보의 전환 키로 된
  // `terminal` 기록이 **없다.** 이 폴백은 "내가 그 평면을 활성화로 끝냈다" 는 기록이
  // 있을 때만 열린다.
  //
  // **서명을 우선으로 두고 원장은 폴백이다.** 순서를 뒤집어(항상 원장만 보게) 뮤테이션하면
  // **안 죽는다** — 지금 도달 가능한 상태에서는 둘이 동치다. 그래도 이 순서를 쓰는 이유는
  // 둘이 답하는 물음이 다르기 때문이다: 서명은 **"지금 거기 있는 것을 누가 놨나"** 이고
  // 원장은 **"그 전환이 어떻게 끝났나"** 라는 과거의 주장이다. 좌표가 같은 epoch 에서
  // 덮이는 길이 생기면 서명만 그것을 본다.
  //
  // 동치를 동치라고 적는다 — 검출력 없는 것을 있다고 적지 않는다(22차 P8).
  const epochs = s.pendingEpochs ?? epochsFromJournal(s, ids);
  const arrived = candidateArrived(s, candidate, epochs);
  // **세 번째 결과** (31차 CE-31). 30차가 뿌리를 이렇게 적었다 — *"판정이 불능인데
  // 결과 선택지가 승격/폐기 둘뿐이다."* **그리고는 셋째를 만들지 않고 나머지를 폐기
  // 쪽에 배정했다.** 다섯 회차를 그 둘 사이에서 오갔다:
  //
  // ```
  // 27차 봉쇄 → 28차 폐기 통과 → 되감김 → 29차 부분 승격 + 나머지 봉쇄
  //          → 30차 나머지 폐기 통과 → 되감김
  // ```
  //
  // 폐기가 왜 되감김인가: 폐기는 **낡은 `lastActivated` 를 정답 권위로 남긴다.**
  // 좌표·저널·terminal 이 전부 새 세대를 말하는데 기준만 옛것이면, 수렴은 기준을
  // 정답으로 삼아 **서빙 중인 세대를 되감고 `repaired` 라 답한다.**
  //
  // 셋째 결과는 **기준 폐위**다. 선언한 전 평면이 목표 좌표에 **도착했는데**(I3 에 의해
  // 좌표는 앞으로만 가므로, 이것은 세상이 기준을 지나쳤다는 증명이다) 그것을 내 공로로
  // 셀 수 없으면 — 승격도 아니고, 옛 기준을 권위로 남기는 것도 아니다. **기준이 더 이상
  // 권위가 아니라고 적는다.**
  //
  // 그러면 수렴의 기존 분기가 받는다: 기준이 없고 게시 의도가 있으면 `dirty` —
  // 부작용 0, 봉쇄 0, 되감김 0, 그리고 진단이 정직하다("기준을 보증 못 한다").
  // 표면은 안 움직인다. `dirty` 는 이미 계약에 있다.
  //
  // ⚠️ **이 절은 레거시 창의 것이 아니다** (32차 CE-32-A). 27~31차 내내 이 문제를
  // "26차 이전 writer 가 남긴 상태" 라고 불렀는데 **그 이름이 거짓이었다.** 여기는
  // `by === undefined` 를 **안 본다** — 서명이 온전한 지금 세상에서도 혼합 저자 +
  // 지연 finalize 면 같은 상태가 만들어지고, 이 절이 없으면 **세상 되감김**이다.
  // 31차는 그것을 우연히 함께 고쳤고 겨눈 테스트가 0 개였다.
  //
  // **좁히지 마라.** "레거시니까 마이그레이션으로 없애자" 는 판단이 32차에 부결된 이유가
  // 이것이다. 좁히면 상(上)급 되감김이 전 스위트 초록인 채 돌아온다 — 그 자리를 지금은
  // conformance 둘이 지킨다(레거시 변형·서명 변형).
  const positionsReached = epochs !== undefined && Object.entries(epochs).every(
    ([plane, epoch]) => s.planes[plane as Plane]?.activationEpoch === epoch,
  );
  if (arrived) s.lastActivated = candidate;
  else if (positionsReached) delete s.lastActivated;
  // 뮤테이션 스윕이 이 두 줄을 지워도 아무것도 안 빨개진다고 알려줬다. **동치다** —
  // 남은 후보가 나중에 "도착" 이 되려면 좌표가 움직여야 하는데, 좌표는 `commit` 으로만
  // 움직이고 `commit` 은 후보를 자기 것으로 덮어쓴다. 되살아날 길이 없다.
  //
  // 그래도 지운다. 끝난 것을 남겨 두면 상태를 읽는 사람이 "진행 중" 으로 읽는다.
  delete s.pendingActivation;
  delete s.pendingEpochs;
}

/**
 * 저널이 기억하는 완결의 뜻 (17차 반례 A).
 *
 * 후보에 뜻이 없는 상태에서도 저널이 같은 전환을 가리키면 거기서 가져온다. **저널은
 * 실행권 아래서 쓰였다** — 호출자가 그때그때 넘기는 것과 다르다.
 */
function epochsFromJournal(
  s: AgentState,
  ids: { operationId: string; transitionId: string },
): Record<string, string> | undefined {
  const j = s.journal;
  if (j === undefined) return undefined;
  if (j.op.operationId !== ids.operationId || j.op.transitionId !== ids.transitionId) {
    return undefined;
  }
  return epochsOf(j.op);
}

/** 오퍼레이션이 선언한 평면별 목표 epoch. */
function epochsOf(op: ApplyOperation): Record<string, string> {
  const out: Record<string, string> = {};
  for (const plane of ['http', 'stream'] as const) {
    const target = op.planes[plane];
    if (target !== undefined) {
      out[plane] = normalizeNumeric(target.target.activationEpoch, 'activationEpoch');
    }
  }
  return out;
}

/** 오퍼레이션이 선언한 평면들. */
function planesOfOperation(op: ApplyOperation): Plane[] {
  return (['http', 'stream'] as const).filter((p) => op.planes[p] !== undefined);
}

/**
 * **이 저널이 그 오퍼레이션의 것인가.**
 *
 * 열네 회차 동안 같은 병형이 반복됐다 — **새 판정 자리를 만들 때마다 신원 비교(id +
 * 토큰)를 한 번씩 빠뜨린다.** `releaseHolderSlots`(9차 반례 ③) · `finishOperation`
 * (10차 반례 ③) 이 각각 그렇게 물렸고, 20차에 만든 `closeJournal` 이 또 그랬다 —
 * 낡은 리더의 지연 abort 가 신임의 진행 중 저널을 `failed` 로 닫았다.
 *
 * 그래서 **한 곳으로 모은다.** 새 자리를 만들 때 이걸 부르면 빠뜨릴 수가 없다.
 * `Settled` 표가 "어디서 검사하나" 를 모은 것과 같은 수법이다.
 */
/**
 * 이 좌표를 **이 신원이** 놨는가 (26차).
 *
 * 임계구역 안팎에서 같이 쓰므로 순수 함수다 — `this.coordinate()` 를 쓰면 `serial()`
 * 안에서 스냅샷과 작업 중인 상태가 갈릴 수 있다.
 */
function authoredBy(
  at: PlaneState | undefined,
  who: { operationId: string; transitionId: string; leaderToken: string },
): boolean {
  const by = at?.by;
  if (by === undefined) return false;
  return by.operationId === who.operationId
    && by.transitionId === who.transitionId
    && normalizeNumeric(by.leaderToken, 'leaderToken')
      === normalizeNumeric(who.leaderToken, 'leaderToken');
}

/**
 * 이 슬롯이 **이 전환의 것**인가 (41차 CE-41-A).
 *
 * `ownsJournal` 과 같은 삼중 비교인데 대상이 저널이 아니라 예약이다. 자리가 갈리면
 * 언젠가 하나가 뒤처지므로 술어를 따로 두되 같은 모양으로 쓴다.
 */
type Identity = { operationId: string; transitionId: string; leaderToken: string };

function ownsSlotOp(slot: Identity | undefined, op: Identity): boolean {
  if (slot === undefined) return false;
  return slot.operationId === op.operationId
    && slot.transitionId === op.transitionId
    && normalizeNumeric(slot.leaderToken, 'leaderToken')
      === normalizeNumeric(op.leaderToken, 'leaderToken');
}

export function ownsJournal(j: JournalEntry | undefined, op: ApplyOperation): boolean {
  if (j === undefined) return false;
  return j.op.operationId === op.operationId
    && j.op.transitionId === op.transitionId
    && normalizeNumeric(j.op.leaderToken, 'leaderToken')
      === normalizeNumeric(op.leaderToken, 'leaderToken');
}

/** 두 기록이 **같은 활성화 사건**인가. 세대 이름만 같아서는 안 된다. */
function sameRecordIdentity(a: PublishRecord, b: PublishRecord): boolean {
  return a.generation === b.generation
    && a.generationDigest === b.generationDigest
    && a.operationId === b.operationId
    && a.transitionId === b.transitionId
    && a.leaderToken === b.leaderToken;
}

/**
 * **어느 절이 방어적인가** (뮤테이션 스윕이 알려줬다).
 *
 * 아래를 지워도 529 개가 전부 초록이다 — **"스위트가 못 가른다" 는 뜻이지 "도달하는
 * 길이 없다" 는 뜻이 아니다** (40차 지적). 원래 뒤엣말로 적혀 있었다. 같은 파일 아래쪽에
 * 그 오독을 "내 실수" 라고 이름 붙여 놓고, 이 문장은 안 고쳤다 — **이름을 붙이는 것과
 * 전 자리를 고치는 것은 다른 일이다.**
 *
 *   · I1 의 예약 토큰 절 (`slot.op.leaderToken > max`) — `acquire` 가 `assertLeader`
 *     뒤에 오므로 최신보다 높은 토큰의 예약이 만들어지지 않는다.
 *   · I7 의 종단 **변경** 절 (`now !== was`) — `finalize` 가 이미 종단이면 안 쓴다.
 *     삭제 절도 마찬가지다(그건 이미 적어 뒀다).
 *
 * 남기는 이유는 하나다: **그 전제를 깨는 변경이 오면 여기가 소리를 낸다.** 다만 이
 * 목록을 근거로 "상태 축은 전부 검사된다" 고 읽으면 안 된다. 실제로 이빨이 확인된 절은
 * I1 의 실행권 토큰 · I3 의 단조성 · I5 의 새 intent · I6 둘이다.
 */
export function assertInvariants(before: AgentState | undefined, next: AgentState): void {
  const big = (v: string): bigint => BigInt(v);

  // ── I1. 최신 토큰만 변이한다 ──────────────────────────────────────────
  const max = big(next.maxLeaderToken);
  const holder = next.activeOperation;
  if (holder !== undefined && big(holder.leaderToken) !== max) {
    throw new InvariantViolation(
      'I1 최신 토큰만 변이',
      `실행권을 쥔 토큰 ${holder.leaderToken} 이 최신 ${next.maxLeaderToken} 과 다르다`,
    );
  }
  for (const plane of ['http', 'stream'] as const) {
    for (const [epoch, slot] of Object.entries(next.reservations[plane])) {
      if (big(slot.op.leaderToken) > max) {
        throw new InvariantViolation(
          'I1 최신 토큰만 변이',
          `${plane}:${epoch} 예약이 최신보다 높은 토큰 ${slot.op.leaderToken} 을 들고 있다`,
        );
      }
    }
  }

  // ── I5. 기록된 게시는 fenced 다 ──────────────────────────────────────
  for (const [what, record] of [
    ['lastPublishIntent', next.lastPublishIntent],
    ['lastActivated', next.lastActivated],
    ['pendingActivation', next.pendingActivation],
  ] as const) {
    if (record !== undefined && big(record.leaderToken) > max) {
      throw new InvariantViolation(
        'I5 intent 는 fenced',
        `${what} 의 토큰 ${record.leaderToken} 이 최신 ${next.maxLeaderToken} 보다 높다`,
      );
    }
  }

  // I5 를 한 겹 더 조인다 — **새로 쓰이는** 기록은 최신 토큰이어야 한다 (14차 모델).
  // `<= max` 만 보면 낡은 리더가 신임의 의도를 덮는 것을 못 잡는다.
  if (before !== undefined
    && next.lastPublishIntent !== undefined
    && (before.lastPublishIntent === undefined
      || before.lastPublishIntent.operationId !== next.lastPublishIntent.operationId
      || before.lastPublishIntent.transitionId !== next.lastPublishIntent.transitionId
      || before.lastPublishIntent.generation !== next.lastPublishIntent.generation)
    && big(next.lastPublishIntent.leaderToken) !== max) {
    throw new InvariantViolation(
      'I5 intent 는 fenced',
      `새 intent 가 토큰 ${next.lastPublishIntent.leaderToken} 으로 쓰였다 (최신 ${next.maxLeaderToken})`,
    );
  }

  if (before === undefined) return;

  // ── I3. 넘어간 것은 되돌아가지 않는다 ────────────────────────────────
  if (big(next.maxLeaderToken) < big(before.maxLeaderToken)) {
    throw new InvariantViolation(
      'I3 되돌아가지 않는다',
      `리더 토큰이 ${before.maxLeaderToken} 에서 ${next.maxLeaderToken} 으로 되감겼다`,
    );
  }
  for (const plane of ['http', 'stream'] as const) {
    const was = big(before.planes[plane].activationEpoch);
    const now = big(next.planes[plane].activationEpoch);
    if (now < was) {
      throw new InvariantViolation(
        'I3 되돌아가지 않는다',
        `${plane} 좌표가 ${was} 에서 ${now} 로 되돌아갔다 — commit 은 취소되지 않는다`,
      );
    }
  }
  // ── I6. 기준은 후보를 거쳐서만 생기고, 활성화는 기준을 남긴다 ────────
  //
  // **처음 쓴 I6 은 틀렸다.** "후보가 사라지면 승격됐거나 저널이 activated 가 아니어야
  // 한다" 고 적었는데, 한 평면만 commit 하고 저널 없이 abort 하는 **정당한 경로**를
  // 막았다 (14차 검수). 사라지는 쪽이 아니라 **생기는 쪽**을 봐야 했다.
  //
  //   (a) `lastActivated` 는 직전 후보였던 것만 될 수 있다 — 기준이 허공에서 생기지 않는다
  //   (b) 저널이 `activated` 인데 그 후보가 사라졌으면, 기준이 그것이어야 한다
  //
  // (b) 가 14차가 지목한 버그를 덮는다 — 활성화해 놓고 기준을 승격 없이 지우는 것.
  const droppedCandidate = before.pendingActivation;
  // **참조로 비교하면 안 된다.** `serial()` 이 매번 `structuredClone` 하므로 값이 그대로여도
  // 객체는 늘 다르다. 그걸로 판정하면 모든 쓰기가 "기준이 움직였다" 가 된다.
  const baselineMoved = next.lastActivated === undefined
    ? before.lastActivated !== undefined
    : before.lastActivated === undefined
      || !sameRecordIdentity(next.lastActivated, before.lastActivated);
  if (baselineMoved && next.lastActivated !== undefined) {
    if (droppedCandidate === undefined || !sameRecordIdentity(next.lastActivated, droppedCandidate)) {
      throw new InvariantViolation(
        'I6 기준은 후보를 거쳐서만 생긴다',
        `${next.lastActivated.generation} 이 후보를 거치지 않고 기준이 됐다`,
      );
    }
  }
  // 28차에 여기 **면제**를 달았다 — 서명 없는 좌표에서는 (b) 를 끄는 것이었다.
  // 30차에 그 자리를 아예 다시 세웠다(아래).
  // **뺐다** (29차). 면제는 CE-28 의 봉쇄를 푸는 우회였고 그 우회가 CE-29(세상 되감김)를
  // 열었다. 이제 `finalizeCandidate` 가 `terminal` 원장으로 제대로 승격하므로 그 상태
  // 자체가 안 생긴다. **증상을 끄는 대신 원인을 고쳤다.**
  //
  // 그리고 29차가 실측했다: (b) 를 통째로 꺼도 569 전부 초록이다 — **(b) 는 지금
  // 장식이다.** 28차가 면제의 안전 근거로 든 두 측정("P11 이 잡는다", "승격 차단
  // 뮤턴트 112 건")은 **승격 기능의 백업**을 잰 것이지 (b) 의 검출력을 잰 것이 아니었다.
  // 근거를 적었지만 그 근거가 재는 대상이 달랐다 — 이 시리즈가 네 회차째 반복하는 병이다.
  // **저널을 믿지 않고 좌표를 본다** (30차 CE-30).
  //
  // (b) 는 "저널이 `activated` 인데 후보가 승격 없이 사라졌다" 를 위반으로 봤다. 즉
  // **저널의 주장을 전제로 삼았다.** 그런데 26차 이전 writer 의 저널은 닮음으로 판정해
  // 쓴 것이라 거짓일 수 있다 — 혼합 저자인데 `activated` 라고 적혀 있는 상태가 실재한다.
  // 그러면 후보는 정당하게 승격되지 않는데 (b) 가 발화해 **영구 봉쇄**가 된다.
  //
  // 28차는 이것을 면제로 껐다가 되감김을 열었고(CE-29), 29차는 판정 가능한 부분집합만
  // 승격으로 옮겼다가 나머지에서 봉쇄를 재도입했다(CE-30). **같은 창을 양쪽으로 오갔다.**
  //
  // 뿌리는 (b) 의 전제였다. 이제 **좌표가 도착을 증명할 때만** 발화한다 — 그러면
  // (b) 가 원래 잡으려던 버그("도착했는데 승격을 안 했다")는 그대로 잡고, 저널이
  // 거짓말한 경우는 봉쇄 대신 통과한다. 판정은 `candidateArrived` 하나가 한다.
  //
  // **이 수정이 (b)의 이빨을 되찾아 준 것은 아니다.** 재 봤다 — (b)를 통째로 꺼도
  // 572 전부 초록이다(29차 측정과 같다). 바뀐 것은 **잘못 발화하던 것이 멈춘 것**뿐이고,
  // 검출력은 여전히 0 이다. 되찾았다고 적고 싶었지만 재 보니 아니었다.
  const arrivedForReal = droppedCandidate !== undefined
    && candidateArrived(
      next,
      droppedCandidate,
      before.pendingEpochs ?? epochsFromJournal(before, droppedCandidate),
    );
  const j6 = next.journal;
  if (j6 !== undefined
    && arrivedForReal
    && j6.phase === 'activated'
    && droppedCandidate !== undefined
    && next.pendingActivation === undefined
    && j6.op.operationId === droppedCandidate.operationId
    && j6.op.transitionId === droppedCandidate.transitionId) {
    if (next.lastActivated === undefined || !sameRecordIdentity(next.lastActivated, droppedCandidate)) {
      throw new InvariantViolation(
        'I6 활성화는 기준을 남긴다',
        `${droppedCandidate.generation} 을 활성화해 놓고 기준으로 올리지 않은 채 후보를 지웠다`,
      );
    }
  }

  // ── I7. 한 번 적은 판정과 근거는 지워지지 않는다 ─────────────────────
  //
  // 14차 검수가 준 술어. `terminal` 은 "이 전환은 이렇게 끝났다" 이고 `activationEvidence`
  // 는 "왜 그 좌표로 옮겼나" 다. 둘 다 **사후에 답할 수 있어야** 의미가 있는 기록이다.
  // 지워지거나 조용히 바뀌면 장애 분석이 근거를 잃는다.
  //
  // 되돌아가지 않는 것(I3)과 다르다. I3 은 좌표가 뒤로 가지 않는다는 것이고, 이건
  // **판정 자체가 사라지지 않는다**는 것이다.
  //
  // **지금은 이빨이 없다** — 뮤테이션으로 확인했다. `release` 가 종단 기록을 지우게 만들어도
  // 아무 테스트도 빨개지지 않는다. 그 경로에 종단 기록이 있는 상태로 도달하는 테스트가
  // 없기 때문이다. 즉 이 불변식은 지금 코드의 버그를 잡는 게 아니라, **앞으로 이 기록들을
  // 지우기 시작하는 변경**을 막는다. 근거 기록 자체가 되는지는 `evidenceFor` 를 보는
  // 테스트 셋이 지킨다(그건 뮤테이션으로 잡힌다).
  for (const [key, was] of Object.entries(before.terminal)) {
    const now = next.terminal[key];
    if (now === undefined) {
      throw new InvariantViolation('I7 판정은 지워지지 않는다', `종단 기록 ${key} 가 사라졌다`);
    }
    if (now !== was) {
      throw new InvariantViolation(
        'I7 판정은 바뀌지 않는다',
        `${key} 의 종단이 ${was} 에서 ${now} 로 바뀌었다`,
      );
    }
  }
  // **"지워지지 않는다" 에서 "서 있는 자리의 근거는 지워지지 않는다" 로 좁혔다** (빚 갚기).
  //
  // 원래 절은 근거를 하나도 못 지우게 했고, 그래서 이 표가 **무한히 자랐다** — 측정했다:
  // 전환 200 개에 항목 200 개다. 이 표는 사후 감사용이고 프로덕션 독자가 없어서
  // 보존 창을 두는 것이 그 목적에 맞다.
  //
  // 그러나 **지금 서 있는 좌표의 근거**는 다르다. 그건 과거가 아니라 현재에 대한 물음이고
  // ("우리는 왜 여기 있나"), 지우면 답할 사람이 없다. 그것만 지킨다 — 그리고 이 절은
  // 원래 절과 달리 **뜻이 있다**: 지우면 안 되는 것을 이름 지어 말한다.
  //
  // **다만 이빨은 재 보니 조건부다.** 서 있는 자리를 지우는 뮤턴트를 넣었더니 잡은 것은
  // 이 절이 아니라 conformance 테스트였다 — `prune` 이 `assertInvariants` **앞에서**
  // 돌기 때문에, 근거가 만들어진 **그 쓰기에서** 지워지면 `before` 에 없어서 이 비교가
  // 못 본다. 나중 쓰기에서 지우는 경우만 잡는다.
  //
  // 원래 절(검출력 0)보다는 낫다.
  //
  // **처음엔 "검출기는 테스트다" 라고 적었는데, 무대가 없어서였다** (35차 검수 3-B).
  // 두 평면을 같이 미는 시나리오에서는 서 있는 근거가 늘 최신이라 보존 창만으로 살아남아
  // 이 절을 안 지나간다. **한 평면을 세워 두고 다른 평면만 옮기면** 세워 둔 근거가 창
  // 밖으로 밀리고, 그때 이 절이 **실제로 발화한다**(뮤테이션으로 확인).
  //
  // "이빨이 없다" 가 아니라 **"그 이빨을 지나가는 무대가 없었다"** 였다. 둘은 다르다 —
  // 이 레포가 반복해서 뒤바꾼 그 둘이다.
  const standing = new Set(
    (Object.keys(next.planes) as Plane[]).map((p) => `${p}:${next.planes[p].activationEpoch}`),
  );
  for (const key of Object.keys(before.activationEvidence)) {
    if (next.activationEvidence[key] === undefined && standing.has(key)) {
      throw new InvariantViolation(
        'I7 서 있는 자리의 근거는 지워지지 않는다',
        `${key} 로 옮긴 근거가 사라졌다 — 지금 왜 여기 있는지 답할 수 없게 된다`,
      );
    }
  }

  const wasSeq = before.journal?.seq;
  const nowSeq = next.journal?.seq;
  if (wasSeq !== undefined && nowSeq !== undefined && nowSeq < wasSeq) {
    throw new InvariantViolation(
      'I3 되돌아가지 않는다',
      `저널 seq 가 ${wasSeq} 에서 ${nowSeq} 로 되감겼다`,
    );
  }
}

export class DpAgent {
  /** 직렬화 큐. 임계구역이 하나씩만 돌게 만든다. */
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * apply **실행** 큐 (6차 반례 ③).
   *
   * 저널 `seq` CAS 는 *쓰기* 를 직렬화하지만 실행까지 막지는 못한다. 진 러너가 다시 읽고
   * 따라가는 사이 아직 신호가 반영되지 않았으면 "재전송할 차례" 로 보이고, 그래서 HUP 이
   * 하나 더 나간다. 실측으로 2회가 나왔다.
   *
   * 상태기계는 **한 번에 하나만** 돌아야 한다. 프로세스 간 배제는 `FileStore` 의 락이
   * 맡고, 프로세스 안은 이 큐가 맡는다.
   */
  private applyTail: Promise<unknown> = Promise.resolve();

  /** apply 상태기계를 한 번에 하나만 돌린다. */
  exclusiveApply<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.applyTail.then(fn);
    this.applyTail = run.catch(() => undefined);
    return run;
  }

  constructor(private readonly store: DurableStore) {}

  /** 내부에서 보는 상태. 저장소에게는 불투명하지만 우리는 모양을 안다. */
  private snapshot(): AgentState {
    return (this.store.load()?.payload as AgentState | undefined) ?? initial();
  }

  /** 지금까지 본 최대 리더 토큰. 이보다 낮은 토큰의 변이는 전부 거부된다 (§3.5). */
  maxLeaderToken(): string {
    return this.snapshot().maxLeaderToken;
  }

  coordinate(plane: Plane): PlaneState {
    return { ...this.snapshot().planes[plane] };
  }

  /** 아직 활성화되지 않은 슬롯의 digest. 없으면 undefined. */
  stagedDigest(plane: Plane, epoch: string): string | undefined {
    return this.snapshot().reservations[plane]?.[epoch]?.stagedDigest;
  }

  /** 슬롯의 주인. 없으면 undefined. */
  reservationOwner(plane: Plane, epoch: string): OperationTuple | undefined {
    return this.snapshot().reservations[plane]?.[epoch]?.op;
  }

  /** 마지막으로 활성화를 인정한 게시. reconcile 의 기준이다. */
  lastActivated(): PublishRecord | undefined {
    return this.snapshot().lastActivated;
  }

  /**
   * **한 번에 읽는 판정 재료** (19차 검수).
   *
   * 전에는 `lastActivated()` · `pendingActivation()` · `readJournal()` 을 따로 불렀다.
   * 인프로세스에서는 `snapshot()` 이 동기라 사이가 안 벌어지고 프로세스 간에는 파일 락이
   * 막지만, **`DurableStore` 는 공개 표면**이다 — 락 없는 구현에서는 그 사이가 벌어진다.
   * 한 스냅샷으로 접으면 공짜로 닫힌다.
   */
  decisionView(): {
    lastActivated: PublishRecord | undefined;
    pendingActivation: PublishRecord | undefined;
    journal: JournalEntry | undefined;
  } {
    const s = this.snapshot();
    return {
      lastActivated: s.lastActivated,
      pendingActivation: s.pendingActivation,
      journal: s.journal,
    };
  }

  /**
   * 아직 기준으로 올라가지 않은 활성화 후보 (17차 반례 A).
   *
   * 이게 있으면 **`lastActivated` 를 정답으로 읽으면 안 된다.** 좌표는 이미 후보 쪽으로
   * 갔을 수 있는데 기준은 그 전 것으로 남아 있기 때문이다.
   */
  pendingActivation(): PublishRecord | undefined {
    return this.snapshot().pendingActivation;
  }

  /** 마지막으로 게시한 것. 활성화까지 갔는지는 모른다. */
  lastPublishIntent(): PublishRecord | undefined {
    return this.snapshot().lastPublishIntent;
  }

  /**
   * 실행권이 들고 있는 **모든** 슬롯을 반납한다 (12차 반례 ④).
   *
   * `finishOperation` 은 넘어온 오퍼레이션이 담은 평면만 본다. 그런데 abort 가 한
   * 평면만 담아 오면 나머지가 고아로 남는다 — 실행권이 자기가 무엇을 잡았는지 알므로
   * 그걸로 지운다.
   */
  releaseHolderSlots(op: ApplyOperation): Promise<void> {
    return this.serial((s) => {
      const holder = s.activeOperation;
      const owner = holder ?? {
        operationId: op.operationId,
        transitionId: op.transitionId,
        leaderToken: normalizeNumeric(op.leaderToken, 'leaderToken'),
        planes: [] as Plane[],
        epochs: {} as Record<string, string>,
      };
      // **토큰까지 본다.** 9차 반례 ③ 과 같은 함정이다 — id 만 비교하면 낡은 abort 가
      // 같은 id 를 쓰는 신임 실행권의 슬롯을 지운다. 그 테스트가 이 회귀를 잡았다.
      if (owner.operationId !== op.operationId
        || owner.transitionId !== op.transitionId
        || owner.leaderToken !== normalizeNumeric(op.leaderToken, 'leaderToken')) {
        return;
      }
      for (const plane of owner.planes) {
        const epoch = owner.epochs[plane];
        if (epoch === undefined) continue;
        const slot = s.reservations[plane]?.[epoch];
        // 여기도 같은 술어를 쓴다 (42차 — 부류를 다 센다). 바로 위 외곽 가드가 홀더를
        // 토큰까지 대조하므로 **구조적으로는 동치**로 보인다. 그런데 "구조적 무해" 는
        // 내가 두 번 틀린 논증이고(37차 I1 · 40차 슬롯 전제), 둘 다 **같은 파일 안에
        // 반박이 있었다.** 동치라면 바꿔도 아무것도 안 깨지고, 아니라면 이것이 옳다.
        // **부류를 이름 붙였으면 전 자리를 센다** — 이번 회차의 값이 그것이다.
        if (ownsSlotOp(slot?.op, op)) {
          delete s.reservations[plane][epoch];
        }
      }
      if (holder !== undefined) delete s.activeOperation;
    });
  }

  /** 게시 직전에 의도를 남긴다 (12차 반례 ②). */
  recordPublishIntent(record: PublishRecord): Promise<void> {
    return this.serial((s) => {
      // **낡은 리더는 의도조차 남기지 못한다** (14차 · 모델이 찾았다).
      //
      // 게시 자체는 `lease.assertValid()` 가 막는다. 그런데 의도는 그 **앞에** durable 로
      // 내려간다. 옛 러너가 관측에서 멈춘 사이 신임이 fence 하고 자기 의도를 적어도,
      // 옛 러너가 재개해 그걸 토큰 10 짜리로 덮었다. 바깥은 안 바뀌는데 "지금 무엇을
      // 게시하려는 중인가" 라는 durable 기록만 거짓이 된다 — 수렴의 근거가 거짓이 된다.
      assertLeader(s, normalizeNumeric(record.leaderToken, 'leaderToken'));
      s.lastPublishIntent = record;
    });
  }

  /** 그 좌표로 옮긴 근거. 없으면 undefined. */
  evidenceFor(plane: Plane, epoch: string): ActivationEvidence | undefined {
    return this.snapshot().activationEvidence[`${plane}:${epoch}`];
  }

  /** 전환이 어떻게 끝났는지. 아직이면 undefined. */
  terminalOf(op: OperationTuple): TerminalKind | undefined {
    return this.snapshot().terminal[transitionKey(op)];
  }

  /** 진행 중인 apply 저널. 없으면 undefined. */
  readJournal(): JournalEntry | undefined {
    return this.snapshot().journal;
  }

  /**
   * 저널 쓰기도 **같은 직렬 구간**을 지난다. 멤버십 좌표와 저널이 한 소유자 아래 있어야
   * 서로 덮어쓰지 않는다 (5차 반례 ③④).
   */
  /** 지금 apply 경로를 쥔 오퍼레이션. 없으면 undefined. */
  activeOperation(): ActiveOperation | undefined {
    return this.snapshot().activeOperation;
  }

  /**
   * **전 평면을 한 임계구역에서** 예약하고 apply 경로를 잡는다 (6차 반례 ③).
   *
   * 평면마다 따로 예약하면 그 사이에 남이 끼어든다. 그리고 슬롯을 다 잡아도 저널·
   * `current`·HUP 은 전역이라 실행권까지 잡아야 한다.
   *
   * 같은 오퍼레이션의 재요청은 멱등이다 — 이미 자기가 쥐고 있으면 그대로 통과한다.
   */
  /**
   * 전 평면을 잡는다. **첫 저널을 함께 쓸 수 있다** (16차 검수).
   *
   * 전에는 잡기와 첫 저널 쓰기가 두 임계 구간이었다. 그 사이에 끊기면 **실행권만 있고
   * 저널은 없는 상태**가 남고, 복구는 §6.2 #1 대로 `no_operation` 을 돌려주며 아무것도
   * 반납하지 않았다 — 그 뒤 모든 오퍼레이션이 `operation_in_flight` 로 막힌다.
   *
   * 치우는 대신 **그 상태를 없앤다.** 한 번에 쓰면 "실행권이 있는데 저널이 없다" 가
   * 나올 수 없고, 크래시 지점도 하나 줄어든다.
   */
  reserveAll(
    op: ApplyOperation,
    /** 첫 저널. **`seq` 는 여기서 정한다** — 밖에서 읽어 오면 밀린 값이 온다. */
    opening?: Omit<JournalEntry, 'seq'>,
  ): Promise<PlaneAck[]> {
    return this.serial((s) => {
      const tuples = planesOf(op).map((plane) => tupleFor(op, plane));
      const first = tuples[0];
      if (first === undefined) {
        throw new DpRejection('empty_envelope', '봉투가 어떤 평면도 말하지 않았다');
      }
      assertLeader(s, first.leaderToken);

      const holder = s.activeOperation;
      const mine = holder === undefined
        // **여기는 일부러 id 만 본다** (36차 검수가 주석 부재를 짚었다). 같은 id 를
        // 새 토큰으로 **승계**하는 것이 정당한 경로이고, 토큰까지 보면 그 승계가 막힌다.
        // 낡은 호출자는 위 `assertLeader` 가 먼저 죽인다.
        //
        // 옆자리들(청소·개방)은 토큰을 본다. **다르다는 것이 의도라는 것을 적어 둔다** —
        // 안 적으면 다음 사람이 "통일" 하면서 승계를 막는다.
        || (holder.operationId === op.operationId && holder.transitionId === op.transitionId);
      if (!mine) {
        throw new DpRejection(
          'operation_in_flight',
          `${holder!.operationId}:${holder!.transitionId} 가 apply 경로를 쥐고 있다`,
        );
      }

      // **고아를 먼저 치운다** (17차 반례 D · 20차 CE-3 에서 순서를 고쳤다).
      //
      // 처음엔 슬롯을 잡은 **뒤에** 치웠다. 그러면 고아의 예약이 아직 있어서 새
      // 오퍼레이션이 `slot_taken` 으로 죽는다 — "그 좌표는 아무도 못 쓴다" 를 없애려던
      // 수정이 같은 증상을 한 칸 옆에 다시 만든 것이다.
      //
      // 여기 오는 시점에 실행권은 없다(있으면 위에서 `operation_in_flight` 로 막혔다).
      // 그 저널은 고아이므로 닫는 것이 안전하다.
      const stale = s.journal;
      // **토큰까지 본다** (빚 갚기 — 가지치기와 한 커밋). 21차에 신원 비교를
      // `ownsJournal()` 로 모아 놓고 **정작 이 자리가 그것을 안 썼다.** id 만 비교하면
      // fence 뒤 신임이 **같은 id** 를 다시 낼 때 옛 저널을 "내 것" 으로 읽어 청소하지
      // 않고, 조용히 물러나 홀더를 남긴 채 **다음 오퍼레이션이 영구 봉쇄**된다.
      //
      // 23차가 이 경로를 **모의**로 재현하며 "캐시가 지우고 있을 뿐" 이라고 적었다.
      // 이제 가지치기가 실물이라 그 방패가 없어졌고, 경로가 진짜로 열렸다 —
      // `debt-completed-prune.test.ts` 가 그것이다.
      const staleIsMine = ownsJournal(stale, op);
      if (opening !== undefined && stale !== undefined && !staleIsMine
        && !isTerminalPhase(stale.phase)) {
        // **자기 이름은 안 찍는다** (34차 검수 B). `transitionKey` 에는 토큰이 없다 —
        // `opId:tid:plane` 이다. 그래서 같은 id 를 새 토큰으로 재발급하면 고아가 된 옛
        // 전환과 **키가 같다.** 그대로 찍으면 몇 줄 아래 `admit` 이 그것을 읽고
        // **자기를 거부한다.**
        //
        // 게다가 그 쓰기는 `serial()` 이 예외와 함께 버리므로 **원장에는 남지도 않는다** —
        // "이미 aborted 로 끝났다" 고 답하는데 원장에는 그 기록이 없다. 진단이 거짓이고,
        // 같은 id 재발급이 결정적으로 반복 거부된다.
        //
        // 안 찍어도 잃는 것이 없다: 옛 전환은 바로 아래 `supersede` 로 닫히고, 그 토큰의
        // 지연 RPC 는 `assertLeader` 가 fence 로 이미 막는다.
        const mine = new Set(planesOf(op).map((plane) => transitionKey(tupleFor(op, plane))));
        for (const plane of planesOf(stale.op)) {
          const key = transitionKey(tupleFor(stale.op, plane));
          if (s.terminal[key] === undefined && !mine.has(key)) s.terminal[key] = 'aborted';
        }
        supersede(s, {
          operationId: stale.op.operationId,
          transitionId: stale.op.transitionId,
          leaderToken: normalizeNumeric(stale.op.leaderToken, 'leaderToken'),
          planes: planesOf(stale.op),
          epochs: Object.fromEntries(
            planesOf(stale.op).map((plane) => [
              plane,
              normalizeNumeric(stale.op.planes[plane]!.target.activationEpoch, 'activationEpoch'),
            ]),
          ),
        });
      }

      // 전부 잡거나 하나도 안 잡는다. `acquire` 가 던지면 이 임계구역의 변경은
      // 저장되지 않으므로 롤백이 따로 필요 없다.
      const acks = tuples.map((t) => {
        const replay = admit(s, t, 'reserve');
        if (replay !== undefined) return replay;
        acquire(s, t);
        return record(s, t, 'reserve', { ...t.target, payloadDigest: t.payloadDigest });
      });

      s.activeOperation = {
        operationId: op.operationId,
        transitionId: op.transitionId,
        leaderToken: first.leaderToken,
        planes: tuples.map((t) => t.plane),
        epochs: Object.fromEntries(tuples.map((t) => [t.plane, t.target.activationEpoch])),
      };
      // **같은 쓰기에 저널을 얹는다.** 실행권만 있고 저널이 없는 상태를 만들지 않는다.
      //
      // `seq` 를 **여기서** 정한다. 처음엔 호출자가 읽어 온 값을 그대로 썼는데, 두 러너가
      // 같은 값을 읽고 둘 다 쓰면 seq 가 되감긴다 — **모델이 즉시 잡았다**(I3).
      // `writeJournal` 이 하는 CAS 를 우회한 것이었다.
      //
      // 같은 오퍼레이션의 저널이 이미 있으면 그대로 둔다. 이어받는 것이다.
      if (opening !== undefined) {
        const existing = s.journal;
        // **토큰까지 본다** (35차 CE-35-A). 몇 줄 위 청소는 `ownsJournal` 로 토큰을 보는데
        // 여기만 id 를 봤다 — **한 함수 안에서 두 판정이 갈렸다.** 청소는 "남의 것" 이라
        // supersede 하는데 개방은 "내 것" 이라 새 저널을 안 열었고, 그 뒤 `driveLoop` 가
        // (34차 C 수정으로 토큰을 보게 되어) 그 저널을 "남의 것" 으로 읽고 물러났다.
        // 결과는 `no_operation` + **예약 잔존**이다 — 진단이 거짓이고, 같은 좌표를 미는
        // 다른 오퍼레이션이 `slot_taken` 으로 죽는다.
        //
        // 빚갚기가 "가지치기와 신원 비교는 한 커밋"(23차 규칙)을 자처해 놓고 이 함수의
        // 세 자리 중 하나를 빠뜨렸다. **자리를 세는 것이 규칙을 만드는 일의 절반이다** —
        // 27차에 같은 말을 적고 또 그랬다.
        const mine = ownsJournal(existing, op);
        if (!mine) {
          s.journal = { ...opening, seq: (s.journal?.seq ?? existing?.seq ?? 0) + 1 };
        }
      }
      return acks;
    });
  }

  /**
   * apply 경로를 놓는다. 예약이 남아 있으면 함께 반납한다 (6차 반례 ④).
   *
   * 종단에 도달했는데 소유권이나 예약이 남으면 그 좌표는 영구히 잠긴다.
   */
  /**
   * **낡은 전환이 남긴 예약을 반납한다** (21차 CE-B).
   *
   * 저널만 닫고 슬롯을 두면 `status()` 는 깨끗한데 같은 좌표의 새 오퍼레이션이
   * `slot_taken` 으로 죽는다. 실행권은 이미 없으므로(고아) 반납이 안전하다.
   */
  releaseStaleSlots(op: ApplyOperation): Promise<void> {
    return this.serial((s) => {
      if (s.activeOperation !== undefined) return; // 주인이 있으면 손대지 않는다
      for (const plane of planesOfOperation(op)) {
        const epoch = normalizeNumeric(
          op.planes[plane]!.target.activationEpoch, 'activationEpoch',
        );
        const slot = s.reservations[plane]?.[epoch];
        // **토큰까지 본다** (41차 CE-41-A).
        //
        // 40차에 여기 "불가지" 라벨을 붙이며 *"신임의 슬롯은 홀더 없이 존재할 수 없으므로
        // 홀더가 없으면 남은 슬롯은 낡은 것뿐이다"* 라고 적었다. **거짓이었고, 반박이
        // 이 파일 100 줄 아래에 이미 있었다** — `reclaimOperation` 의 주석이
        // *"비종단 저널인데 실행권이 없는 상태가 만들어질 수 있다 … **예약 슬롯은 그대로
        // 남아 있으므로**"* 라고 적어 놓았다. 내가 쓴 전제를 이 레포가 이미 반박하고
        // 있었는데 **같은 파일을 안 읽었다.**
        //
        // 그러면 같은 id 를 승계한 신임의 슬롯이 홀더 없이 존재하고, 낡은 러너의 지연
        // 반납이 id 만 보고 **그것을 지운다** — 그 좌표를 남이 잡을 수 있게 된다.
        // 9차 반례 ③ 부류다.
        //
        // **그리고 이 자리를 찾아 준 것은 "불가지" 라벨이다.** "무해하다" 고 적었으면
        // 아무도 안 봤다. 그게 40차 규칙의 값이다.
        if (ownsSlotOp(slot?.op, op)) {
          delete s.reservations[plane][epoch];
        }
      }
    });
  }

  /**
   * **포기한 전환의 저널을 닫는다** (20차 CE-1).
   *
   * `abortConfig` 의 계약은 "전환을 종단 상태로 닫는다" 인데 **저널을 안 닫고 있었다.**
   * 그래서 `unfinished`(저널 phase 를 본다)가 죽은 전환을 "안 끝났다" 고 답했다 —
   * 운영자가 포기를 선언했는데 시스템이 "복구해라" 라고 하고, 그동안 진짜 드리프트
   * 수리를 거부한다.
   *
   * **리더 검사를 하지 않는다.** 닫는 것은 되돌릴 수 없는 연산이 아니고, 이걸 막으면
   * 신임이 들어온 뒤 고아가 영영 안 닫힌다(20차 CE-2 가 그 모양이었다).
   */
  /**
   * **이 전환이 어디까지 갔는가** (23차 CE-A).
   *
   * §3.4("어디까지 갔는지 말한다")는 **네 번을 재발했다** — 13차 ③(`failAll`) ·
   * 21차 CE-C(`abortConfig` 가 "다 실패했다" 로 넘어간 평면을 숨김) · 22차 R2(전부
   * 넘어갔는데 "부분") · 23차 CE-A. 매번 자리를 하나씩 고쳤고 매번 다음 자리가 났다.
   *
   * 마지막 것의 모양이 원인을 보여 준다. 22차 R2 는 `moved.length === all` 을 옳게
   * 썼지만 `all` 을 **호출자가 넘긴 봉투**에서 셌다. 한 평면짜리 봉투가 오면 `all === 1`
   * 이라 나머지가 옛 세대여도 "전부" 가 된다 — 저널을 닫을 자격(`ownsJournal`)은 id 와
   * 토큰만 보지 평면은 안 보기 때문에 좁은 봉투가 넓은 저널을 닫는다.
   *
   * 그래서 **평면 집합을 인자로 받지 않는다.** 저널의 op 에서 가져온다. 저널은 실행권
   * 아래서 쓰였으니 호출자가 준 것이 아니고, 그것이 이 전환의 진짜 크기다 — 17차가
   * `pendingEpochs` 를 저널에서 가져오기로 한 것과 같은 근거다. `ownsJournal()` 이
   * "무엇을 비교하나" 를 한 함수로 모은 것처럼, 이건 **"무엇을 세나" 를 모은다.**
   * 셀 대상을 못 고르면 잘못 고를 수도 없다.
   */
  /**
   * **이 평면을 내가 옮겼는가.** 닮음이 아니라 서명을 읽는다 (26차).
   *
   * 판정을 한 함수로 모은다 — 25차가 digest 조임을 `reachedPhase()` 에만 넣고
   * `failAll` 의 평면별 판정에 안 넣어서, 한 결과 안에서 phase 와 progress 가
   * **서로 모순**되게 만들었다. 자리가 둘이면 언젠가 갈린다.
   *
   * `ownsJournal()` 과 같은 삼중 비교다 — id 만으로는 fence 뒤 같은 id 재사용을 못 가른다.
   */
  movedByMe(op: ApplyOperation, plane: Plane): boolean {
    const at = this.coordinate(plane);
    return at.activationEpoch === tupleFor(op, plane).target.activationEpoch
      && authoredBy(at, op);
  }

  reachedPhase(): 'activated' | 'partial_exhausted' | 'failed' | undefined {
    const j = this.readJournal();
    if (j === undefined) return undefined;
    const planes = planesOf(j.op);
    const moved = planes.filter((plane) => this.movedByMe(j.op, plane));
    if (moved.length === planes.length) return 'activated';
    return moved.length > 0 ? 'partial_exhausted' : 'failed';
  }

  closeJournal(
    op: ApplyOperation,
    how: 'failed' | 'superseded' | 'partial_exhausted' | 'activated',
  ): Promise<void> {
    return this.serial((s) => {
      const j = s.journal;
      if (!ownsJournal(j, op)) return;
      if (j === undefined || isTerminalPhase(j.phase)) return;
      s.journal = { ...j, phase: how, seq: j.seq + 1 };
    });
  }

  /**
   * **저널이 없는 실행권을 놓는다** (16차 검수).
   *
   * §6.2 #1 — 첫 저널 쓰기 전에 끊겼으면 부작용도 없다. "실패" 가 아니라 "없던 일" 이다.
   * 그런데 없던 일로 치면서 **실행권과 예약은 그대로 뒀다.** 그러면 그 뒤 모든 오퍼레이션이
   * `operation_in_flight` 로 막힌다 — 영구히.
   *
   * 이제 `run()` 이 잡기와 첫 저널을 한 쓰기로 하므로 표면 경로에서는 이 상태가 생기지
   * 않는다. 이건 **그래도 생겼을 때를 위한 안전망**이다 — 옛 버전이 남긴 상태나
   * `DpAgent` 를 직접 쓰는 경로.
   *
   * 저널이 없으면 아무 일도 없었으므로 놓는 것이 안전하다.
   */
  releaseIdleHolder(): Promise<boolean> {
    return this.serial((s) => {
      const holder = s.activeOperation;
      if (holder === undefined) return false;
      if (s.journal !== undefined) return false; // 진행 중이다 — 손대지 않는다
      for (const plane of holder.planes) {
        const epoch = holder.epochs[plane];
        if (epoch !== undefined) delete s.reservations[plane][epoch];
      }
      delete s.activeOperation;
      return true;
    });
  }

  /**
   * **고아가 된 저널을 다시 잡는다** (14차 · 모델이 찾았다).
   *
   * 비종단 저널인데 실행권이 없는 상태가 만들어질 수 있다 — 같은 오퍼레이션을 미는 러너가
   * 둘이면, 하나가 저널을 쓴 뒤 다른 하나가 종단에 닿아 실행권을 놓는다. 그러면 복구가
   * `not_reserved` 로 죽고 **그 전환은 영구히 막힌다.**
   *
   * 복구가 할 일은 세상을 있는 그대로 다시 잡는 것이다. 예약 슬롯은 그대로 남아 있으므로
   * 실행권만 되돌려 놓으면 이어서 밀 수 있다. **주인이 있으면 손대지 않는다.**
   */
  reclaimOperation(op: ApplyOperation): Promise<boolean> {
    return this.serial((s) => {
      if (s.activeOperation !== undefined) return false;
      const token = normalizeNumeric(op.leaderToken, 'leaderToken');
      assertLeader(s, token);
      const planes = planesOfOperation(op);
      s.activeOperation = {
        operationId: op.operationId,
        transitionId: op.transitionId,
        leaderToken: token,
        planes,
        epochs: Object.fromEntries(
          planes.map((plane) => [
            plane,
            normalizeNumeric(op.planes[plane]!.target.activationEpoch, 'activationEpoch'),
          ]),
        ),
      };
      return true;
    });
  }

  finishOperation(op: ApplyOperation, releasePlanes: Plane[] = []): Promise<void> {
    return this.serial((s) => {
      finalizeCandidate(s, op);
      for (const plane of releasePlanes) {
        const t = tupleFor(op, plane);
        if (ownsSlot(s, t)) delete s.reservations[plane][t.target.activationEpoch];
      }
      // **토큰까지 일치할 때만 놓는다** (10차 반례 ③). id 만 비교하면 낡은 리더의
      // 뒤늦은 abort 가 같은 id 를 쓰는 **신임 실행권**을 지운다.
      const holder = s.activeOperation;
      if (holder?.operationId === op.operationId
        && holder.transitionId === op.transitionId
        && holder.leaderToken === normalizeNumeric(op.leaderToken, 'leaderToken')) {
        delete s.activeOperation;
      }
    });
  }

  /**
   * apply 실행권 (8차 반례 ①).
   *
   * `Effects` 구현이 되돌릴 수 없는 연산 **직전에** 이걸 확인한다. 동기 함수라
   * 확인과 부작용 사이에 다른 코드가 끼어들 수 없다.
   */
  lease(op: ApplyOperation): ApplyLease {
    const token = normalizeNumeric(op.leaderToken, 'leaderToken');
    return {
      leaderToken: token,
      assertValid: () => {
        this.assertOwnership(op);
        return CHECKED_TOKEN;
      },
    };
  }

  /**
   * **부작용 앞에서** 아직 내 차례인지 확인한다 (6차 반례 ⑥).
   *
   * `drive()` 는 예약을 지나온 뒤에도 매 단계 외부 효과를 낸다. 그 사이 새 리더가
   * fence 하면 옛 러너가 게시·HUP 을 계속하게 된다 — 판정만 나중에 거부됐다.
   */
  assertOwnership(op: ApplyOperation): void {
    // **읽기만 한다.** `serial()` 을 쓰면 매 단계마다 상태가 그대로인 durable 쓰기가
    // 하나씩 생긴다 — 디스크도 낭비고 크래시 지점 계측에 의미 없는 지점이 낀다.
    // 확정 판정은 어차피 변이 연산 안에서 다시 한다. 여기서는 부작용을 **일찍** 막는다.
    const s = this.snapshot();
    const token = normalizeNumeric(op.leaderToken, 'leaderToken');
    if (BigInt(token) < BigInt(s.maxLeaderToken)) {
      throw new DpRejection(
        'stale_leader',
        `토큰 ${token} 은 이미 본 최대 토큰 ${s.maxLeaderToken} 보다 낮다`,
      );
    }
    // **실행권이 없으면 내 차례가 아니다** (9차 반례 ③). 전에는 `holder === undefined`
    // 를 통과시켰는데, 그러면 abort 로 실행권을 놓은 뒤에도 멈춰 있던 부작용이 착지한다.
    const holder = s.activeOperation;
    if (holder === undefined) {
      throw new DpRejection('not_reserved', `${op.operationId}:${op.transitionId} 는 실행권이 없다`);
    }
    if (holder.operationId !== op.operationId || holder.transitionId !== op.transitionId) {
      throw new DpRejection(
        'operation_in_flight',
        `${holder.operationId}:${holder.transitionId} 가 apply 경로를 쥐고 있다`,
      );
    }
  }

  writeJournal(entry: JournalEntry): Promise<void> {
    return this.serial((s) => {
      // 부작용 앞의 펜싱과 같은 검사다. 저널 기록도 부작용이다.
      assertLeader(s, normalizeNumeric(entry.op.leaderToken, 'leaderToken'));

      // **소유권은 슬롯이 아니라 `activeOperation` 이 갖는다.** 슬롯은 commit 하면서
      // 사라지므로 그걸로 검사하면 자기 종단 기록조차 막힌다. 전역 실행권 하나로 본다.
      const holder = s.activeOperation;
      // id 만 본다 (39차 census). **근거는 상류가 아니라 두 줄 위의 자기 펜싱이다** —
      // 이 함수가 스스로 `assertLeader` 를 부른다. 40차가 짚기를, 39차 커밋이 "러너의
      // `ownsJournal` 게이트들이 먼저 걸러 낸다" 고 적었다는데 **그 문장은 레포에 없다**
      // (python 의 `if ... in s` 가 조용히 통과해 주석이 안 들어갔고, 나는 안 넣은 것을
      // 커밋 메시지에 적었다). 그래서 이번엔 **넣고 확인한다.**
      //
      // 다만 `assertLeader` 는 낡은 토큰만 막지 **피해자 토큰은 못 막는다.** 그 경로의
      // 방패는 러너 쪽 `ownsJournal` 게이트들(36차)이고, 그건 이 자리에서 보이지 않는
      // 위임이다. **검증물 없음 — 불가지.**
      const mine = holder !== undefined
        && holder.operationId === entry.op.operationId
        && holder.transitionId === entry.op.transitionId;
      if (!mine) {
        throw new DpRejection(
          'not_reserved',
          `${entry.op.operationId}:${entry.op.transitionId} 는 apply 경로를 쥐고 있지 않다`,
        );
      }

      // **단계 전이는 한 명만 이긴다** (6차 반례 ③). 진 쪽은 다시 읽고 따라간다.
      // 소유권 검사 **뒤에** 온다 — 남의 저널을 덮으려는 것과 같은 오퍼레이션의 경쟁은
      // 원인이 다르므로 다른 이름으로 거부해야 한다.
      const expected = (s.journal?.seq ?? 0) + 1;
      if (entry.seq !== expected) {
        throw new DpRejection(
          'journal_conflict',
          `저널이 앞으로 갔다: seq ${expected} 를 기대했는데 ${entry.seq} 가 왔다`,
        );
      }
      s.journal = entry;
    });
  }

  /**
   * 임계구역. **여기 들어온 뒤에는 상태를 읽고 바꾸고 저장할 때까지 다른 요청이 끼어들지
   * 못한다.** `mutate` 는 동기 함수여야 한다 — 안에서 await 하면 그 순간 창이 열린다.
   */
  private serial<T>(mutate: (state: AgentState) => T): Promise<T> {
    const run = this.tail.then(async () => {
      // **매번 store 에서 다시 읽는다.** 인스턴스가 자기 기억을 정본으로 삼으면
      //   · 같은 store 를 보는 다른 인스턴스가 쓴 것을 덮어써 토큰이 되감기고
      //   · 다른 컴포넌트(예: ApplyRunner 저널)가 같은 store 에 쓴 것을 날린다.
      // 5차 검수가 지목한 반례 두 개가 전부 이 하나에서 나왔다.
      //
      // 그런데 다시 읽는 것만으로는 부족하다. 읽고 나서 쓰기까지 사이에 남이 쓸 수
      // 있기 때문이다. 그 창은 **CAS 로만** 닫힌다 — 밀리면 다시 읽고 **다시 판정**한다.
      // 낡은 상태로 내린 판정을 재사용하면 안 되므로 mutate 를 통째로 다시 돌린다.
      for (let attempt = 0; ; attempt += 1) {
        const stored = this.store.load();
        const next = structuredClone((stored?.payload as AgentState | undefined) ?? initial());
        // 알려지지 않은 필드(다른 컴포넌트의 것)를 보존한 채로 우리 몫만 바꾼다.
        const result = mutate(next);
        // **여기서 자란 것을 자른다.** `completed` 는 전환마다 영구 누적돼 무한히 컸다.
        prune(next);
        // **상태가 store 로 내려가는 유일한 통로다.** 여기서 불변식을 본다 (13차 검수).
        assertInvariants(stored?.payload as AgentState | undefined, next);
        try {
          // §3.5 — 토큰과 좌표는 side effect 를 인정하기 **전에** durable 해야 한다.
          await this.store.save({ version: (stored?.version ?? 0) + 1, payload: next });
          return result;
        } catch (e) {
          if (!(e instanceof StoreConflict) || attempt >= CAS_RETRY_LIMIT) throw e;
        }
      }
    });
    // 실패해도 큐가 끊기면 안 된다.
    this.tail = run.catch(() => undefined);
    return run;
  }

  /**
   * §3.5 — 신임 리더는 어떤 operation 보다 먼저 이걸 끝내야 한다.
   *
   * **펜싱이 곧 승계다** (7차 반례 ①). 더 높은 토큰이 여기를 통과하면 옛 리더는 더 이상
   * 행동할 수 없다. 그런데 그 리더가 쥐고 있던 apply 경로를 놓아 주지 않으면 새 리더가
   * 영영 아무것도 못 한다 — 옛 오퍼레이션을 `abort` 하려 해도 그 토큰이 이미 낡아서
   * 거부된다. 리더 교체는 장애 상황에서 일어나는 일인데, 하필 그때 멈춰 선다.
   *
   * 그래서 여기서 놓아 준다. 예약을 반납하고 저널을 `superseded` 로 닫는다.
   * **이미 넘어간 좌표는 건드리지 않는다** — 승계는 되돌리기가 아니다 (§3.3).
   * 새 리더는 관측으로 세상을 다시 읽고 자기 오퍼레이션을 낸다.
   */
  fence(leaderToken: string): Promise<{ maxToken: string }> {
    return this.serial((s) => {
      const token = normalizeNumeric(leaderToken, 'leaderToken');
      assertLeader(s, token);
      s.maxLeaderToken = token;

      const holder = s.activeOperation;
      if (holder !== undefined && BigInt(holder.leaderToken) < BigInt(token)) {
        supersede(s, holder);
      }
      return { maxToken: s.maxLeaderToken };
    });
  }

  reserve(op: OperationTuple): Promise<PlaneAck> {
    return this.serial((s) => {
      const replay = admit(s, op, 'reserve');
      if (replay !== undefined) return replay;
      acquire(s, op);
      return record(s, op, 'reserve', { ...op.target, payloadDigest: op.payloadDigest });
    });
  }

  /**
   * 슬롯에 payload 를 올린다. 예약이 없으면 여기서 잡는다 — 예약은 **먼저 잡을 수도**
   * 있고(`reserve`), 첫 stage 가 잡을 수도 있다. 어느 쪽이든 주인은 하나다.
   */
  stage(op: OperationTuple, _payload: unknown): Promise<PlaneAck> {
    return this.serial((s) => {
      const replay = admit(s, op, 'stage');
      if (replay !== undefined) return replay;

      const slot = acquire(s, op);
      slot.stagedDigest = op.payloadDigest;
      return record(s, op, 'stage', { ...op.target, payloadDigest: op.payloadDigest });
    });
  }

  /**
   * 좌표를 옮긴다. **증거가 있어야 옮긴다** (§6.3).
   *
   * 5차 검수 전까지 활성화 증거는 세대 문자열 하나였고 그마저도 저장되지 않았다.
   * 근거 없이 움직인 좌표는 사후에 검증할 수 없다.
   */
  commit(op: OperationTuple, evidence: ActivationEvidence): Promise<PlaneAck> {
    return this.serial((s) => {
      const replay = admit(s, op, 'commit');
      if (replay !== undefined) return replay;

      const current = s.planes[op.plane];
      // 이미 목표 좌표에 있으면 재요청이다 — 좌표를 두 번 옮기지 않는다.
      //
      // **닮음이 아니라 서명을 본다** (26차 CE-26-C). 좌표와 digest 만 보면, 남이 같은
      // 내용으로 그 좌표를 채운 뒤 내 지연된 commit 이 도착했을 때 **성공 ACK 를
      // 돌려준다** — 나는 내가 커밋했다고 믿는데 아무것도 안 했다. 이 분기까지 내려오는
      // 경우는 (a) 내 캐시가 지워진 뒤 (b) 남이 옮긴 뒤 둘뿐이고 **둘 다 거부가 옳다.**
      if (sameCoordinate(current, op.target)
        && current.payloadDigest === op.payloadDigest
        && authoredBy(current, op)) {
        return record(s, op, 'commit', current);
      }
      const slot = s.reservations[op.plane][op.target.activationEpoch];
      if (slot === undefined) {
        throw new DpRejection(
          'not_staged',
          `epoch ${op.target.activationEpoch} 는 staging 되지 않았다`,
        );
      }
      if (canonical(slot.op) !== canonical(op)) {
        throw new DpRejection(
          'slot_taken',
          `(${op.plane}, ${op.target.activationEpoch}) 는 ${transitionKey(slot.op)} 의 것이다`,
        );
      }
      // **여기가 마지막 문이다.** 한때 "도달 불가" 라고 적었는데 **틀렸다** (17차 검수).
      //
      // 위의 `canonical` 비교는 **슬롯의 튜플과 요청 튜플** 사이다. 슬롯 주인이 자기
      // 자신이면 그건 통과한다. 이 검사는 **현재 좌표와 기대 좌표** 사이라 다른 것을 본다.
      //
      // 도달하는 길: 같은 평면에 두 슬롯(epoch 1·2)을 잡아 두고 늦은 것을 먼저 commit
      // 하면 좌표가 2 로 간다. 그 뒤 epoch 1 짜리 commit 이 오면 슬롯 주인은 자기지만
      // 좌표가 어긋난다 — 여기서 `coordinate_mismatch` 로 막힌다. 이 문을 없애면 좌표가
      // 2 에서 1 로 되돌아가려다 I3 에 걸린다.
      //
      // 뮤테이션이 살아남은 것은 도달 불가라서가 아니라 **그 시퀀스를 지나는 테스트가
      // 없어서**였다. 스윕 결과를 "도달 불가" 로 읽은 것이 내 실수다.
      if (!sameCoordinate(current, op.expectedCurrent)) {
        throw new DpRejection('coordinate_mismatch', `${op.plane} 좌표가 기대와 다르다`);
      }
      if (slot.stagedDigest === undefined) {
        throw new DpRejection(
          'not_staged',
          `epoch ${op.target.activationEpoch} 는 예약만 됐고 payload 가 없다`,
        );
      }
      if (slot.stagedDigest !== op.payloadDigest) {
        throw new DpRejection('digest_mismatch', `staged digest 가 다르다`);
      }

      // **여기가 최종 심판이다** (§3.5 · 6차 반례 ②). 러너도 증거를 보지만, 러너를
      // 거치지 않는 호출이 있으면 그 검사는 없는 것과 같다.
      if (!provesActivation(evidence, op.targetGeneration)) {
        throw new DpRejection(
          'not_activated',
          `증거가 세대 '${op.targetGeneration}' 의 활성화를 증명하지 못한다: ${JSON.stringify(evidence)}`,
        );
      }

      s.planes[op.plane] = {
        ...op.target,
        payloadDigest: op.payloadDigest,
        by: {
          operationId: op.operationId,
          transitionId: op.transitionId,
          leaderToken: normalizeNumeric(op.leaderToken, 'leaderToken'),
        },
      };
      s.activationEvidence[`${op.plane}:${op.target.activationEpoch}`] = evidence;
      // 무엇을 활성화했는지 기억한다 — reconcile 이 이걸로 되돌린다.
      //
      // **오퍼레이션 단위다** (13차 반례 ②). 전에는 평면별 commit 마다 갱신했고, 그래서
      // http 만 넘어간 상태에서도 기준이 생겨 reconcile 이 `converged` 라고 답했다 —
      // 실제 좌표는 http=1 / stream=0 인데. 전 평면이 넘어갔을 때만 "여기로 되돌린다"
      // 고 말할 수 있다.
      // 완결의 뜻은 실행권이 안다 — `reserveAll` 이 **전체** 오퍼레이션을 보고 적었다.
      const declared = s.activeOperation?.epochs;
      if (declared !== undefined) s.pendingEpochs = declared;
      s.pendingActivation = {
        generation: op.targetGeneration,
        leaderToken: op.leaderToken,
        operationId: op.operationId,
        transitionId: op.transitionId,
        generationDigest: op.generationDigest,
      };
      finish(s, op, 'activated');
      return record(s, op, 'commit', s.planes[op.plane]);
    });
  }

  abort(op: OperationTuple): Promise<void> {
    return this.serial((s) => {
      finalize(s, op, 'aborted');
    });
  }

  /**
   * **시작하지 않은 전환을 되돌린다.** 예약만 잡고 부작용을 내기 전에 물러설 때 쓴다.
   *
   * `abort` 와 다르다. abort 는 전환을 **종단 상태로 닫아서** 지연 RPC 가 되살리지
   * 못하게 한다. 그런데 여러 평면 중 하나의 예약이 막혀 이미 잡은 것을 놓는 경우는
   * "이 오퍼레이션은 아무 일도 하지 않았다" 이므로, 같은 operationId 로 다시 시도할 수
   * 있어야 한다. 종단으로 닫아 버리면 **크래시 한 번이 그 operationId 를 영구히 오염시킨다.**
   *
   * 그래서 예약과 함께 **멱등 기록도 지운다.** 안 지우면 재시도의 `reserve` 가 캐시된
   * ACK 를 받아 슬롯 없이 성공했다고 답한다.
   */
  release(op: OperationTuple): Promise<void> {
    return this.serial((s) => {
      assertLeader(s, op.leaderToken);
      if (s.terminal[transitionKey(op)] !== undefined) return;
      if (ownsSlot(s, op)) {
        delete s.reservations[op.plane][op.target.activationEpoch];
      }
      for (const step of ['reserve', 'stage', 'commit', 'health'] as const) {
        delete s.completed[key(op, step)];
      }
    });
  }

  /**
   * 전환을 실패로 끝낸다. **슬롯을 반납한다** — 안 그러면 실패한 좌표가 영구히 잠기고,
   * 지연 도착한 commit 이 뒤늦게 좌표를 옮긴다 (5차 반례 ⑥).
   */
  fail(op: OperationTuple): Promise<void> {
    return this.serial((s) => {
      finalize(s, op, 'failed');
    });
  }

  /** 헬스는 topology 를 바꾸지 않는다. 같은 epoch 안에서 revision 만 올린다. */
  applyHealth(op: OperationTuple, _delta: unknown): Promise<PlaneAck> {
    return this.serial((s) => {
      const replay = admit(s, op, 'health');
      if (replay !== undefined) return replay;

      const current = s.planes[op.plane];
      if (
        !sameCoordinate(current, op.expectedCurrent) ||
        BigInt(op.target.activationEpoch) !== BigInt(current.activationEpoch)
      ) {
        throw new DpRejection(
          'coordinate_mismatch',
          '헬스 델타는 현재 epoch 안에서만 적용된다',
        );
      }
      if (BigInt(op.target.membershipRevision) <= BigInt(current.membershipRevision)) {
        throw new DpRejection('epoch_not_monotonic', 'membership_revision 은 앞으로만 간다');
      }

      // **서명은 그대로 둔다** (26차). `by` 의 뜻은 "이 **epoch** 로 옮긴 커밋" 이고
      // health 는 epoch 을 안 옮긴다. 여기서 자기 신원을 쓰면 아직 안 닫힌 config 저널의
      // 판정이 남의 것으로 뒤집혀 **정당한 활성화를 오살**한다.
      s.planes[op.plane] = {
        ...op.target,
        payloadDigest: op.payloadDigest,
        ...(current.by !== undefined ? { by: current.by } : {}),
      };
      return record(s, op, 'health', s.planes[op.plane]);
    });
  }
}

// ── 임계구역 안에서만 쓰는 헬퍼 (전부 동기) ──────────────────────────────

/** CAS 가 밀렸을 때 다시 읽고 다시 판정하는 횟수. 유한해야 매달리지 않는다. */
const CAS_RETRY_LIMIT = 8;

const maxToken = (a: string, b: string): string => (BigInt(b) > BigInt(a) ? b : a);

/**
 * 튜플의 **정본 표현**. 키가 같아도 이게 다르면 다른 요청이다.
 *
 * 5차 검수가 `operationId`·`transitionId`·`payloadDigest` 는 같고 좌표만 바꾼 요청으로
 * 캐시된 ACK 를 받아냈다. 멱등 판정은 키가 아니라 **튜플 전체**로 해야 한다.
 */
const canonical = (op: OperationTuple): string =>
  [
    op.leaderToken,
    op.operationId,
    op.transitionId,
    op.plane,
    op.expectedCurrent.activationEpoch,
    op.expectedCurrent.membershipRevision,
    op.target.activationEpoch,
    op.target.membershipRevision,
    op.payloadDigest,
    // **세대와 그 내용도 정체성이다** (9차 반례 ②). 없으면 같은 id·좌표로 다른 세대를
    // 요청했을 때 캐시된 ACK 가 돌아가 **조용한 거짓 성공**이 된다.
    op.targetGeneration,
    op.generationDigest,
  ].join('|');

/** 이 오퍼레이션이 그 슬롯의 주인인가. */
function ownsSlot(s: AgentState, op: OperationTuple): boolean {
  const slot = s.reservations[op.plane][op.target.activationEpoch];
  return slot !== undefined && canonical(slot.op) === canonical(op);
}

/**
 * 슬롯을 잡는다. 비어 있으면 좌표 CAS 를 통과해야 하고, 차 있으면 **주인이어야** 한다.
 * 이 함수가 "한 좌표에 한 오퍼레이션" 을 강제하는 유일한 지점이다.
 */
function acquire(s: AgentState, op: OperationTuple): Reservation {
  const existing = s.reservations[op.plane][op.target.activationEpoch];
  if (existing !== undefined) {
    if (canonical(existing.op) !== canonical(op)) {
      throw new DpRejection(
        'slot_taken',
        `(${op.plane}, ${op.target.activationEpoch}) 는 이미 ${transitionKey(existing.op)} 의 것이다`,
      );
    }
    return existing;
  }

  const current = s.planes[op.plane];
  if (!sameCoordinate(current, op.expectedCurrent)) {
    throw new DpRejection(
      'coordinate_mismatch',
      `${op.plane} 는 (${current.activationEpoch},${current.membershipRevision}) 인데 ` +
        `(${op.expectedCurrent.activationEpoch},${op.expectedCurrent.membershipRevision}) 를 기대했다`,
    );
  }
  if (BigInt(op.target.activationEpoch) <= BigInt(current.activationEpoch)) {
    throw new DpRejection(
      'epoch_not_monotonic',
      `activation_epoch 는 앞으로만 간다: ${current.activationEpoch} → ${op.target.activationEpoch}`,
    );
  }

  const slot: Reservation = { op };
  s.reservations[op.plane][op.target.activationEpoch] = slot;
  return slot;
}

/**
 * 옛 리더의 오퍼레이션을 승계한다 (7차 반례 ①).
 *
 * 예약을 반납하고 저널을 종단으로 닫는다. `terminal` 에는 표시하지 않는다 — 그 전환이
 * "실패" 하거나 "취소" 된 것이 아니라 **소유권이 끊긴 것**이고, 이미 커밋된 평면이 있으면
 * 그건 실제로 일어난 일이기 때문이다.
 */
function supersede(s: AgentState, holder: ActiveOperation): void {
  // **실행권이 들고 있는 목록으로 반납한다** (8차 반례 ②). 저널을 보면 저널을 쓰기
  // 전에 죽은 경우를 놓쳐 예약이 남고, 신임 작업이 `slot_taken` 으로 막힌다.
  for (const plane of holder.planes) {
    const epoch = holder.epochs[plane];
    if (epoch === undefined) continue;
    const slot = s.reservations[plane]?.[epoch];
    if (slot === undefined) continue;
    // **토큰까지 본다** (42차 CE-42). 41차에 `releaseStaleSlots` 를 고치며
    // *"9차 반례 ③ 부류다"* 라고 **부류를 지목해 놓고 한 자리만 고쳤다** — 같은 대조가
    // 여기 남아 있었고, 제3자가 같은 좌표로 들어오면 고아 청소가 이것을 불러
    // **신임의 살아 있는 예약을 지운다.**
    //
    // *"이름을 붙이는 것과 전 자리를 고치는 것은 다른 일이다"* 를 40차에 적고,
    // 41차가 그 재연을 짚고, **41차 커밋 자신이 세 번째로 재연했다.**
    if (ownsSlotOp(slot.op, holder)) {
      delete s.reservations[plane][epoch];
    }
  }

  const j = s.journal;
  const sameOp = j !== undefined
    && j.op.operationId === holder.operationId
    && j.op.transitionId === holder.transitionId;
  // **종단은 덮지 않는다** (8차 반례 ②). 이미 activated 로 끝난 것을 superseded 로
  // 바꾸면 좌표와 저널이 다른 말을 한다.
  if (sameOp && j !== undefined && !isTerminalPhase(j.phase)) {
    s.journal = { ...j, phase: 'superseded', seq: j.seq + 1 };
  }
  // 승계도 **끝내는 것**이다 (14차 검수). 전에는 전 평면이 넘어간 후보가 여기서 고아가
  // 됐다 — 활성화는 일어났는데 되돌릴 기준이 영영 안 생긴다.
  finalizeCandidate(s, holder);
  // **자기 것일 때만 지운다** (20차 CE-3). fence 경로에서는 지울 대상이 곧 holder 라
  // 무조건 지워도 맞았는데, 고아를 닫는 경로에서는 **방금 앉힌 신임 실행권**을 지웠다.
  // 열 번 배운 "토큰까지 본다" 를 이 자리에는 안 넣고 있었다.
  //
  // 청소를 실행권 앉히기 **앞으로** 옮기고 나니 이 절은 **방어적**이 됐다 — 무조건
  // 지우게 되돌려도 안 빨개진다(확인했다). 그래도 둔다: 정리 루틴이 원래의 불변식 봉투
  // 밖에서 재사용되면 다시 필요해지고, 이번이 바로 그렇게 물린 경우다.
  const live = s.activeOperation;
  if (live !== undefined
    && live.operationId === holder.operationId
    && live.transitionId === holder.transitionId
    && live.leaderToken === holder.leaderToken) {
    delete s.activeOperation;
  }
}

/** 전환을 끝내고 슬롯을 반납한다. **내 슬롯만** 지운다. */
function finish(s: AgentState, op: OperationTuple, how: TerminalKind): void {
  if (ownsSlot(s, op)) {
    delete s.reservations[op.plane][op.target.activationEpoch];
  }
  s.terminal[transitionKey(op)] = how;
}

/** 리더 검사까지 포함한 종단 처리. `abort` / `fail` 이 쓴다. */
function finalize(s: AgentState, op: OperationTuple, how: TerminalKind): void {
  assertLeader(s, op.leaderToken);
  s.maxLeaderToken = maxToken(s.maxLeaderToken, op.leaderToken);

  const already = s.terminal[transitionKey(op)];
  if (already !== undefined) {
    // 같은 방식으로 다시 끝내는 것은 멱등이다. 다른 방식이면 종단 상태 오염이다.
    if (already === how) return;
    throw new DpRejection(
      'terminal',
      `${transitionKey(op)} 는 이미 ${already} 로 끝났다 — ${how} 로 바꿀 수 없다`,
      already,
    );
  }
  finish(s, op, how);
}

function assertLeader(s: AgentState, token: string): void {
  if (BigInt(token) < BigInt(s.maxLeaderToken)) {
    throw new DpRejection(
      'stale_leader',
      `토큰 ${token} 은 이미 본 최대 토큰 ${s.maxLeaderToken} 보다 낮다`,
    );
  }
}

/**
 * 멱등 키. 튜플은 **전환**을 식별하고, stage·commit·health 는 그 전환의 서로 다른 단계다.
 * 단계를 키에서 빼면 commit 이 stage 의 재요청으로 취급된다.
 */
type Step = 'reserve' | 'stage' | 'commit' | 'health';
/** **plane 이 들어가야 한다.** 빠지면 한 평면의 ACK 를 다른 평면이 훔친다 (5차 반례). */
const key = (op: OperationTuple, step: Step): string =>
  `${op.operationId}:${op.transitionId}:${op.plane}:${step}`;
/** 전환 단위 키. abort 는 단계가 아니라 전환 전체를 끝낸다. */
/**
 * `completed` 를 몇 전환까지 들고 갈 것인가.
 *
 * 이 표는 **재요청 판정**에 쓴다 — "이 요청 이미 처리했나". 재요청은 무한히 늦게 올 수
 * 있으므로 원칙적으로는 영원히 들고 있어야 하지만, 실제로는 그 사이에 전환이 64 개
 * 지나갔다면 그 요청을 보낸 쪽은 이미 오래전에 죽었거나 fence 됐다.
 *
 * 잘린 뒤 늦게 도착한 재요청은 `terminal` 거부를 받는다. **거짓말이 아니다** — 그
 * 전환은 실제로 끝났다. 캐시가 있을 때와 다른 것은 "성공했다" 대신 "이미 끝났다" 로
 * 답한다는 것뿐이고, 둘 다 참이다.
 */
const COMPLETED_RETENTION = 64;

/**
 * `activationEvidence` 를 몇 개까지 들고 갈 것인가.
 *
 * 이 표는 **사후 감사**용이다 — "왜 이 좌표로 옮겼나". 프로덕션 독자가 없다(`evidenceFor`
 * 를 부르는 것은 테스트뿐이다). 그래서 "최근 것을 답할 수 있다" 로 족하고, 창세부터의
 * 전부를 들고 있을 이유가 없다.
 *
 * **지금 서 있는 좌표의 근거는 창 밖이어도 안 지운다** — 그건 지금 답해야 할 물음이다.
 */
const EVIDENCE_RETENTION = 64;

/**
 * **자란 것을 자른다** (빚 갚기).
 *
 * 22~27차가 여섯 번 지적한 것: `completed` 는 전환마다 영구 누적돼 **무한히 자란다.**
 * 그런데 이 표는 자라면서 **우연히 방패 노릇도 하고 있었다** — id 만 비교하는 자리들이
 * 안전한 이유가 "같은 id 의 옛 전환이 늘 이 표에 남아 있어서 `admit` 이 먼저 거부한다"
 * 였다. 그래서 **가지치기와 신원 비교는 한 커밋이어야 한다**(23차 규칙). 그 커밋이 이것이다.
 *
 * 자르는 기준은 **전환 단위**다. 한 전환의 단계 기록을 절반만 남기면 재요청 판정이
 * 반쪽이 되어 더 나쁘다.
 *
 * 진행 중인 전환(`activeOperation`)과 저널이 가리키는 전환은 **자르지 않는다** — 그건
 * 지금 답해야 할 재요청이다.
 */
/**
 * 근거 기록을 자른다.
 *
 * `terminal` 은 **안 자른다.** 그건 감사 기록이 아니라 **부활 방지 장치**다 —
 * `admit` 이 지연 도착한 RPC 를 `aborted`/`failed` 로 거부하는 근거이고, 지우면 운영자가
 * 포기한 전환이 되살아난다. 토큰이 낡은 것만 자르는 규칙도 안전하지 않다: 후보가 fence 를
 * 건너 승계될 수 있어(14차 고아 방지) 낡은 토큰의 종단 기록을 지금 후보가 읽는다
 * (`candidateArrived` 의 원장 폴백). **그래서 남긴다.**
 *
 * 다만 **"자를 규칙이 없다" 는 과장이었다** (35차 검수). 규칙의 얼개는 있다 —
 * **목표 epoch 이 좌표에 추월된 항목은 구조적으로 부활 불가**다: 재획득은
 * `epoch_not_monotonic`/`coordinate_mismatch` 에, commit 은 `not_staged` 에 막힌다.
 * 걸리는 것은 지금 `terminal` **키에 epoch 이 없다**는 것이고(값에 적어야 한다 —
 * `completed` 의 `transition` 과 같은 모양), I7 첫 절도 같이 좁혀야 하며, 서 있는
 * epoch 의 `activated` 와 후보가 참조하는 것은 보존해야 한다.
 *
 * **설계 스케치이고 프로토타입은 안 했다.** 재현 경로 없이 넣지 않는다 — 이 표를
 * 잘못 자르면 운영자가 포기한 전환이 되살아난다. 다음 회차의 일로 남긴다.
 */
function pruneEvidence(s: AgentState): void {
  const keys = Object.keys(s.activationEvidence);
  if (keys.length <= EVIDENCE_RETENTION) return;
  const standing = new Set(
    (Object.keys(s.planes) as Plane[]).map((p) => `${p}:${s.planes[p].activationEpoch}`),
  );
  const drop = keys.filter((k) => !standing.has(k)).slice(0, keys.length - EVIDENCE_RETENTION);
  for (const k of drop) delete s.activationEvidence[k];
}

function prune(s: AgentState): void {
  pruneEvidence(s);
  const keys = Object.keys(s.completed);
  if (keys.length === 0) return;
  // ⚠️ **구버전 항목의 1 회성 창** (34차 검수). `transition` 필드가 없는 항목은 키
  // 전체가 그룹명이 된다 — 그러면 한 전환의 단계 셋이 각각 딴 그룹으로 세어져 보존 창이
  // 좁아지고, `live` 셋(`\0` 이음)과는 절대 안 맞아 **업그레이드 직후 한 번 무보호**다.
  // 26차 `by` 부재의 창과 같은 계열이고, 방향은 안전하다(덜 보존할 뿐 오답을 만들지 않는다).
  const transitionOf = (k: string): string => s.completed[k]?.transition ?? k;
  const live = new Set<string>();
  if (s.activeOperation !== undefined) {
    live.add(`${s.activeOperation.operationId}\u0000${s.activeOperation.transitionId}`);
  }
  if (s.journal !== undefined) {
    live.add(`${s.journal.op.operationId}\u0000${s.journal.op.transitionId}`);
  }
  // 삽입 순서가 곧 시간 순서다 — 오래된 전환부터 나온다.
  const order: string[] = [];
  for (const k of keys) {
    const t = transitionOf(k);
    if (!order.includes(t)) order.push(t);
  }
  const drop = new Set(
    order.filter((t) => !live.has(t)).slice(0, Math.max(0, order.length - COMPLETED_RETENTION)),
  );
  if (drop.size === 0) return;
  for (const k of keys) {
    if (drop.has(transitionOf(k))) delete s.completed[k];
  }
}

/**
 * 전환의 이름. **키가 아니라 값으로 들고 다닌다.**
 *
 * `\0` 로 잇는 이유는 그것이 id 에 못 들어가는 유일한 문자라서다 — 콜론은 들어갈 수 있고,
 * 들어가면 `a`/`b:c` 와 `a:b`/`c` 가 같은 이름이 된다.
 */
const transitionOfOp = (op: OperationTuple): string =>
  `${op.operationId}\u0000${op.transitionId}`;

const transitionKey = (op: OperationTuple): string =>
  `${op.operationId}:${op.transitionId}:${op.plane}`;

/**
 * 토큰 검사 + 재요청 판정. 재요청이면 캐시된 ACK 를 돌려준다.
 *
 * §3.6-3 — 같은 좌표에 **다른 내용**을 밀어 넣는 경로를 없앤다. digest 가 다르면 거부다.
 */
function admit(s: AgentState, op: OperationTuple, step: Step): PlaneAck | undefined {
  assertLeader(s, op.leaderToken);
  s.maxLeaderToken = maxToken(s.maxLeaderToken, op.leaderToken);

  // **종단 검사가 먼저다 — 단, 어떻게 끝났는지를 본다.**
  //
  //   · aborted / failed  → 전환은 **일어나지 않았다.** 지연 도착한 RPC 에 캐시된 ACK 를
  //                         돌려주면 "성공했다" 고 거짓말하는 것이다. 전부 거부한다.
  //   · activated         → 전환은 **일어났다.** 복구가 다시 돌린 commit 처럼 상태를
  //                         바꾸지 않는 replay 는 통과시켜야 멱등이 성립한다.
  //
  // 이 구분을 뭉개면 둘 중 하나가 깨진다. 종단 전부를 거부하면 복구가 실패하고,
  // 종단 전부를 통과시키면 abort 된 전환이 되살아난다.
  const already = s.terminal[transitionKey(op)];
  if (already === 'aborted' || already === 'failed') {
    throw new DpRejection('terminal', `${transitionKey(op)} 는 이미 ${already} 로 끝났다`, already);
  }

  const seen = s.completed[key(op, step)];
  if (seen !== undefined) {
    if (seen.tuple !== canonical(op)) {
      // 무엇이 달라졌는지까지 말한다. 내용이 다른 것과 좌표가 다른 것은 원인이 다르다.
      if (seen.payloadDigest !== op.payloadDigest) {
        throw new DpRejection(
          'digest_mismatch',
          `${key(op, step)} 는 이미 다른 digest 로 처리됐다 ` +
            `(${seen.payloadDigest} ≠ ${op.payloadDigest})`,
        );
      }
      throw new DpRejection(
        'tuple_mismatch',
        `${key(op, step)} 는 digest 가 같지만 튜플이 다르다 — 같은 키에 다른 요청이다`,
      );
    }
    return { ...seen.ack, cached: true };
  }

  // 끝났는데 이 단계의 기록이 없다 — 그 전환에 없던 단계다. 새로 시작하면 안 된다.
  if (already !== undefined) {
    throw new DpRejection('terminal', `${transitionKey(op)} 는 이미 ${already} 로 끝났다`, already);
  }

  return undefined;
}

function record(s: AgentState, op: OperationTuple, step: Step, result: PlaneState): PlaneAck {
  const ack: PlaneAck = {
    ...result,
    plane: op.plane,
    transitionId: op.transitionId,
    cached: false,
  };
  s.completed[key(op, step)] = {
    tuple: canonical(op),
    payloadDigest: op.payloadDigest,
    ack,
    // **어느 전환의 기록인지 적어 둔다** (34차 검수 A). 자를 때 키를 되쪼개면
    // id 에 콜론이 있을 때 조립과 해체가 어긋난다 — `admit` 은 정확한 조회만 했지
    // 되쪼갠 적이 없고, 그 문자열을 구분자로 **처음 신뢰한 것이 가지치기**였다.
    transition: transitionOfOp(op),
  };
  return ack;
}
