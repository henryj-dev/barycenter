/**
 * ApplyOperation 저널 — DESIGN.md §6.2
 *
 * **저널만으로는 복구할 수 없다.** 부작용을 내기 *전에* 기록하면 "기록했지만 안 했을"
 * 수 있고, *후에* 기록하면 "했지만 기록 못 했을" 수 있다. 그래서 의도와 결과를 별도
 * 단계로 두고, 애매한 지점에서는 **세상을 관측해서** 판정한다.
 *
 * HUP 은 exactly-once 로 만들 수 없다. 마스터 cycle 이 그대로라는 사실만으로는 "신호를
 * 못 보냈다"와 "보냈지만 아직 처리 전"을 구분할 수 없다. 재전송하면 워커 cycle 이 하나 더
 * 생기고, 안 하면 미전송이 멈춘다. → **exactly-once 를 버리고 bounded duplicate 를
 * 허용한다.** 대신 관측을 먼저 하고, 재전송에는 상한을 둔다.
 */
import type { DpAgent, JournalEntry } from './agent.js';
import {
  isTerminalPhase,
  planesOf,
  provesActivation,
  publishedByMe,
  type ActivationEvidence,
  type ApplyOperation,
  type ApplyPhase,
  type ApplyLease,
  type Checked,
  type ApplyResult,
  type PublishedState,
  type PublishRecord,
  type Plane,
  type PlaneProgress,
} from './operation.js';
import { DpRejection, ownsJournal, tupleFor } from './agent.js';

export type Phase = ApplyPhase;

/** reload 재전송 상한. 넘으면 실패로 확정한다 (§6.2). */
export const RELOAD_ATTEMPT_LIMIT = 2;

/** partial 에서 남은 평면을 다시 밀어 보는 횟수. 무한 재시도는 알림을 늦출 뿐이다. */
export const PARTIAL_RETRY_LIMIT = 2;

/** DP Agent 가 소유하는 외부 부작용. **전부 관측 가능해야 한다.** */
/** 게시 전 검사 결과. `ok` 가 false 면 게시하지 않는다. */
export type PreflightResult = {
  ok: boolean;
  reason?: string;
  /** `nginx -t` 결과. 관측하지 못했으면 undefined. */
  configTestPassed?: boolean;
};

export interface Effects {
  /**
   * 게시 **전** 검사 (§6.2 #2 · §7.2).
   *
   * 세대의 바이트가 오퍼레이션이 말한 digest 와 같은지, 엔진이 그 설정을 받아들이는지
   * 본다. 여기서 막지 못하면 잘못된 설정이 `current` 를 거쳐 HUP 까지 간다.
   */
  preflight(op: ApplyOperation): Promise<PreflightResult>;
  /**
   * 세대를 활성 포인터로 만든다.
   *
   * **되돌릴 수 없는 연산 직전에 `lease.assertValid()` 를 부르고, 그 사이에 `await` 를
   * 두지 마라** (8차 반례 ①). 준비(임시 파일 생성 등)는 그 앞에서 해도 된다.
   */
  /**
   * ⚠️ **타입이 lease 사용을 강제하지 못한다** (11차 검수).
   *
   * TypeScript 는 인자를 **덜 받는** 함수를 대입할 수 있게 한다. `async publish() {}` 도
   * 이 계약을 만족한다 — lease 를 아예 안 받고 안 부른다. 내가 8차에 "필수 인자로
   * 만들었으니 빼먹으면 타입이 잡는다" 고 적은 것은 틀렸다.
   *
   * 그래서 이건 **관례이지 강제가 아니다.** 정합성은 `reconcileConfig()` 의 수렴이
   * 맡는다 — 늦게 착지한 것을 관측하고 되돌린다.
   */
  publish(record: PublishRecord, lease: ApplyLease): Promise<Checked>;
  /**
   * 지금 게시된 것과 **그것이 누구 것인지**.
   *
   * 세대 이름만 돌려주면 "옛 리더가 늦게 게시한 같은 이름" 과 "내가 게시한 것" 을
   * 구분하지 못한다 — 그래서 수렴할 수가 없다 (9차 검수 뒤 방향 전환).
   */
  observePublished(): Promise<PublishedState>;
  /** HUP. `publish` 와 같은 규칙을 지킨다. */
  signalReload(lease: ApplyLease): Promise<Checked>;
  /**
   * 활성화 증거 (§6.3). 세대 리터럴만이 아니라 관측할 수 있는 것을 **전부** 싣는다.
   *
   * 이게 `observeAccepting(): string` 이던 시절에는 config test 실패도 error log 증가도
   * 표현할 방법이 없었다. S7 은 세대만 보면 못 잡는 실패가 있다는 것을 실증했다.
   */
  observeActivation(): Promise<ActivationEvidence | undefined>;
  /**
   * **HUP 전에** 새 epoch 의 멤버십 슬롯을 적재한다 (§6.5-1 staging).
   *
   * 순서가 뒤집히면 — 새 워커가 accept 를 시작한 *뒤에* 슬롯을 채우면 — 그 사이 새
   * 워커는 자기 슬롯이 비어 있어 트래픽을 끊는다(§6.5-3 이 요구하는 동작이다).
   * 그래서 **게시 뒤, 신호 전**이다.
   *
   * **선택적이다.** 멤버십 평면은 엔진 capability(`*_lua`)로 켜지므로, 없는 배포에서는
   * 이 메서드도 없다. 정적 `server` 줄로 렌더된 세대에는 적재할 것이 없다.
   *
   * 자료는 **세대 안에** 있다 (§7.2 `lua/`). 봉투는 좌표를 나르고 자료는 세대가 나른다 —
   * 그래야 `ApplyOperation` 을 넓히지 않는다.
   */
  stageMembership?(generation: string, plane: Plane, lease: ApplyLease): Promise<Checked>;
  /**
   * **활성 epoch 안에서** 멤버십만 바꾼다 (§6.5 · §6.4 드리프트 분리).
   *
   * `stageMembership` 과의 차이는 시점이다. 저쪽은 *새 epoch 를 준비*하고 HUP 이 뒤따르며,
   * 이쪽은 **이미 서빙 중인 epoch** 의 슬롯을 갈아 끼운다 — **reload 가 없다.**
   * S1 이 실증한 경로가 이것이고, 이 제품의 이유다.
   */
  /**
   * **lease 를 안 받는다.** 다른 부작용과 다른 점이다.
   *
   * lease 는 apply **실행권**에 매달려 있는데, 멤버십은 그 권한을 기다리면 안 된다 —
   * §6.5-6 이 *"prepare 동안에도 활성 epoch 는 헬스 갱신을 계속 받는다"* 고 못 박았다.
   * 설정 전환이 도는 동안 헬스가 멈추면 죽은 백엔드로 트래픽이 계속 간다.
   *
   * 그럼 무엇이 지키나 — **좌표 CAS 다.** `applyHealth` 가 토큰과 `(epoch,
   * membership_revision)` 을 확인하고 통과한 뒤에만 여기 온다. 늦게 착지한 갱신은
   * 다음 갱신이 덮는다 (§6.4: 멤버십은 드리프트 판정 대상이 아니다 — 항상 움직인다).
   */
  pushMembership?(
    plane: Plane, epoch: string, slots: Record<string, string[]>,
  ): Promise<void>;
}


// ── 러너 ─────────────────────────────────────────────────────────────────

