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
  | 'aborted'
  | 'stale_state'
  | 'coordinate_mismatch'
  | 'digest_mismatch'
  | 'epoch_not_monotonic'
  | 'not_staged';

export class DpRejection extends Error {
  constructor(readonly kind: RejectionKind, message: string) {
    super(message);
    this.name = 'DpRejection';
  }
}

// ── durable 상태 ─────────────────────────────────────────────────────────

export type AgentState = {
  maxLeaderToken: string;
  planes: Record<Plane, PlaneState>;
  /** epoch → payload digest. 아직 활성화되지 않은 슬롯 (§6.5 staging). */
  staged: Record<Plane, Record<string, string>>;
  /** `operationId:transitionId:plane:step` → 그때 돌려준 ACK 와 digest. 재요청 판정용. */
  completed: Record<string, { payloadDigest: string; ack: PlaneAck }>;
  /** abort 된 전환. 지연된 stage/commit 이 되살리지 못하게 막는다. */
  aborted: Record<string, true>;
};

export interface DurableStore {
  load(): AgentState | undefined;
  /** **fsync 까지 끝나고 나서** resolve 해야 한다. */
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
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    this.state = structuredClone(state);
  }
}

const ZERO: PlaneState = { activationEpoch: '0', membershipRevision: '0', payloadDigest: '' };

const initial = (): AgentState => ({
  maxLeaderToken: '0',
  planes: { http: { ...ZERO }, stream: { ...ZERO } },
  staged: { http: {}, stream: {} },
  completed: {},
  aborted: {},
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
    return (this.store.load() ?? initial()).staged[plane][epoch];
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
      const loaded = this.store.load();
      const next = structuredClone(loaded ?? initial());
      // 알려지지 않은 필드(다른 컴포넌트의 것)를 보존한 채로 우리 몫만 바꾼다.
      const result = mutate(next);
      // §3.5 — 토큰과 좌표는 side effect 를 인정하기 **전에** durable 해야 한다.
      await this.store.save(next);
      return result;
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

  stage(op: OperationTuple, _payload: unknown): Promise<PlaneAck> {
    return this.serial((s) => {
      const replay = admit(s, op, 'stage');
      if (replay !== undefined) return replay;

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

      s.staged[op.plane][op.target.activationEpoch] = op.payloadDigest;
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
      if (!sameCoordinate(current, op.expectedCurrent)) {
        throw new DpRejection('coordinate_mismatch', `${op.plane} 좌표가 기대와 다르다`);
      }
      const staged = s.staged[op.plane][op.target.activationEpoch];
      if (staged === undefined) {
        // abort 된 epoch 나, 애초에 staging 되지 않은 epoch 의 지연 RPC 가 여기로 온다.
        throw new DpRejection(
          'not_staged',
          `epoch ${op.target.activationEpoch} 는 staging 되지 않았다`,
        );
      }
      if (staged !== op.payloadDigest) {
        throw new DpRejection('digest_mismatch', `staged digest 가 다르다`);
      }

      s.planes[op.plane] = { ...op.target, payloadDigest: op.payloadDigest };
      delete s.staged[op.plane][op.target.activationEpoch];
      return record(s, op, 'commit', s.planes[op.plane]);
    });
  }

  abort(op: OperationTuple): Promise<void> {
    return this.serial((s) => {
      assertLeader(s, op.leaderToken);
      s.maxLeaderToken = maxToken(s.maxLeaderToken, op.leaderToken);
      // §6.5 — abort 는 staged 슬롯을 버릴 뿐 이벤트를 옮기지 않는다.
      delete s.staged[op.plane][op.target.activationEpoch];
      // 이 전환은 여기서 끝난다. 지연 RPC 가 되살리지 못하게 표시한다.
      s.aborted[transitionKey(op)] = true;
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

const maxToken = (a: string, b: string): string => (BigInt(b) > BigInt(a) ? b : a);

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
type Step = 'stage' | 'commit' | 'health';
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

  // abort 는 전환을 **끝낸다.** 지연 도착한 stage/commit 이 캐시로 성공을 돌려주거나
  // 슬롯을 되살리면 안 된다 (5차 반례).
  if (s.aborted[transitionKey(op)] === true) {
    throw new DpRejection('aborted', `${transitionKey(op)} 는 이미 abort 됐다`);
  }

  const seen = s.completed[key(op, step)];
  if (seen === undefined) return undefined;
  if (seen.payloadDigest !== op.payloadDigest) {
    throw new DpRejection(
      'digest_mismatch',
      `${key(op, step)} 는 이미 다른 digest 로 처리됐다 (${seen.payloadDigest} ≠ ${op.payloadDigest})`,
    );
  }
  return { ...seen.ack, cached: true };
}

function record(s: AgentState, op: OperationTuple, step: Step, result: PlaneState): PlaneAck {
  const ack: PlaneAck = {
    ...result,
    plane: op.plane,
    transitionId: op.transitionId,
    cached: false,
  };
  s.completed[key(op, step)] = { payloadDigest: op.payloadDigest, ack };
  return ack;
}
