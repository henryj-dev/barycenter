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
import type { ActivationEvidence, ApplyOperation, ApplyResult, Plane } from './operation.js';
import { planesOf } from './operation.js';
import { DpAgent, tupleFor } from './agent.js';
import { ApplyRunner, type Effects } from './apply.js';

/** 평면의 현재 좌표. */
export type PlaneStatus = {
  activationEpoch: string;
  membershipRevision: string;
  payloadDigest: string;
};

export type DriverStatus = {
  maxLeaderToken: string;
  planes: Record<Plane, PlaneStatus>;
  /** 지금 `current` 가 가리키는 세대. */
  publishedGeneration: string | undefined;
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
  status(): Promise<DriverStatus>;
}

// ── 참조 구현 ────────────────────────────────────────────────────────────

/**
 * 같은 프로세스 안의 DP Agent 에 붙는 구현.
 *
 * **인터페이스만 두고 구현을 미루지 않는다.** 구현하지 않은 계약을 먼저 고정했다가
 * 5차 검수에서 깨진 것이 멤버십이었다 (§9.1). 계약은 구현과 함께 선다.
 */
export class LocalDataplaneDriver implements DataplaneDriver {
  constructor(
    private readonly agent: DpAgent,
    private readonly effects: Effects,
  ) {}

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
    for (const plane of planesOf(op)) {
      await this.agent.abort(tupleFor(op, plane));
    }
  }

  async status(): Promise<DriverStatus> {
    const journal = this.agent.readJournal();
    return {
      maxLeaderToken: this.agent.maxLeaderToken(),
      planes: { http: this.agent.coordinate('http'), stream: this.agent.coordinate('stream') },
      publishedGeneration: await this.effects.observePublished(),
      lastEvidence: journal?.evidence,
    };
  }
}