/**
 * 신호를 보낸 뒤 관측까지 얼마나 기다리는가.
 *
 * `FakeEffects` 는 HUP 이 즉시 반영되지만 **실제 nginx 는 아니다.** 신호 직후에 관측해
 * "아직 안 바뀌었다" 고 판정하면 멀쩡한 reload 를 실패로 몰고 재전송만 늘린다.
 * end-to-end 를 붙이고 나서야 드러난 차이다 — S7 의 판정 예산(< 3s) 안에서 폴링한다.
 */
export type PollPolicy = {
  attempts: number;
  intervalMs: number;
  sleep: (ms: number) => Promise<void>;
  /**
   * 부작용 하나에 주는 예산 (11차 반례 ⑤).
   *
   * **취소는 못 한다.** Promise 는 취소되지 않고, 이미 나간 `docker exec` 나 `kill` 도
   * 되돌릴 수 없다. 할 수 있는 것은 **기다림을 끊고 실패로 확정하는 것**이다.
   * 그러면 러너가 끝나고 `exclusiveApply` 가 풀린다 — 안 그러면 멈춘 러너 하나가
   * 그 뒤의 모든 apply 를 줄 세운다.
   *
   * 버려진 부작용이 뒤늦게 착지하는 문제는 수렴(`reconcileConfig`)이 맡는다.
   */
  effectTimeoutMs: number;
};

export class EffectTimeout extends Error {
  constructor(readonly effect: string, readonly budgetMs: number) {
    super(`부작용 '${effect}' 가 예산 ${budgetMs}ms 안에 끝나지 않았다`);
    this.name = 'EffectTimeout';
  }
}

const DEFAULT_POLL: PollPolicy = {
  attempts: 25,
  intervalMs: 100,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  // S7 의 판정 예산(< 3s)보다 넉넉하되 유한하다.
  effectTimeoutMs: 10_000,
};

export class ApplyRunner {
  private readonly poll: PollPolicy;
  private history: Phase[] = [];

  /**
   * **DpAgent 가 durable 상태를 소유한다.** 저널과 좌표가 서로 다른 소유자를 가지면
   * 같은 store 를 두고 덮어쓴다 — 5차 반례 ②④ 가 그것이었다.
   */
  constructor(
    private readonly agent: DpAgent,
    private readonly effects: Effects,
    poll: Partial<PollPolicy> = {},
  ) {
    this.poll = { ...DEFAULT_POLL, ...poll };
  }

  phases(): Phase[] {
    return this.history;
  }

