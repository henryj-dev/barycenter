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

export type PlaneState = Coordinate & { payloadDigest: string };

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
  /** `operationId:transitionId:plane:step` → 그때 돌려준 ACK 와 정본 튜플. 재요청 판정용. */
  completed: Record<string, { tuple: string; payloadDigest: string; ack: PlaneAck }>;
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
function finalizeCandidate(
  s: AgentState,
  ids: { operationId: string; transitionId: string },
): void {
  const candidate = s.pendingActivation;
  if (candidate === undefined) return;
  if (candidate.operationId !== ids.operationId) return;
  if (candidate.transitionId !== ids.transitionId) return;

  // **후보가 들고 온 것만 쓴다** (15차 검수 · 16차에 fallback 을 걷어냈다).
  //
  // 넘어온 오퍼레이션은 평면을 하나만 담고 있을 수 있고, 그걸 믿으면 부분 활성화가
  // 기준이 된다 — 13차 ② 와 같은 결과다. 그래서 후보에 완결의 뜻을 함께 적었는데,
  // **`?? fallback` 으로 옛 구멍을 그대로 열어 뒀다.** 후보에 뜻이 없는 상태(15차
  // 앞에 저장된 것)에서 호출자를 다시 믿게 된다. 16차 검수가 지목했다.
  //
  // 뜻이 없으면 **승격하지 않는다.** 완결을 확인할 수 없는 후보는 기준이 될 수 없다 —
  // 기준이 없는 것은 `no_baseline` 으로 드러나고 수렴이 다시 만든다. 거짓 기준보다 낫다.
  const epochs = s.pendingEpochs;
  const arrived = epochs !== undefined && Object.entries(epochs).every(
    ([plane, epoch]) => s.planes[plane as Plane]?.activationEpoch === epoch,
  );
  if (arrived) s.lastActivated = candidate;
  delete s.pendingActivation;
  delete s.pendingEpochs;
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

/** 두 기록이 **같은 활성화 사건**인가. 세대 이름만 같아서는 안 된다. */
function sameRecordIdentity(a: PublishRecord, b: PublishRecord): boolean {
  return a.generation === b.generation
    && a.generationDigest === b.generationDigest
    && a.operationId === b.operationId
    && a.transitionId === b.transitionId
    && a.leaderToken === b.leaderToken;
}

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
  const j6 = next.journal;
  if (j6 !== undefined
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
  for (const key of Object.keys(before.activationEvidence)) {
    if (next.activationEvidence[key] === undefined) {
      throw new InvariantViolation(
        'I7 근거는 지워지지 않는다',
        `${key} 로 옮긴 근거가 사라졌다 — 왜 옮겼는지 답할 수 없게 된다`,
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
        if (slot?.op.operationId === op.operationId && slot.op.transitionId === op.transitionId) {
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
        || (holder.operationId === op.operationId && holder.transitionId === op.transitionId);
      if (!mine) {
        throw new DpRejection(
          'operation_in_flight',
          `${holder!.operationId}:${holder!.transitionId} 가 apply 경로를 쥐고 있다`,
        );
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
        const mine = existing !== undefined
          && existing.op.operationId === op.operationId
          && existing.op.transitionId === op.transitionId;
        if (!mine) s.journal = { ...opening, seq: (existing?.seq ?? 0) + 1 };
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
      if (sameCoordinate(current, op.target) && current.payloadDigest === op.payloadDigest) {
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

      s.planes[op.plane] = { ...op.target, payloadDigest: op.payloadDigest };
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

      s.planes[op.plane] = { ...op.target, payloadDigest: op.payloadDigest };
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
    if (slot.op.operationId === holder.operationId && slot.op.transitionId === holder.transitionId) {
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
  delete s.activeOperation;
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
  s.completed[key(op, step)] = { tuple: canonical(op), payloadDigest: op.payloadDigest, ack };
  return ack;
}
