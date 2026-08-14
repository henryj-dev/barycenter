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
  ActivationEvidence,
  ApplyOperation,
  ApplyResult,
  Plane,
  PublishedState,
  PublishRecord,
} from './operation.js';
import { planesOf } from './operation.js';
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

export type ReconcileResult =
  /** 되돌릴 기준이 없다 — 아직 아무것도 활성화하지 않았다. */
  | { kind: 'no_baseline' }
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

  private runner(): ApplyRunner {
    return new ApplyRunner(this.agent, this.effects);
  }

  fence(leaderToken: string): Promise<{ maxToken: string }> {
    return this.agent.fence(leaderToken);
  }

  applyConfig(op: ApplyOperation): Promise<ApplyResult> {
    return this.runner().run(op);
  }

  recoverConfig(): Promise<ApplyResult> {
    return this.runner().recover();
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
    await this.agent.finishOperation(op, planesOf(op));
    if (refused.length > 0) {
      throw new DpRejection('terminal', `일부 평면이 이미 끝나 있었다 — ${refused.join(', ')}`);
    }
  }

  async reconcileConfig(): Promise<ReconcileResult> {
    const expected = this.agent.lastActivated();
    if (expected === undefined) return { kind: 'no_baseline' };

    const seen = await this.effects.observePublished();
    if (seen.kind === 'owned' && sameRecord(seen.record, expected)) {
      return { kind: 'converged', record: expected };
    }

    // 되돌린다. **lease 는 없다** — 이건 오퍼레이션이 아니라 복구다. 무엇으로 되돌릴지는
    // durable 하게 기억된 것이고, 그게 여전히 정본이다.
    await this.effects.publish(expected, {
      leaderToken: expected.leaderToken,
      assertValid: () => undefined,
    });

    const after = await this.effects.observePublished();
    return after.kind === 'owned' && sameRecord(after.record, expected)
      ? { kind: 'repaired', expected, found: seen }
      : { kind: 'diverged', expected, found: after };
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