  /** 부작용에 예산을 씌운다. 넘기면 기다림을 끊는다 (11차 반례 ⑤). */
  private budget<T>(effect: string, run: () => Promise<T>): Promise<T> {
    const ms = this.poll.effectTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new EffectTimeout(effect, ms)), ms);
      run().then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  /**
   * 오퍼레이션을 실행한다.
   *
   * 순서가 계약이다 (§3.4 · §3.5 · §6.5).
   *
   *   1. 봉투 검사        — 무엇을 바꾸는지 말하지 않는 변이는 없다
   *   2. **전 평면 예약**  — 하나라도 막히면 **아무 부작용도 내지 않는다**
   *   3. 게시
   *   4. **전 평면 staging** — HUP 앞에. 한쪽만 올린 채로 신호를 보내지 않는다
   *   5. HUP
   *   6. 증거 관측        — 세대만이 아니라 config test·error log·워커까지
   *   7. **전 평면 commit** — 증거가 활성화를 증명한 뒤에
   */
  async run(op: ApplyOperation): Promise<ApplyResult> {
    assertEnvelope(op);

    // §3.5 · 6차 반례 ③ — 리더 토큰 · 좌표 CAS · **apply 실행권**이 게시보다 먼저다.
    // 전 평면을 한 임계구역에서 잡으므로 부분 예약이 남는 경우가 없다.
    // 저널은 하나뿐이라 **앞선 오퍼레이션의 종단 기록이 남아 있다.** 그걸 그대로 두고
    // drive 하면 남의 저널을 읽고 `operation_in_flight` 로 스스로 막힌다.
    //   · 같은 오퍼레이션의 기록이면 이어받는다 (동시 호출·복구).
    //   · 아니면 내 것으로 연다. seq 는 이어서 올린다.
    //
    // **잡기와 첫 저널을 한 번에 쓴다** (16차 검수). 나눠 쓰면 그 사이에 끊겼을 때
    // 실행권만 있고 저널은 없는 상태가 남고, 복구가 그걸 반납하지 않아 그 뒤 모든
    // 오퍼레이션이 막힌다. 치우는 대신 그 상태를 없앤다.
    // **`seq` 는 넘기지 않는다.** 밖에서 읽으면 밀린 값이고, 두 러너가 같은 값을 읽으면
    // seq 가 되감긴다. 이어받을지 새로 열지도 임계 구간 안에서 정한다.
    await this.agent.reserveAll(op, {
      op,
      phase: 'preflight',
      reloadAttempts: 0,
      progress: progressOf(op, 'reserved'),
    });
    return this.drive(op);
  }

  /**
   * 재시작 후 이어받는다. 저널의 단계에서 시작하되, **애매한 지점은 관측으로 확정**한다.
   */
  async recover(): Promise<ApplyResult> {
    const j = this.agent.readJournal();
    // §6.2 #1 — 첫 저널 쓰기 전에 죽었으면 부작용도 없다. "실패" 가 아니라 "없던 일" 이다.
    //
    // **없던 일로 치되 자리는 비운다** (16차 검수). 전에는 그대로 돌아갔고, 실행권과
    // 예약이 남아 그 뒤 모든 오퍼레이션이 `operation_in_flight` 로 막혔다 — 영구히.
    if (j === undefined) {
      await this.agent.releaseIdleHolder();
      return emptyResult();
    }
    if (isTerminalPhase(j.phase)) {
      // 종단 기록 뒤 반납 전에 죽었을 수 있다. 여기서 마저 놓는다 (멱등).
      //
      // **승격도 여기서 마저 한다** (14차). 13차 ② 를 고치면서 승격을 `finishOperation`
      // 안으로 접었는데, 이 경로에 `promote` 를 안 넘기고 있었다. 그래서 `activated`
      // 저널을 쓰고 반납 전에 죽으면 복구가 기준을 **승격하지 않고 지웠다** — 활성화는
      // 일어났는데 되돌릴 곳이 없다고 답하게 된다.
      await this.agent.finishOperation(
        j.op,
        planesOf(j.op).filter((p) => j.progress?.[p] !== 'committed'),
      );
      return resultOf(j);
    }
    // **낡은 토큰의 고아는 닫는다** (20차 CE-2). 다시 잡으려 하면 `assertLeader` 가
    // `stale_leader` 로 막고, 그러면 `unfinished` 의 처방("복구를 부르면 끝난다")이
    // **거짓이 된다** — 수렴이 영영 `unfinished` 만 답한다. 옛 리더는 어차피 더 갈 수
    // 없으므로 닫는 것이 답이다(7차의 "펜싱이 곧 승계다" 와 같은 논리).
    if (BigInt(j.op.leaderToken) < BigInt(this.agent.maxLeaderToken())) {
      await this.agent.closeJournal(j.op, 'superseded');
      // **예약도 반납한다** (21차 CE-B). 저널만 닫으면 `status()` 는 깨끗하다는데 같은
      // 좌표의 새 오퍼레이션이 `slot_taken` 으로 죽는다 — 처방이 두 번 불러야 참이 되고,
      // 그 사이 진단 신호가 거짓말을 한다. `reserveAll` 의 고아 청소는 `supersede` 로
      // 슬롯까지 지우는데 이쪽만 안 했다. **두 경로의 비대칭이었다.**
      await this.agent.releaseStaleSlots(j.op);
      return resultOf(this.agent.readJournal() ?? j);
    }
    // **고아가 됐으면 다시 잡는다** (14차 · 모델이 찾았다). 비종단 저널인데 실행권이
    // 없으면 `drive` 가 `not_reserved` 로 죽고 그 전환은 영구히 막힌다.
    await this.agent.reclaimOperation(j.op);
    return this.drive(j.op);
  }

  /** 신호 직후 반영을 기다린다. 예산 안에 안 바뀌면 그냥 돌아가 상위가 판정한다. */
  private async awaitActivation(target: string): Promise<ActivationEvidence | undefined> {
    let last: ActivationEvidence | undefined;
    for (let i = 0; i < this.poll.attempts; i += 1) {
      last = await this.observe();
      if (provesActivation(last, target)) return last;
      await this.poll.sleep(this.poll.intervalMs);
    }
    return last;
  }

  /** 관측 실패는 "모른다" 지 "실패" 가 아니다 — 상태기계가 재시도로 판정한다. */
  private async observe(): Promise<ActivationEvidence | undefined> {
    const o = await this.observeRead();
    return o.read ? o.evidence : undefined;
  }

  /**
   * **관측이 됐는지와 무엇을 봤는지를 갈라서 돌려준다** (▲ 잔여물, 2026-08-23).
   *
   * `observe()` 는 둘을 `undefined` 하나로 접는다. 그래서 *"세계를 읽었는데 옛 세대였다"*
   * 와 *"세계를 아예 못 읽었다"* 가 구분되지 않았고, 상한에 닿으면 러너가 양쪽 모두에
   * **"활성화가 관측되지 않았다"** 라고 적었다 — 뒤쪽에서 그건 거짓이다. 우리는 활성화를
   * 관측하지 *못한* 것이지, 활성화가 *안 일어난* 것을 관측한 게 아니다.
   *
   * 그 거짓이 실제로 값을 치렀다: `spike/s12` 의 간헐 빨강에서 러너는 `failed` 라고
   * 말했는데 `link` 와 `served` 는 이미 목표 세대였다. **세계는 수렴해 있었다.**
   * 종단 기록이 세계에 대해 거짓을 주장하면, 그걸 읽는 운영자와 복구 경로가 둘 다
   * 틀린 곳을 본다.
   *
   * 관측 실패는 `budget()` 의 예산 초과이거나 admin 소켓 타임아웃이다. 둘 다 **읽기**의
   * 실패이지 세계의 상태가 아니다.
   */
  private async observeRead(): Promise<
    { read: true; evidence: ActivationEvidence | undefined } | { read: false }
  > {
    try {
      return { read: true, evidence: await this.budget('observeActivation', () => this.effects.observeActivation()) };
    } catch {
      return { read: false };
    }
  }

  /**
   * ⚠️ **완전히 닫히지 않는 경합이 남는다** (7차 반례 ② · 8차 검수).
   *
   * `assertOwnership` 을 부작용 **직전**까지 당겼지만 검사와 `publish`/`signalReload`
   * 사이에는 여전히 틈이 있다. 그 틈을 없애려면 효과 대상(nginx)이 리더 토큰을 이해하고
   * 낡은 토큰의 요청을 스스로 거부해야 하는데, 심볼릭 링크 교체와 SIGHUP 에는 그런
   * 자리가 없다.
   *
   * **7차 때 여기 적었던 "남는 위험의 경계" 는 틀렸다.** 8차 검수가 반례를 냈고 재현했다.
   *
   *   옛 러너가 `publish()` 안에 들어간 뒤 멈춘다 → 승계 → 신임 작업이 activated
   *   → 그제서야 옛 `publish()` 가 착지한다
   *
   *   결과:  current = **옛 세대**,  좌표 = 신임 세대
   *
   * "신임 게시가 덮는다" 는 게시 **순서**를 가정한 말이었는데 그 가정이 성립하지 않는다.
   * 좌표가 개별적으로 안전한 것과 **시스템이 정합한 것은 다르다** — 이 상태로 nginx 가
   * 재시작하면 컨트롤 플레인이 믿는 것과 다른 세대를 서빙한다.
   *
   * **그 뒤 답을 바꿨다** (9차 이후). 위 문단의 결론("표면을 그대로 동결하면 이 결함이
   * 계약이 된다")은 **막는 것으로 닫으려던 시절의 말**이고, 지금은 그렇게 하지 않는다.
   * 18차 검수가 이 주석이 동결 주장과 충돌한다고 지적했고, 맞다 — 갱신한다.
   *
   * 지금의 답: **막지 않고 덮는다.** 외부 효과는 취소할 수 없고 nginx 는 토큰을 모른다.
   * 그래서 늦은 착지를 **관측하고 되돌리는 것**이 답이고, `reconcileConfig` 가 그 일을
   * 한다(9차 이후 conformance 로 고정돼 있다).
   *
   * 그러면 동결해도 되는가 — **조건부로 그렇다.**
   *   · `Effects` 는 "부작용을 어떻게 내는가" 의 계약이고, 그 모양은 이 창과 무관하다.
   *   · `ApplyLease` 는 15차에 **타입 의무**가 됐다(`Checked`). 남은 것은 "언제 부르는가"
   *     인데 그건 어떤 타입으로도 못 막는다 — supervisor 로 옮겨도 마찬가지다.
   *   · 정합성의 근거는 **수렴**이다. 그러니 동결이 고정하는 것은 "이 창이 없다" 가
   *     아니라 "**이 창이 있고 수렴이 덮는다**" 다. 그 말이 참인지가 진짜 게이트다.
   *
   * ⚠️ 그리고 18차가 그 기둥을 한 번 깼다(반례 #1 — 수렴이 옛 기준으로 `converged` 를
   * 답했다). 고쳤지만, **▲ 로 남긴 넷이 전부 이 기둥에 매달려 있다.**
   */
  /** 상태기계는 한 번에 하나만 돈다 (6차 반례 ③). 뒤에 온 호출은 끝난 결과를 읽는다. */
  private drive(bound: ApplyOperation): Promise<ApplyResult> {
    return this.agent.exclusiveApply(() => this.driveInner(bound));
  }

  /**
   * @param bound 이 호출이 책임지는 오퍼레이션.
   *
   * **저널에 있는 것을 무조건 몰지 않는다** (8차 반례 ③). 전에는 매 반복마다 저널을
   * 다시 읽어 거기 있는 것을 실행했다. 그 사이 승계가 일어나 저널 주인이 바뀌면
   * **옛 러너가 신임 오퍼레이션을 대신 끝까지 몰았다** — 소유권 검사도 통과한다,
   * 저널의 op 를 기준으로 보기 때문이다.
   */
  private async driveInner(bound: ApplyOperation): Promise<ApplyResult> {
    try {
      return await this.driveLoop(bound);
    } catch (e) {
      if (!(e instanceof EffectTimeout)) throw e;
      // **예산을 넘긴 것은 실패다.** 매달린 채로 두면 뒤의 모든 apply 가 줄 선다.
      //
      // 다만 **자기 것만 정리한다** (12차 반례 ①). 기다리는 사이 신임 오퍼레이션이
      // 저널을 열었을 수 있고, 그걸 failAll 하면 진행 중인 남의 일을 망가뜨린다.
      // 11차에 넣은 deadline 이 만든 구멍이다 — 고치면서 또 열었다.
      const j = this.agent.readJournal();
      // **토큰까지 본다** (C — 34차 검수). id 만 보면 낡은 러너가 **같은 id 로 재발급된
      // 신임 저널**을 제 것으로 읽고, 예산 만료 시 `failAll` 로 **진행 중인 신임 전환을
      // 닫는다.** 그때 쓰는 토큰이 저널의 것(= 피해자의 것)이라 `assertLeader` 도
      // `writeJournal` 도 `finishOperation` 도 전부 통과한다 — 아무도 못 막는다.
      //
      // 9·10차가 `releaseHolderSlots`·`finishOperation` 에서 고친 것의 **마지막 잔재**다.
      // 그 둘은 토큰을 보는데 여기만 안 봤다.
      const mine = ownsJournal(j, bound);
      if (mine && j !== undefined) {
        await this.failAll(j, e.message);
        return { ...resultOf(this.agent.readJournal() ?? j), failure: e.message };
      }
      // 남의 것이면 손대지 않고 물러난다. 내 실패는 내 결과에만 적는다.
      return { ...emptyResult(), failure: e.message };
    }
  }

  private async driveLoop(bound: ApplyOperation): Promise<ApplyResult> {
    // 절대 상한. 논리 오류가 프로세스를 매달면 안 된다.
    const HARD_LIMIT = 64;
    for (let guard = 0; ; guard += 1) {
      const j = this.agent.readJournal();
      if (j === undefined) return emptyResult();
      // **내가 맡은 오퍼레이션인가.** 저널이 남의 것으로 바뀌었으면 여기서 손을 뗀다.
      //
      // **다만 내 실행권은 놓고 간다** (20차 · 모델이 찾았다). 그냥 물러나면 내가 잡은
      // 실행권이 남아 그 뒤 모든 오퍼레이션이 `operation_in_flight` 로 막힌다 — 상태는
      // 내내 정합하므로 불변식도 P0~P7 도 무풍이고, **일이 안 되는 것**만 남는다.
      // 20차가 "계측기가 전부 나쁜 일만 본다" 고 한 그 사각이다.
      // 여기도 같은 비교다 (C). `ownsJournal` 하나로 모은다 — 자리가 둘이면 갈린다.
      //
      // ⚠️ **35차에 여기 "동치다" 라고 적었는데 거짓이었다** (36차 검수가 뒤집었다).
      //
      // 그때 적은 근거는 "fence 뒤에는 낡은 토큰의 쓰기가 agent 층에서 전부
      // `stale_leader` 로 막히므로 낡은 러너는 이 검사에 닿기 전에 죽는다" 였다.
      // **`awaitActivation` 은 토큰이 없는 관측 경로다** — 낡은 러너는 거기서 fence 를
      // **산 채로 건넌다**(직접 확인했다). 죽는 것은 그 뒤 **첫 쓰기**에서이지 이
      // 검사 앞이 아니다.
      //
      // 그리고 근거로 든 뮤테이션(id-only 로 되돌려도 아무도 안 죽는다)이 뜻하는 것은
      // **"스위트가 못 가른다"** 이지 "도달 불가" 가 아니다. **그 둘을 뒤바꾸는 것이
      // 이 레포가 반복해 앓은 병이고, 나는 그 병의 이름을 적은 회차에서 그것을 했다.**
      //
      // 지금 상태: **검출력 0 이고, 도달 가능성은 열려 있다.**
      //
      // **위쪽 `driveInner` 의 `mine` 은 다르다.** 거기서 `failAll` 이 쓰는 토큰은
      // `bound` 가 아니라 **저널의 것 — 즉 피해자의 것**이라 agent 층 검사를 통과한다.
      // 그래서 그쪽만 하중을 받았다. 같은 술어인데 한쪽만 일하는 이유가 그것이다.
      //
      // 그래도 바꾼 채로 둔다: 술어가 갈라져 있으면 언젠가 하나가 뒤처진다(CE-35-A 가
      // 바로 그것이었다). **동치를 동치라고 적을 뿐 검출력이 있다고 적지 않는다.**
      if (!ownsJournal(j, bound)) {
        // **여기는 id 만 본다 — 위임에 의한 무해다** (37차 census).
        //
        // 34·35·36차의 census 가 **세 번 다 이 자리를 안 셌다.** 위험 방향(낡은 러너가
        // 남의 실행권을 놓는 것)은 `finishOperation` 이 홀더 토큰을 보고 막는다. 그래서
        // 지금은 무해하지만 **근거가 하류에 있다** — `finishOperation` 의 토큰 검사가
        // 바뀌면 이 자리가 조용히 열린다.
        //
        // ⚠️ **37차에 여기 "동치다" 라고 적었는데 거짓이었다** (38차가 재현으로 뒤집었다).
        //
        // 이 분기는 **낡은 러너 + 같은 id 신임 홀더**로도 도달한다 —
        // `debt-evidence-pollution` 이 정확히 그 경로를 지난다. 그때
        // `finishOperation(bound=낡은 것)` 이 불리고, 하류 `finalizeCandidate` 의 **id 게이트**가
        // **신임의 미완 후보를 durable 하게 지운다.** 토큰을 더하면 그 변이 자체가 없다 —
        // **관측상 동치일지언정 기계적으로 동치가 아니다.**
        //
        // 35차에 같은 모양의 "동치" 주장이 거짓으로 판명됐고, **그 사건을 인용한 회차에서
        // 또 적었다.** 무해한 이유는 동치가 아니라 **자가 치유**다: 삭제 창 동안 저널이
        // 비종단이라 수렴은 계속 `unfinished` 를 답하고(오답 창 없음), 신선한 commit 이
        // 후보를 재생성한다. **둘 다 39차가 재현으로 확인했다.**
        //
        // **삭제만 하는 것이 아니다** (39차 CE-39-c). 전 평면이 도착한 뒤의 창에서는
        // `arrived=true` 라 낡은 러너가 **신임의 후보를 기준으로 올린다.** 결과는 신임
        // 자신의 승격과 같아 무해하지만, 38차 주석이 삭제 방향만 적어 절반이었다.
        //
        // **위임 대상은 셋이다** — `finishOperation` 의 홀더 토큰 검사 · `ownsSlot` 의
        // canonical 대조 · 그리고 `finalizeCandidate`/`candidateArrived` 의 **수렴성**.
        // 셋째는 토큰 검사가 아니라 **비국소 성질**이라, commit 의 후보 재생성이나
        // `candidateArrived` 를 바꾸면 이 자리가 조용히 열린다.
        const mine = this.agent.activeOperation();
        if (mine?.operationId === bound.operationId && mine.transitionId === bound.transitionId) {
          await this.agent.finishOperation(bound);
        }
        return emptyResult();
      }
      // **종단은 읽고 돌아가는 것뿐이다.** 부작용이 없으므로 소유권 검사 앞에 온다 —
      // 종단에 닿으면 실행권을 이미 놓은 뒤라 검사가 오히려 걸린다.
      //
      // 다만 **놓기는 해야 한다** (14차 검수). 같은 오퍼레이션으로 재진입하면 `run()` 이
      // 예약과 실행권을 다시 잡은 뒤 여기서 종단을 만나고, 그대로 돌아가 버렸다 —
      // 실행권이 남아 다음 오퍼레이션이 막힌다. 멱등이므로 다시 불러도 안전하다.
      if (isTerminalPhase(j.phase)) {
        // **놓을 것이 있을 때만 쓴다.** `finishOperation` 은 직렬 구간이라 부를 때마다
        // durable write 가 하나 생긴다 — 정상 경로에서 크래시 지점이 늘어난다.
        // 여기도 id 만 본다 (37차 census — 여섯 번째 자리).
        //
        // ⚠️ **37차에 "I1 이 보장하므로 불능" 이라고 적었는데 거짓이었다** (38차 재현).
        // **I1 은 홀더 = 최신 토큰만 보장하지 홀더 = 저널 토큰은 보장하지 않는다.**
        // `reserveAll` 을 `opening` **없이** 부르면(공개 표면의 선택 인자) 저널 정리·개방이
        // 통째로 건너뛰어져 **저널 X/10(superseded) + 홀더 X/11** 이 공존한다.
        //
        // 그래서 이 자리도 **위 자리와 같은 하류 위임**이다 — "구조적" 이라는 구분 자체가
        // 틀렸다. 위임 대상도 같다.
        const holder = this.agent.activeOperation();
        if (holder?.operationId === j.op.operationId
          && holder.transitionId === j.op.transitionId) {
          await this.agent.finishOperation(
            j.op,
            planesOf(j.op).filter((p) => j.progress?.[p] !== 'committed'),
          );
        }
        return resultOf(j);
      }
      // **이미 끝난 전환은 밀지 않는다** (22차 R4).
      //
      // `abortConfig` 는 직렬 쓰기 넷이라 마지막(저널 닫기) 직전에 죽을 수 있다. 그러면
      // `terminal='aborted'` 인데 저널은 비종단으로 남고, 복구가 **포기한 세대를 게시**했다.
      // terminal 검사가 `stage`/`commit` 의 `admit` 에서야 나와서, 그 앞의 게시는 그냥
      // 지나갔다 — **되돌릴 수 없는 연산이 검사보다 먼저 있었다.**
      //
      // **포기·실패로 닫힌 것만 본다.** 전 평면이 `activated` 로 끝난 것은 정상 경로가
      // 마저 처리해야 한다 — 처음엔 그걸 안 갈라서 활성화된 전환을 `failed` 로 닫았다.
      //
      // **`aborted` 는 하나로 족하다** (23차 CE-B). `every` 만 쓰면 창의 절반만 닫힌다 —
      // `abortConfig` 의 abort 는 평면마다 따로 도는 직렬 쓰기라 루프 **도중**에 죽으면
      // `{http:'aborted'}` 하나만 남고, 혼합 종단은 `every` 를 통과 못 해 복구가 그냥
      // 지나가며 포기한 세대로 HUP 을 보냈다.
      //
      // 둘을 다르게 보는 이유가 있다. `aborted` 를 쓰는 자리는 운영자의 `abortConfig` 와
      // `reserveAll` 의 고아 청소(전 평면을 한 쓰기에 적는다)뿐이라, **하나만 보여도
      // "이 전환은 포기됐다" 는 뜻**이다. `failed` 는 정상 apply 의 `failAll` 이 평면별로
      // 남기므로 하나로는 아무 뜻이 아니다 — 그래서 전부일 때만 센다.
      const kinds = planesOf(j.op).map((plane) => this.agent.terminalOf(tupleFor(j.op, plane)));
      const closed = kinds.includes('aborted')
        || kinds.every((k) => k === 'aborted' || k === 'failed');
      if (closed) {
        // **여기서도 `reachedPhase()` 다** (24차 CE-24-A). 22차까지 `closed` 는 `every`
        // 라서 참이면 `activated` 평면이 있을 수 **없었고**, 그래서 `'failed'` 하드코딩이
        // 항상 참말이었다. 23차가 CE-B 를 고치며 `includes` 로 혼합 종단을 이 분기에
        // 끌어들여 **그 전제를 깼는데 하드코딩은 그대로 뒀다** — `[activated, aborted]`
        // 가 "다 실패했다" 로 적힌다. §3.4 계열의 **다섯 번째 재발**이다.
        //
        // 23차는 판정을 한 곳으로 모으는 규칙을 만들어 놓고 **자기가 손댄 이 자리를
        // 빠뜨렸다.** 종단을 적는 자리는 셋이다 — `failAll` · `abortConfig` · 여기.
        // 규칙을 세우는 것과 전 자리에 적용하는 것은 다른 일이고, 안 한 쪽이 재발한다.
        // 폴백을 안 단다 (25차). 여기 오려면 `j` 가 있어야 하므로 `reachedPhase()` 가
        // `undefined` 를 줄 수 없다 — 24차에 `failAll` 에서 지운 것과 **똑같은 죽은
        // 폴백**을 나는 그 규칙을 쓴 커밋 안에서 다시 써 넣었다. 25차 스윕이 짚었다.
        await this.agent.closeJournal(
          j.op,
          this.agent.reachedPhase() as 'activated' | 'partial_exhausted' | 'failed',
        );
        // **자리도 비운다.** 닫기만 하고 물러나면 실행권이 남아 다음 오퍼레이션이 막힌다
        // — 20차에 배운 그것이다. 새 조기 반환을 만들 때마다 이걸 빠뜨린다.
        await this.agent.finishOperation(j.op, planesOf(j.op));
        const after = this.agent.readJournal();
        return resultOf(after !== undefined && isTerminalPhase(after.phase) ? after : j);
      }

      // **부작용 앞에서 매번 확인한다** (6차 반례 ⑥). 예약은 과거의 승인일 뿐이고,
      // 그 사이 새 리더가 fence 했을 수 있다.
      this.agent.assertOwnership(j.op);
      if (guard > HARD_LIMIT) {
        throw new Error(
          `apply 상태기계가 ${HARD_LIMIT} 회 안에 끝나지 않았다 (phase=${j.phase}). ` +
            `전이 규칙에 사이클이 있다.`,
        );
      }
      const gen = j.op.targetGeneration;

      switch (j.phase) {
        case 'preflight': {
          // **게시 앞이다.** 여기서 걸리면 current 는 그대로고 nginx 도 그대로다.
          const check = await this.budget('preflight', () => this.effects.preflight(j.op));
          this.agent.assertOwnership(j.op);
          if (!check.ok) {
            await this.failAll(j, check.reason ?? '게시 전 검사 실패');
            break;
          }
          await ignoreConflict(this.write(next(j, { phase: 'publish_intent' })));
          break;
        }
        case 'publish_intent': {
          // 기록은 있는데 게시했는지 모른다 → 관측한다. 이미 됐으면 다시 하지 않는다.
          // **세대 이름이 아니라 소유자까지 본다.** 같은 이름이어도 남이 게시한 것이면
          // 내 것이 아니다 — 그걸 구분하지 못하면 수렴할 수가 없다.
          const seenPub = await this.budget('observePublished', () => this.effects.observePublished());
          if (!publishedByMe(seenPub, j.op)) {
            // **게시 앞에 의도를 남긴다** (12차 반례 ②). 게시만 하고 끊기면 활성화 기준이
            // 없어 reconcile 이 손을 놓는다 — 그 상태를 드러낼 수 있어야 한다.
            await this.agent.recordPublishIntent(recordOf(j.op));
            await this.budget('publish', () => this.effects.publish(recordOf(j.op), this.agent.lease(j.op)));
          }
          await ignoreConflict(this.write(next(j, { phase: 'published' })));
          break;
        }
        case 'published': {
          // §6.5-1 — 슬롯은 **HUP 앞에** 올린다. 새 워커가 accept 를 시작한 뒤에 올리면
          // 그 사이 옛 상태로 peer 를 고른다. **두 평면 다** 올린 뒤에 신호를 보낸다.
          //
          // **한 평면이 더 못 가는 것은 종단이 아니다** (14차 · 모델이 찾았다). 전에는
          // `stage` 의 거부가 그대로 밖으로 나갔고, 저널은 `published` 로 굳었다. 그러면
          // 복구를 몇 번을 불러도 같은 자리에서 던지고 **그 전환은 영영 못 끝난다** —
          // 실행권도 안 놓이므로 다음 오퍼레이션까지 막힌다. 남이 슬롯 하나를 걷어차면
          // (abort) 그렇게 됐다.
          //
          // 평면별로 받아 적는다. 어디까지 갔는지 말하는 것이 여기서 할 일이다 (§3.4).
          const staged: Record<string, PlaneProgress> = { ...(j.progress ?? {}) };
          let advanced = 0;
          for (const plane of planesOf(j.op)) {
            try {
              await this.agent.stage(tupleFor(j.op, plane), gen);
              // **좌표를 예약한 뒤 실물을 적재한다** (§6.5-1). 순서가 반대면 예약도 안 된
              // 슬롯에 자료가 들어간다. 멤버십 평면이 없는 배포에서는 이 메서드가 없다.
              if (this.effects.stageMembership !== undefined) {
                await this.budget('stageMembership', () =>
                  this.effects.stageMembership!(gen, plane, this.agent.lease(j.op)));
              }
              staged[plane] = 'staged';
              advanced += 1;
            } catch (e) {
              if (!(e instanceof DpRejection)) throw e;
              staged[plane] = 'failed';
            }
          }
          if (advanced === 0) {
            // 아무 평면도 못 간다. 끌고 갈 이유가 없다 — 닫고 반납한다.
            await this.failAll(j, '모든 평면이 더 진행할 수 없다');
            break;
          }
          await ignoreConflict(this.write(next(j, { phase: 'membership_staged', progress: staged })));
          break;
        }
        case 'membership_staged': {
          await ignoreConflict(this.write(next(j, { phase: 'reload_intent' })));
          break;
        }
        case 'reload_intent': {
          // 신호를 보냈는지 모른다 → **먼저 관측한다.** 이미 반영됐으면 재전송하지 않는다.
          const read = await this.observeRead();
          const seen = read.read ? read.evidence : undefined;
          if (read.read && provesActivation(seen, gen)) {
            await ignoreConflict(
              this.write(next(j, { phase: 'reload_observed', ...(seen ? { evidence: seen } : {}) })),
            );
            break;
          }
          /**
           * **세계를 못 읽었으면 다시 안 보낸다** (▲ 잔여물, 2026-08-23).
           *
           * 재전송은 *"세계를 읽었더니 아직 옛 세대다"* 에 대한 답이다. 읽기 자체가
           * 실패한 것에 그걸로 답하는 것은 **읽기 실패에 쓰기로 답하는 것**이고, 남는
           * 것은 쌓인 워커 세대뿐이다 (§6.4 admission control). 정작 세계는 이미 수렴해
           * 있을 수 있고 — S12 에서 실제로 그랬다.
           *
           * 다만 **아직 한 번도 안 보냈으면 보낸다.** HUP 은 행동이고 관측은 확인이다.
           * 확인이 안 된다고 행동을 안 하면 admin 소켓이 한 번 딸꾹일 때마다 전환이
           * 통째로 멈춘다. 확인이 안 되는 상태에서 **반복**하지 않을 뿐이다.
           */
          const blind = !read.read;
          if (j.reloadAttempts >= RELOAD_ATTEMPT_LIMIT || (blind && j.reloadAttempts > 0)) {
            // 상한을 넘었다. 무한 재전송은 워커 세대만 쌓는다 (§6.4 admission control).
            // **실패도 종단이다.** 전 평면의 슬롯을 반납한다.
            //
            // **사유를 남긴다.** 여기만 사유 없이 닫고 있었고, 그래서 `{"phase":"failed"}`
            // 만 돌아왔다 — 실제로 이 자리에서 두 번 진단이 막혔다. 관측한 증거도 함께
            // 싣는다: 무엇을 보고 활성화가 아니라고 판정했는지가 진단의 전부다.
            //
            // ⚠️ **두 사유는 다른 주장이다.** 위쪽은 세계에 대한 주장이고(읽었고, 답이
            // 목표가 아니었다), 아래쪽은 **주장을 안 하는 것**이다(못 읽었다). 둘을 같은
            // 문장으로 닫으면 종단 기록이 거짓을 담고, 다음 사람은 엔진 로그를 뒤지다가
            // 정작 죽은 것이 admin 경로였다는 것을 못 본다.
            await this.failAll(j, blind
              // 이 문자열은 저널과 JSON 로그로 나간다 — 마크다운을 넣지 않는다.
              ? `reload 를 보낸 뒤 활성화 관측 자체가 실패했다 — 세계의 상태를 모른다`
                + ` (기대 세대 ${gen}). 활성화가 안 일어났다는 뜻이 아니다:`
                + ' 세대가 이미 넘어가 있을 수 있다.'
                + ' admin 소켓과 관측 예산을 먼저 보고, current 링크와 서빙 세대를 직접 확인한다'
              : `reload 를 ${RELOAD_ATTEMPT_LIMIT} 번 보냈는데 활성화가 관측되지 않았다`
                + ` (기대 세대 ${gen}, 관측 ${JSON.stringify(seen ?? null)})`
                + ' — 엔진의 error log 를 본다');
            break;
          }
          // **이 쓰기를 이긴 러너만 HUP 을 보낸다** (6차 반례 ③). 진 쪽은 다시 읽는다.
          try {
            await this.write(next(j, { reloadAttempts: j.reloadAttempts + 1 }));
          } catch (e) {
            if (e instanceof DpRejection && e.kind === 'journal_conflict') break;
            throw e;
          }
          await this.budget('signalReload', () => this.effects.signalReload(this.agent.lease(j.op)));
          const after = await this.awaitActivation(gen);
          if (after !== undefined) {
            // **내 저널에만 쓴다** (8차 반례 ③). 전에는 `readJournal()` 이 돌려주는
            // 것에 썼는데, 그 사이 승계가 일어나면 그건 **남의 오퍼레이션**이다.
            // **토큰까지 본다** (36차 검수). 주석은 "내 저널에만 쓴다" 인데 정작 id 만
            // 봤다 — 8차 반례 ③ 이 지목한 병형("쓰는 토큰이 저널의 것, 즉 피해자의 것")의
            // **세 번째 자리**다. 34차가 두 자리를 고치며 여기를 안 셌고, 35차의 전수
            // 조사도 놓쳤다. **자리를 세는 것이 규칙을 만드는 일의 절반이다** —
            // 세 회차 연속 같은 말을 적고 세 번 다 빠뜨렸다.
            //
            // 증거 오염을 내 손으로 재현하지는 못했다(낡은 러너가 게이트를 건넌 뒤 첫
            // 쓰기에서 죽는다). **그래도 모은다** — 주석이 말하는 술어와 코드가 다른
            // 것 자체가 부채이고, 술어가 갈라져 있으면 언젠가 하나가 뒤처진다.
            const now = this.agent.readJournal();
            if (ownsJournal(now, j.op) && now !== undefined) {
              await ignoreConflict(this.write(next(now, { evidence: after })));
            }
          }
          break;
        }
        case 'reload_observed': {
          // **수렴 확인** (9차 뒤 방향 전환). 활성화를 인정하기 전에 게시가 아직 내
          // 것인지 다시 본다. 늦게 착지한 옛 게시가 있으면 여기서 드러나고, 다시
          // 게시하러 돌아간다 — 막지 못한 것을 **덮어서** 수렴시킨다.
          const stillMine = await this.budget('observePublished', () =>
            this.effects.observePublished());
          if (!publishedByMe(stillMine, j.op)) {
            await ignoreConflict(this.write(next(j, { phase: 'publish_intent' })));
            break;
          }
          // 다시 관측한다. 저널을 쓴 사이에 세대가 또 바뀌었을 수 있다.
          const evidence = await this.observe();
          if (!provesActivation(evidence, gen)) {
            await ignoreConflict(this.write(next(j, { phase: 'reload_intent' })));
            break;
          }
          // 활성화가 증명됐다. 이제 좌표를 옮긴다 (§6.5-4).
          const progress: Partial<Record<Plane, PlaneProgress>> = { ...j.progress };
          for (const plane of planesOf(j.op)) {
            try {
              await this.agent.commit(tupleFor(j.op, plane), evidence!);
              progress[plane] = 'committed';
            } catch (e) {
              // **DpRejection 만 평면 실패다.** 크래시는 여기서 삼키면 안 된다 —
              // 삼키는 순간 "죽었는데 실패로 기록된" 상태가 durable 해진다.
              // S12 의 전 지점 훑기가 이걸 잡았다 (지점 22 에서 크래시가 사라졌다).
              if (!(e instanceof DpRejection)) throw e;
              // 한 평면이 거부돼도 나머지는 그대로 둔다. **어디까지 갔는지 말하는 것**이
              // 여기서 할 일이다 — 지우면 운영자가 알 방법이 없다 (§3.4).
              progress[plane] = 'failed';
            }
          }
          // **범위를 주장하는 다섯 번째 자리다** (25차 감사). 24차가 "종단을 적는
          // 자리는 셋" 이라고 셌는데 그건 `closeJournal` 호출부만 센 것이었다 — `write`
          // 로 직접 적는 자리가 여기와 아래 `stuck.length === 0` 까지 둘 더 있다.
          //
          // 이 둘은 모수를 저널에서 가져오므로 22차 R2 병형(호출자 봉투)은 아니고 지금
          // `reachedPhase()` 와 **동치**다. 그래서 안 모았다. 적어 두는 이유는 다음에
          // 여기를 만지는 사람이 **규칙 밖이라는 것을 알아야** 하기 때문이다.
          const committed = planesOf(j.op).filter((p) => progress[p] === 'committed');
          const phase: ApplyPhase =
            committed.length === planesOf(j.op).length
              ? 'activated'
              : committed.length === 0
                ? 'failed'
                : 'partially_activated';
          // 종단이면 소유권과 못 넘어간 평면의 예약을 반납한다 (6차 반례 ④).
          // **기록이 먼저, 반납이 나중이다.** 반대로 하면 자기 종단 기록이 소유권
          // 검사에 막힌다. 그 사이 죽어도 `recover()` 가 종단을 보고 반납한다.
          await ignoreConflict(this.write(next(j, { phase, progress, evidence: evidence! })));
          if (phase !== 'partially_activated') {
            const stuck = planesOf(j.op).filter((p) => progress[p] !== 'committed');
            // **전 평면이 넘어갔을 때만** 수렴 기준으로 올린다 (13차 반례 ②).
            await this.agent.finishOperation(j.op, stuck);
          }
          break;
        }
        case 'partially_activated': {
          // §6.2 #8 — partial 은 "재시도" 다. 다만 유한해야 한다.
          if (j.reloadAttempts >= RELOAD_ATTEMPT_LIMIT + PARTIAL_RETRY_LIMIT) {
            // 더는 못 민다. **소유권과 남은 예약을 반납하고** 끝낸다 — 안 그러면 그
            // 좌표가 영구히 잠긴다 (6차 반례 ④).
            //
            // 그리고 **저널을 종단으로 닫는다** (12차 반례 ⑤). 비종단으로 두면서
            // 실행권만 풀면, 두 번째 복구가 다시 밀려다 `not_reserved` 로 죽는다.
            // **범위를 주장하는 네 번째 자리다** (24차 감사). 앞의 셋은 `reachedPhase()`
            // 로 모았는데 여기는 안 모았다 — 일부러다. 예산 소진과 전 평면 커밋이 겹치면
            // 좌표는 `activated` 인데 여기는 `partial_exhausted` 를 적는다. 그게 13차 ③
            // 이고 **여섯 번 재현에 실패해** ▲ 로 남아 있다.
            //
            // 재현 경로 없이 고치면 스윕이 그 수정을 못 지킨다 — 다음 회차에 조용히
            // 되돌아온다. 길을 찾으면 그때 `reachedPhase()` 로 모은다. 여기 적어 두는
            // 이유는 **모았다고 말하면서 안 모은 자리를 남기지 않기 위해서**다.
            await ignoreConflict(this.write(next(j, { phase: 'partial_exhausted' })));
            await this.agent.finishOperation(
              j.op,
              planesOf(j.op).filter((p) => j.progress?.[p] !== 'committed'),
            );
            return resultOf(this.agent.readJournal() ?? j);
          }
          const stuck = planesOf(j.op).filter((p) => j.progress?.[p] !== 'committed');
          if (stuck.length === 0) {
            await ignoreConflict(this.write(next(j, { phase: 'activated' })));
            break;
          }
          await ignoreConflict(
            this.write(next(j, { phase: 'reload_observed', reloadAttempts: j.reloadAttempts + 1 })),
          );
          break;
        }
        case 'activated':
        case 'partial_exhausted':
        case 'failed':
        case 'no_operation':
          return resultOf(j);
      }
    }
  }

  /** 전 평면을 실패로 닫는다. 슬롯을 반납해야 좌표가 영구히 잠기지 않는다. */
  private async failAll(j: JournalEntry, reason?: string): Promise<void> {
    // **넘어간 평면을 실패라고 적지 않는다** (13차 반례 ③ · 15차에 고쳤다).
    //
    // 전에는 `progressOf(op, 'failed')` 로 **전부** 실패라고 적었다. 좌표가 이미 옮겨 간
    // 평면이 있어도 그렇게 적으면, 운영자는 "다 실패했다" 고 읽고 실제로는 http 만 새
    // 세대로 서비스 중인 상태를 못 본다. §3.4 는 어디까지 갔는지 말하라고 한다.
    //
    // 13차 검수가 이걸 지적했고 나는 다섯 번 시도해 **재현하지 못했다** — 지금 도달
    // 가능한 경로에서는 여기 오기 전에 부분 처리가 먼저 걸린다. 그래도 이 함수가
    // 거짓을 적는 것 자체가 결함이라 고친다. 도달 경로가 없다는 것은 지금의 사실일 뿐이다.
    const progress: Partial<Record<Plane, PlaneProgress>> = { ...j.progress };
    for (const plane of planesOf(j.op)) {
      // **phase 와 같은 기준으로 판정한다** (26차 CE-26-A). 25차가 digest 조임을
      // `reachedPhase()` 에만 넣고 여기 안 넣어서, 한 결과 안에서 phase 는 "다 실패"
      // 인데 progress 는 "커밋됐다" 가 됐다 — **일관되게 틀린 것보다 나쁘다.**
      // 자리가 둘이면 언젠가 갈린다.
      if (this.agent.movedByMe(j.op, plane)) {
        progress[plane] = 'committed';
        continue;
      }
      await ignoreRejection(this.agent.fail(tupleFor(j.op, plane)));
      progress[plane] = 'failed';
    }
    // **같은 규칙으로 정한다** (23차 CE-A). 13차 ③ 이 처음 고친 자리가 여기이고, 그
    // 뒤 세 번의 재발이 전부 "닫는 자리마다 따로 센" 탓이었다.
    //
    // 23차에는 `?? (committed === 0 ? ...)` 폴백을 달아 뒀는데 **24차 스윕이 그 줄을
    // 짚었다** — 뒤집어도 아무 테스트가 안 죽는다. 당연하다. 이 함수는 저널을 읽은
    // 호출자에게서 `j` 를 받으므로 `reachedPhase()` 가 `undefined` 를 줄 수가 없다.
    // **폴백은 방어가 아니라 죽은 코드였고, 세는 자리를 하나로 모았다는 말을 반쯤
    // 거짓으로 만들고 있었다.** 지운다. 그래야 판정이 정말 한 곳에서만 난다.
    //
    // 단언(`as`)으로 남긴 이유: 여기에 `if (phase === undefined) return` 을 두면 그건
    // **또 하나의 도달 불가 분기**라 다음 스윕이 똑같이 짚는다. 못 오는 길에 방어를
    // 세우는 대신 못 온다는 사실을 적는다.
    const phase = this.agent.reachedPhase() as ApplyPhase;
    // **사유를 저널에 적는다.** 여기 안 적으면 재기동·승계 뒤에 사라진다.
    await ignoreConflict(this.write(next(j, {
      phase, progress,
      ...(reason === undefined ? {} : { failure: reason }),
    })));
    await this.agent.finishOperation(j.op);
  }

  /** 저널 쓰기도 Agent 의 직렬 구간을 지난다 — §6.2 표의 "intent fsync" 지점이다. */
  private async write(entry: JournalEntry): Promise<void> {
    await this.agent.writeJournal(entry);
    if (this.history[this.history.length - 1] !== entry.phase) this.history.push(entry.phase);
  }
}

