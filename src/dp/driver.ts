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
  ApplyResult,
  Plane,
  PublishedState,
  PublishRecord,
} from './operation.js';
import { CHECKED_TOKEN, planesOf, provesActivation } from './operation.js';
import { DpAgent, DpRejection, tupleFor, type DurableStore } from './agent.js';
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
   * **게시는 나갔는데 활성화하지 못했다** (12차 반례 ②).
   *
   * 무엇으로 되돌려야 하는지 DP 는 모른다 — 그 게시가 좋은 것인지 판단할 근거가 없다.
   * 조용히 `no_baseline` 이라고 답하는 대신 이 상태를 드러내고 컨트롤 플레인이 정하게 한다.
   */
  | { kind: 'dirty'; intent: PublishRecord; found: PublishedState }
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
        if (this.#stillBaseline(expected)) return { kind: 'converged', record: expected };
        continue; // 기준이 옮겨 갔다 — 새 기준으로 다시 본다
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

      if (!this.#stillBaseline(expected)) continue; // 기준이 바뀌었다 — 다시 본다

      const lease = this.#lease(expected);
      if (!pointerOk) await this.#budget(() => this.effects.publish(expected, lease));
      await this.#budget(() => this.effects.signalReload(lease));

      if (!this.#stillBaseline(expected)) continue;
      const afterPublish = await this.#observe();
      const afterActive = await this.#budget(() => this.effects.observeActivation());
      const ok = afterPublish.kind === 'owned'
        && sameRecord(afterPublish.record, expected)
        && provesActivation(afterActive, expected.generation);
      // **여기서도 읽고-확인한다** (16차 검수). 조기 `converged` 와 소진 경로에는 넣었는데
      // 이 자리만 빠져 있었다. 되돌리고 관측하는 사이 기준이 옮겨 갔으면, 우리가 되돌린
      // 것은 이미 옛 기준이다 — `repaired` 는 "제자리로 돌려놨다" 는 뜻이라 거짓이 된다.
      return ok && this.#stillBaseline(expected)
        ? { kind: 'repaired', expected, found: seen }
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
    const ok = found.kind === 'owned'
      && sameRecord(found.record, now)
      && provesActivation(activation, now.generation)
      && this.#stillBaseline(now); // 여기서도 읽고-확인한다
    return ok ? { kind: 'converged', record: now } : { kind: 'diverged', expected: now, found };
  }

  #stillBaseline(expected: PublishRecord): boolean {
    const now = this.agent.lastActivated();
    return now !== undefined && sameRecord(now, expected);
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
        if (!this.#stillBaseline(expected)) {
          throw new DpRejection('stale_leader', '되돌리는 사이 기준이 바뀌었다');
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
    };
  }
}
