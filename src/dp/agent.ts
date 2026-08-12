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

export type Plane = 'http' | 'stream';

export type Coordinate = {
  activationEpoch: string;
  membershipRevision: string;
};

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
  | 'not_staged';

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

export type AgentState = {
  /**
   * durable CAS 용 단조 버전. `save` 는 `version === 직전 + 1` 일 때만 성공한다.
   *
   * **인스턴스 안의 직렬화만으로는 부족하다.** 같은 store 를 보는 두 Agent 는 서로의
   * 큐를 모르므로 둘 다 같은 상태를 읽고 각자 쓴다. 5차 검수가 그렇게 리더 토큰을
   * 12 에서 11 로 되감았다.
   */
  version: number;
  maxLeaderToken: string;
  planes: Record<Plane, PlaneState>;
  /** epoch → 예약. 아직 활성화되지 않은 슬롯 (§6.5 staging). */
  reservations: Record<Plane, Record<string, Reservation>>;
  /** `operationId:transitionId:plane:step` → 그때 돌려준 ACK 와 정본 튜플. 재요청 판정용. */
  completed: Record<string, { tuple: string; payloadDigest: string; ack: PlaneAck }>;
  /** 끝난 전환. 지연된 RPC 가 되살리지 못하게 막는다. */
  terminal: Record<string, TerminalKind>;
  /**
   * 진행 중인 apply 오퍼레이션의 저널 (§6.2).
   *
   * **여기 있어야 한다.** 저널과 멤버십 좌표가 서로 다른 소유자를 가지면 같은 store 를
   * 두고 덮어쓴다 — 5차 반례 ④ 가 그것이었다. 하나의 직렬 구간이 둘 다 소유한다.
   */
  journal?: JournalEntry;
};

/** §6.2 의 apply 단계. 튜플을 통째로 들고 있어야 복구가 같은 operation 을 재개한다. */
export type JournalEntry = {
  op: OperationTuple;
  targetGeneration: string;
  phase: ApplyPhase;
  reloadAttempts: number;
};

export type ApplyPhase =
  | 'publish_intent'
  | 'published'
  | 'membership_staged'
  | 'reload_intent'
  | 'reload_observed'
  | 'activated'
  | 'failed'
  | 'no_operation';

export interface DurableStore {
  load(): AgentState | undefined;
  /**
   * **fsync 까지 끝나고 나서** resolve 해야 한다.
   *
   * `state.version` 이 저장된 것의 바로 다음이 아니면 `StoreConflict` 로 거부한다.
   * 이게 없으면 프로세스·인스턴스 간 lost update 를 막을 수단이 없다.
   */
  save(state: AgentState): Promise<void>;
}

/** 테스트용. `delayMs` 로 durable 저장을 느리게 만들어 동시성 구멍을 드러낸다. */
export class MemoryStore implements DurableStore {
  private state: AgentState | undefined;
  constructor(private readonly delayMs = 0) {}
  load(): AgentState | undefined {
    return this.state === undefined ? undefined : structuredClone(this.state);
  }
  async save(state: AgentState): Promise<void> {
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
  version: 0,
  maxLeaderToken: '0',
  planes: { http: { ...ZERO }, stream: { ...ZERO } },
  reservations: { http: {}, stream: {} },
  completed: {},
  terminal: {},
});

const sameCoordinate = (a: Coordinate, b: Coordinate): boolean =>
  BigInt(a.activationEpoch) === BigInt(b.activationEpoch) &&
  BigInt(a.membershipRevision) === BigInt(b.membershipRevision);

// ── Agent ────────────────────────────────────────────────────────────────

export class DpAgent {
  /** 직렬화 큐. 임계구역이 하나씩만 돌게 만든다. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: DurableStore) {}

  coordinate(plane: Plane): PlaneState {
    return { ...(this.store.load() ?? initial()).planes[plane] };
  }

  /** 아직 활성화되지 않은 슬롯의 digest. 없으면 undefined. */
  stagedDigest(plane: Plane, epoch: string): string | undefined {
    return (this.store.load() ?? initial()).reservations[plane]?.[epoch]?.stagedDigest;
  }

  /** 슬롯의 주인. 없으면 undefined. */
  reservationOwner(plane: Plane, epoch: string): OperationTuple | undefined {
    return (this.store.load() ?? initial()).reservations[plane]?.[epoch]?.op;
  }

  /** 전환이 어떻게 끝났는지. 아직이면 undefined. */
  terminalOf(op: OperationTuple): TerminalKind | undefined {
    return (this.store.load() ?? initial()).terminal[transitionKey(op)];
  }

  /** 진행 중인 apply 저널. 없으면 undefined. */
  readJournal(): JournalEntry | undefined {
    return (this.store.load() ?? initial()).journal;
  }

  /**
   * 저널 쓰기도 **같은 직렬 구간**을 지난다. 멤버십 좌표와 저널이 한 소유자 아래 있어야
   * 서로 덮어쓰지 않는다 (5차 반례 ③④).
   */
  writeJournal(entry: JournalEntry): Promise<void> {
    return this.serial((s) => {
      // **저널도 예약이 있어야 쓴다.** 없으면 남의 오퍼레이션이 진행 중인 저널을
      // 자기 것으로 덮는다 — 5차 반례 ②. 종단 단계만 예외인데, 그때는 이미 예약을
      // 반납한 뒤라서 주인이 없는 게 정상이다.
      const terminalPhase = entry.phase === 'activated' || entry.phase === 'failed';
      if (!terminalPhase && !ownsSlot(s, entry.op)) {
        throw new DpRejection(
          'not_reserved',
          `${transitionKey(entry.op)} 는 (${entry.op.plane}, ${entry.op.target.activationEpoch}) ` +
            `슬롯을 예약하지 않았다`,
        );
      }
      s.journal = entry;
    });
  }

  /** 오퍼레이션이 끝나면 저널을 비운다. */
  clearJournal(): Promise<void> {
    return this.serial((s) => {
      delete s.journal;
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
        const loaded = this.store.load();
        const next = structuredClone(loaded ?? initial());
        next.version = (loaded?.version ?? 0) + 1;
        // 알려지지 않은 필드(다른 컴포넌트의 것)를 보존한 채로 우리 몫만 바꾼다.
        const result = mutate(next);
        try {
          // §3.5 — 토큰과 좌표는 side effect 를 인정하기 **전에** durable 해야 한다.
          await this.store.save(next);
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

  /** §3.5 — 신임 리더는 어떤 operation 보다 먼저 이걸 끝내야 한다. */
  fence(leaderToken: string): Promise<{ maxToken: string }> {
    return this.serial((s) => {
      assertLeader(s, leaderToken);
      s.maxLeaderToken = leaderToken;
      return { maxToken: s.maxLeaderToken };
    });
  }

  /**
   * §9.1.1 blocker 1 — **부작용보다 먼저** 좌표를 예약한다.
   *
   * `(plane, target_activation_epoch)` 는 한 오퍼레이션만 갖는다. 여기서 리더 토큰과
   * 좌표 CAS 를 통과해야 게시도 저널 기록도 시작할 수 있다. 5차 검수는 이게 없어서
   * `stale_leader` 로 거부된 오퍼레이션이 이미 `current` 심볼릭 링크를 옮긴 것을
   * 재현했다 — §3.5 는 "토큰을 side effect **전에** fsync 하고 ACK 한다" 이다.
   */
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

  commit(op: OperationTuple): Promise<PlaneAck> {
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

      s.planes[op.plane] = { ...op.target, payloadDigest: op.payloadDigest };
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