// ── 봉투 검사와 결과 ─────────────────────────────────────────────────────

/**
 * 봉투와 실린 목표가 **정확히 일치**해야 한다.
 *
 * 느슨하게 두면 "http 만 바꾼다" 고 선언하고 stream 목표를 실어 보내는 요청이 통과한다.
 * 무엇을 바꾸는지 말하지 않는 변이는 감사도 롤백도 안 된다 (§9.1.1 blocker 3).
 */
function assertEnvelope(op: ApplyOperation): void {
  if (op.affectedPlanes.length === 0) {
    throw new DpRejection('empty_envelope', '봉투가 어떤 평면도 말하지 않았다');
  }

  // **설정 전환은 항상 두 평면을 옮긴다** (11차 반례 ②).
  //
  // 하나의 `nginx.conf` 가 http 와 stream 을 함께 지배한다. 세대를 활성화하면 두 평면이
  // 같이 바뀐다 — 한쪽이 **비게 되더라도 그것 역시 전환**이다. 전에는 목표에 있는
  // 평면만 선언하면 통과했고, 그래서 `http+stream → http` 가 stream 을 없애면서도
  // stream 좌표를 옛 값으로 남겼다. 설정은 바뀌었는데 컨트롤 플레인은 모른다.
  const covers = new Set(op.affectedPlanes);
  for (const plane of ['http', 'stream'] as const) {
    if (!covers.has(plane)) {
      throw new DpRejection(
        'envelope_mismatch',
        `설정 apply 는 두 평면을 모두 선언해야 한다 — '${plane}' 가 빠졌다. ` +
          `하나의 nginx.conf 가 둘을 함께 바꾸므로, 비게 되는 평면도 좌표를 옮겨야 한다`,
      );
    }
  }
  const declared = new Set(op.affectedPlanes);
  const carried = new Set(Object.keys(op.planes) as Plane[]);
  for (const p of declared) {
    if (!carried.has(p)) {
      throw new DpRejection('envelope_mismatch', `평면 '${p}' 를 건드린다고 했는데 목표가 없다`);
    }
  }
  for (const p of carried) {
    if (!declared.has(p)) {
      throw new DpRejection('envelope_mismatch', `평면 '${p}' 의 목표가 실렸는데 봉투에 없다`);
    }
  }
}

