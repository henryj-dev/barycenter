/**
 * 변이 봉투와 ApplyOperation 스키마 — DESIGN.md §3.4 · §3.6 · §6.3 · §9.1.1 blocker 2·3
 *
 * 5차 검수가 두 가지를 지목했다.
 *
 *   · ApplyOperation 이 **평면 하나**만 다룬다. 그런데 HUP 은 nginx 전체에 적용된다.
 *     러너를 두 번 돌리면 첫 HUP 때 다른 평면은 아직 staging 되지 않았고, 실패했을 때
 *     어느 평면이 반영됐는지 durable 하게 말할 방법이 없다.
 *   · 활성화 증거가 **세대 문자열 하나**로 축소돼 있다. §6.3 의 config test, error log
 *     워터마크, 워커 집합을 표현할 수도 검증할 수도 없다.
 *
 * 그래서 여기서 세 가지를 고정한다.
 *
 *   1. `MutationEnvelope` — **모든** 변이가 지나는 봉투. 설정이든 멤버십이든 같다.
 *      §9.2 의 config prepare/commit/abort 에는 리더 토큰도 튜플도 없었다. 그러면
 *      설정 경로가 멤버십 튜플 **밖에서** 부작용을 낼 수 있다.
 *   2. `ApplyOperation` — 봉투 + **평면별** 목표 좌표 + 목표 세대.
 *   3. `ActivationEvidence` — 활성화를 무엇으로 판정했는지. 좌표를 옮긴 근거다.
 */

export type Plane = 'http' | 'stream';

export type Coordinate = {
  activationEpoch: string;
  membershipRevision: string;
};

/**
 * 모든 변이가 지나는 봉투 (§9.1.1 blocker 3).
 *
 * **설정 경로도 이걸 지난다.** 세대를 게시하고 HUP 을 보내는 것은 멤버십 못지않은
 * 부작용인데, 여기에 리더 토큰이 없으면 옛 리더가 낸 설정이 그대로 활성화된다.
 */
export type MutationEnvelope = {
  leaderToken: string;
  operationId: string;
  transitionId: string;
  /**
   * 이 오퍼레이션이 건드리는 평면들. **비어 있으면 안 된다.**
   *
   * nginx 는 http 와 stream 을 한 번의 HUP 으로 함께 올린다. 두 평면을 두 오퍼레이션으로
   * 나누면 첫 HUP 때 다른 평면이 준비되지 않은 채로 활성화된다 (§3.4).
   */
  affectedPlanes: Plane[];
};

/** 평면 하나에 대한 좌표 CAS. */
export type PlaneTarget = {
  expectedCurrent: Coordinate;
  target: Coordinate;
  payloadDigest: string;
};

/** 봉투 + 평면별 목표. 저널이 이걸 통째로 들고 다닌다. */
export type ApplyOperation = MutationEnvelope & {
  planes: Partial<Record<Plane, PlaneTarget>>;
  /** 활성화할 설정 세대. */
  targetGeneration: string;
  /**
   * 그 세대의 **내용** digest (§7.2 manifest).
   *
   * 이름만으로는 무엇을 활성화하는지 말하지 못한다. 6차 검수가 같은 이름 아래 다른
   * 바이트를 활성화하는 경로를 지적했다. 게시 앞에서 디스크와 대조한다.
   */
  generationDigest: string;
};

/**
 * 평면 하나가 어디까지 갔는가 (§3.4 `partial_transition`).
 *
 * 실패했을 때 **어느 평면이 반영됐는지** 말할 수 있어야 한다. 그게 없으면 운영자는
 * 전체를 다시 밀어 보는 것 말고 할 수 있는 게 없다.
 */
export type PlaneProgress =
  | 'pending'
  | 'reserved'
  | 'staged'
  | 'committed'
  | 'aborted'
  | 'failed';

/**
 * 활성화 증거 (§6.3).
 *
 * `acceptingGeneration` 만 필수다. 나머지는 배포 형태에 따라 관측할 수 있기도 없기도
 * 하다 — 컨테이너면 마스터 PID 를, 사이드카면 워커 집합을 볼 수 있다.
 *
 * **다만 있는 것은 판정에 쓴다.** S7 이 실증한 것이 그거다. 세대 리터럴만 보면 포트가
 * 점유된 실패를 4027ms 동안 못 잡았는데, error log 워터마크를 음성 신호로 넣자 71ms 에
 * 잡혔다. 관측할 수 있는데 안 쓰면 그 시간만큼 잘못된 상태로 서빙한다.
 */
export type ActivationEvidence = {
  /** 세대에 구워진 리터럴을 읽은 값 (§6.3-4). */
  acceptingGeneration: string | undefined;
  /** `nginx -t` 가 통과했는가. 관측 못 했으면 undefined. */
  configTestPassed?: boolean;
  /** 신호를 보낸 뒤 error log 가 몇 줄 늘었는가. 0 보다 크면 음성 신호다. */
  errorLogGrowth?: number;
  /** 마스터 프로세스. 바뀌었으면 reload 가 아니라 재시작이다. */
  masterPid?: string;
  /** 새 세대를 보고한 워커 수 / 기대 수. */
  workersReported?: number;
  workersExpected?: number;
};

/**
 * 증거가 활성화를 증명하는가.
 *
 * 세대가 맞는 것은 **필요조건일 뿐이다.** 하나라도 음성 신호가 있으면 활성화가 아니다.
 */
export function provesActivation(
  evidence: ActivationEvidence | undefined,
  targetGeneration: string,
): boolean {
  if (evidence === undefined) return false;
  if (evidence.acceptingGeneration !== targetGeneration) return false;
  // 관측한 것만 본다. 관측하지 못한 것(undefined)은 반증이 아니다.
  if (evidence.configTestPassed === false) return false;
  if (evidence.errorLogGrowth !== undefined && evidence.errorLogGrowth > 0) return false;
  if (
    evidence.workersExpected !== undefined &&
    evidence.workersReported !== undefined &&
    evidence.workersReported < evidence.workersExpected
  ) {
    return false;
  }
  return true;
}

/**
 * apply 실행권 (8차 반례 ①).
 *
 * 7차까지는 러너가 부작용 **앞에서** 소유권을 확인했다. 그런데 확인과 부작용 사이에
 * `await` 가 하나라도 있으면 그 사이에 리더가 바뀔 수 있고, 이미 시작된 부작용은
 * 되돌릴 수 없다. 실제로 옛 `publish()` 가 신임 게시 **뒤에** 착지해서
 * `current` 와 좌표가 갈라지는 것을 재현했다.
 *
 * 그래서 검사를 부작용 **구현 안으로** 내린다. `Effects` 구현은 되돌릴 수 없는
 * 연산 **직전에** `assertValid()` 를 부르고, 그 사이에 `await` 를 두지 않아야 한다.
 *
 * ⚠️ **이건 타입이 강제하지 못한다** (9차 검수). 주석으로 부탁하는 것일 뿐이고,
 * 실제로 `FsEffects.signalReload` 는 확인 뒤 주입된 `reload()` 를 `await` 하는데
 * 그 안에서 리더가 바뀌면 신호는 그대로 나간다 — 재현했다.
 *
 * 막는 것만으로는 닫히지 않는다. 외부 효과는 **취소할 수 없다.** 대상(nginx)이 토큰을
 * 검증하지 않는 한, 남는 답은 "늦게 착지한 것을 **탐지하고 수렴시키는 것**" 이다.
 * `lease` 는 창을 좁히는 장치로 남기고, 정합성은 재수렴이 맡아야 한다.
 */
export type ApplyLease = {
  /** 이 lease 를 발급한 리더 토큰. */
  readonly leaderToken: string;
  /** 아직 내 차례인가. 아니면 던진다. **동기 함수다** — await 를 만들지 않는다. */
  assertValid(): void;
};

/** apply 의 결과. **평면별로** 말한다. */
export type ApplyResult = {
  phase: ApplyPhase;
  progress: Record<Plane, PlaneProgress | undefined>;
  /**
   * 일부 평면만 넘어갔는가 (§3.4).
   *
   * 이게 true 면 운영자는 어느 평면이 옛 좌표에 남았는지 `progress` 로 알 수 있다.
   */
  partialTransition: boolean;
  evidence?: ActivationEvidence;
};

/** §6.2 의 apply 단계. */
export type ApplyPhase =
  /** 게시 전 검사 — manifest 대조와 `nginx -t` (§6.2 #2). */
  | 'preflight'
  | 'publish_intent'
  | 'published'
  | 'membership_staged'
  | 'reload_intent'
  | 'reload_observed'
  | 'activated'
  | 'partially_activated'
  | 'failed'
  /** 더 높은 리더 토큰이 들어와 소유권이 끊겼다 (§3.5). */
  | 'superseded'
  | 'no_operation';

/**
 * 모든 apply 단계. **DESIGN §6.2 의 표와 일치해야 한다.**
 *
 * 문서와 코드가 갈라지면 어느 쪽이 계약인지 아무도 모른다. 6차 검수가 그걸 지적했고,
 * 한 번 고치는 것으로는 또 갈라진다 — `tests/conformance/review6-design-abi.test.ts`
 * 가 이 배열과 DESIGN 의 표를 대조한다.
 */
export const ALL_APPLY_PHASES: readonly ApplyPhase[] = [
  'preflight',
  'publish_intent',
  'published',
  'membership_staged',
  'reload_intent',
  'reload_observed',
  'activated',
  'partially_activated',
  'failed',
  'superseded',
  'no_operation',
];

/** 종단 단계 — 여기 들어가면 러너는 더 진행하지 않는다. */
export const TERMINAL_PHASES: readonly ApplyPhase[] = [
  'activated',
  'partially_activated',
  'failed',
  'superseded',
  'no_operation',
];

export const isTerminalPhase = (p: ApplyPhase): boolean => TERMINAL_PHASES.includes(p);

/** 봉투에 실린 평면 순서. 항상 같은 순서로 돌아야 재현이 된다. */
export const planesOf = (op: MutationEnvelope): Plane[] =>
  [...op.affectedPlanes].sort((a, b) => a.localeCompare(b));