/** 다음 저널 항목. `seq` 를 항상 하나 올린다 — 단계 전이 CAS 의 근거다. */
const next = (j: JournalEntry, over: Partial<JournalEntry>): JournalEntry => ({
  ...j,
  ...over,
  seq: j.seq + 1,
});

/**
 * 저널 전이 경쟁에서 진 것은 오류가 아니다. 남이 이미 앞으로 밀었다는 뜻이므로
 * 다시 읽고 따라가면 된다.
 */
async function ignoreConflict(p: Promise<unknown>): Promise<void> {
  try {
    await p;
  } catch (e) {
    if (!(e instanceof DpRejection) || e.kind !== 'journal_conflict') throw e;
  }
}

/**
 * 거부는 무시하되 **크래시는 통과시킨다.**
 *
 * `.catch(() => undefined)` 는 편하지만 크래시까지 삼킨다. 그러면 "죽었는데 정상으로
 * 기록된" 상태가 durable 해지고, 크래시 주입 테스트는 아무것도 잡지 못한다.
 */
async function ignoreRejection(p: Promise<unknown>): Promise<void> {
  try {
    await p;
  } catch (e) {
    if (!(e instanceof DpRejection)) throw e;
  }
}

/** 오퍼레이션이 게시하려는 것. **누가** 게시하는지까지 적는다. */
export const recordOf = (op: ApplyOperation): PublishRecord => ({
  generation: op.targetGeneration,
  leaderToken: op.leaderToken,
  operationId: op.operationId,
  transitionId: op.transitionId,
  generationDigest: op.generationDigest,
});

const progressOf = (op: ApplyOperation, at: PlaneProgress): Partial<Record<Plane, PlaneProgress>> =>
  Object.fromEntries(planesOf(op).map((p) => [p, at]));

const emptyResult = (): ApplyResult => ({
  phase: 'no_operation',
  progress: { http: undefined, stream: undefined },
  partialTransition: false,
});

function resultOf(j: JournalEntry): ApplyResult {
  const progress = j.progress ?? {};
  return {
    phase: j.phase,
    progress: { http: progress.http, stream: progress.stream },
    partialTransition: j.phase === 'partially_activated' || j.phase === 'partial_exhausted',
    ...(j.evidence ? { evidence: j.evidence } : {}),
    ...(j.failure === undefined ? {} : { failure: j.failure }),
  };
}
