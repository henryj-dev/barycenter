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
import type { AgentState, DpAgent, DurableStore, JournalEntry } from './agent.js';
import {
  isTerminalPhase,
  planesOf,
  provesActivation,
  type ActivationEvidence,
  type ApplyOperation,
  type ApplyPhase,
  type ApplyLease,
  type ApplyResult,
  type Plane,
  type PlaneProgress,
} from './operation.js';
import { DpRejection, tupleFor } from './agent.js';

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
  preflight(generation: string, expectedDigest: string): Promise<PreflightResult>;
  /**
   * 세대를 활성 포인터로 만든다.
   *
   * **되돌릴 수 없는 연산 직전에 `lease.assertValid()` 를 부르고, 그 사이에 `await` 를
   * 두지 마라** (8차 반례 ①). 준비(임시 파일 생성 등)는 그 앞에서 해도 된다.
   */
  publish(generation: string, lease: ApplyLease): Promise<void>;
  /** 지금 `current` symlink 가 가리키는 세대. */
  observePublished(): Promise<string | undefined>;
  /** HUP. `publish` 와 같은 규칙을 지킨다. */
  signalReload(lease: ApplyLease): Promise<void>;
  /**
   * 활성화 증거 (§6.3). 세대 리터럴만이 아니라 관측할 수 있는 것을 **전부** 싣는다.
   *
   * 이게 `observeAccepting(): string` 이던 시절에는 config test 실패도 error log 증가도
   * 표현할 방법이 없었다. S7 은 세대만 보면 못 잡는 실패가 있다는 것을 실증했다.
   */
  observeActivation(): Promise<ActivationEvidence | undefined>;
}

export class CrashInjected extends Error {
  constructor(readonly at: string) {
    super(`크래시 주입: ${at}`);
    this.name = 'CrashInjected';
  }
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
};

const DEFAULT_POLL: PollPolicy = {
  attempts: 25,
  intervalMs: 100,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export class ApplyRunner {
  private readonly poll: PollPolicy;
  private history: Phase[] = [];
  /** 마지막 실패 사유. 결과에 실어 운영자가 원인을 알 수 있게 한다. */
  private lastFailure: string | undefined;

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
    await this.agent.reserveAll(op);

    // 저널은 하나뿐이라 **앞선 오퍼레이션의 종단 기록이 남아 있다.** 그걸 그대로 두고
    // drive 하면 남의 저널을 읽고 `operation_in_flight` 로 스스로 막힌다.
    //   · 같은 오퍼레이션의 기록이면 이어받는다 (동시 호출·복구).
    //   · 아니면 내 것으로 연다. seq 는 이어서 올린다.
    const existing = this.agent.readJournal();
    const mine = existing !== undefined
      && existing.op.operationId === op.operationId
      && existing.op.transitionId === op.transitionId;
    if (!mine) {
      await ignoreConflict(
        this.write({
          op,
          phase: 'preflight',
          reloadAttempts: 0,
          seq: (existing?.seq ?? 0) + 1,
          progress: progressOf(op, 'reserved'),
        }),
      );
    }
    return this.drive(op);
  }

  /**
   * 재시작 후 이어받는다. 저널의 단계에서 시작하되, **애매한 지점은 관측으로 확정**한다.
   */
  async recover(): Promise<ApplyResult> {
    const j = this.agent.readJournal();
    // §6.2 #1 — 첫 저널 쓰기 전에 죽었으면 부작용도 없다. "실패" 가 아니라 "없던 일" 이다.
    if (j === undefined) return emptyResult();
    if (isTerminalPhase(j.phase)) {
      // 종단 기록 뒤 반납 전에 죽었을 수 있다. 여기서 마저 놓는다 (멱등).
      await this.agent.finishOperation(
        j.op,
        planesOf(j.op).filter((p) => j.progress?.[p] !== 'committed'),
      );
      return resultOf(j);
    }
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
    try {
      return await this.effects.observeActivation();
    } catch {
      return undefined;
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
   * 이건 `Effects` 계약의 문제다. 부작용에 토큰/lease 를 싣고 대상에서 원자적으로
   * 검증하거나, 외부 효과를 하나의 supervisor 로 직렬화해야 한다. 지금 표면을 그대로
   * 동결하면 이 결함이 계약이 된다.
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
    // 절대 상한. 논리 오류가 프로세스를 매달면 안 된다.
    const HARD_LIMIT = 64;
    for (let guard = 0; ; guard += 1) {
      const j = this.agent.readJournal();
      if (j === undefined) return emptyResult();
      // **내가 맡은 오퍼레이션인가.** 저널이 남의 것으로 바뀌었으면 여기서 손을 뗀다.
      if (j.op.operationId !== bound.operationId || j.op.transitionId !== bound.transitionId) {
        return emptyResult();
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
          const check = await this.effects.preflight(gen, j.op.generationDigest);
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
          const published = await this.effects.observePublished();
          if (published !== gen) {
            // lease 를 건넨다. **최종 검사는 부작용 구현 안에서** 되돌릴 수 없는 연산
            // 직전에 일어난다 (8차 반례 ①) — 러너가 여기서 아무리 확인해도 그 뒤의
            // `await` 안에서 리더가 바뀌면 소용없다.
            await this.effects.publish(gen, this.agent.lease(j.op));
          }
          await ignoreConflict(this.write(next(j, { phase: 'published' })));
          break;
        }
        case 'published': {
          // §6.5-1 — 슬롯은 **HUP 앞에** 올린다. 새 워커가 accept 를 시작한 뒤에 올리면
          // 그 사이 옛 상태로 peer 를 고른다. **두 평면 다** 올린 뒤에 신호를 보낸다.
          for (const plane of planesOf(j.op)) {
            await this.agent.stage(tupleFor(j.op, plane), gen);
          }
          await ignoreConflict(this.write(next(j, { phase: 'membership_staged', progress: progressOf(j.op, 'staged') })));
          break;
        }
        case 'membership_staged': {
          await ignoreConflict(this.write(next(j, { phase: 'reload_intent' })));
          break;
        }
        case 'reload_intent': {
          // 신호를 보냈는지 모른다 → **먼저 관측한다.** 이미 반영됐으면 재전송하지 않는다.
          const seen = await this.observe();
          if (provesActivation(seen, gen)) {
            await ignoreConflict(
              this.write(next(j, { phase: 'reload_observed', ...(seen ? { evidence: seen } : {}) })),
            );
            break;
          }
          if (j.reloadAttempts >= RELOAD_ATTEMPT_LIMIT) {
            // 상한을 넘었다. 무한 재전송은 워커 세대만 쌓는다 (§6.4 admission control).
            // **실패도 종단이다.** 전 평면의 슬롯을 반납한다.
            await this.failAll(j);
            break;
          }
          // **이 쓰기를 이긴 러너만 HUP 을 보낸다** (6차 반례 ③). 진 쪽은 다시 읽는다.
          try {
            await this.write(next(j, { reloadAttempts: j.reloadAttempts + 1 }));
          } catch (e) {
            if (e instanceof DpRejection && e.kind === 'journal_conflict') break;
            throw e;
          }
          await this.effects.signalReload(this.agent.lease(j.op));
          const after = await this.awaitActivation(gen);
          if (after !== undefined) {
            // **내 저널에만 쓴다** (8차 반례 ③). 전에는 `readJournal()` 이 돌려주는
            // 것에 썼는데, 그 사이 승계가 일어나면 그건 **남의 오퍼레이션**이다.
            const now = this.agent.readJournal();
            const mine = now !== undefined
              && now.op.operationId === j.op.operationId
              && now.op.transitionId === j.op.transitionId;
            if (mine && now !== undefined) {
              await ignoreConflict(this.write(next(now, { evidence: after })));
            }
          }
          break;
        }
        case 'reload_observed': {
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
            await this.agent.finishOperation(j.op, stuck);
          }
          break;
        }
        case 'partially_activated': {
          // §6.2 #8 — partial 은 "재시도" 다. 다만 유한해야 한다.
          if (j.reloadAttempts >= RELOAD_ATTEMPT_LIMIT + PARTIAL_RETRY_LIMIT) {
            // 더는 못 민다. **소유권과 남은 예약을 반납하고** 끝낸다 — 안 그러면 그
            // 좌표가 영구히 잠긴다 (6차 반례 ④).
            await this.agent.finishOperation(
              j.op,
              planesOf(j.op).filter((p) => j.progress?.[p] !== 'committed'),
            );
            return resultOf(j);
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
        case 'failed':
        case 'no_operation':
          return resultOf(j);
      }
    }
  }

  /** 전 평면을 실패로 닫는다. 슬롯을 반납해야 좌표가 영구히 잠기지 않는다. */
  private async failAll(j: JournalEntry, reason?: string): Promise<void> {
    if (reason !== undefined) this.lastFailure = reason;
    for (const plane of planesOf(j.op)) {
      await ignoreRejection(this.agent.fail(tupleFor(j.op, plane)));
    }
    await ignoreConflict(this.write(next(j, { phase: 'failed', progress: progressOf(j.op, 'failed') })));
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
    partialTransition: j.phase === 'partially_activated',
    ...(j.evidence ? { evidence: j.evidence } : {}),
  };
}

// ── 테스트용 크래시 주입 ────────────────────────────────────────────────

/**
 * 크래시 지점 카운터.
 *
 * **저장과 부작용을 같은 시계로 센다.** 부작용만 세면 "저널을 쓰다 죽은" 경우가 통째로
 * 빠진다 — §6.2 표가 7행에서 11행으로 늘어난 이유가 그것이다. 지점을 손으로 고르면
 * 반드시 빠뜨린다.
 */
export class CrashClock {
  steps = 0;
  crashAt: number | undefined;
  /** 지나온 지점의 **이름**. 개수가 아니라 집합으로 판정하기 위한 것이다. */
  readonly seen: string[] = [];

  tick(label: string): void {
    const at = this.steps;
    this.steps += 1;
    this.seen.push(label);
    if (this.crashAt === at) throw new CrashInjected(`${label}#${at}`);
  }
}

/**
 * durable 쓰기가 **무엇을 바꾸는 쓰기였는지** 이름을 붙인다.
 *
 * 5차 검수 지적: 크래시 지점을 개수(`>= 9`)로만 세면 §6.2 표의 어느 행을 덮었는지
 * 말할 수 없다. 정상 경로 22 지점 중 18 개가 구분 없는 `save` 였으므로, publish·reload
 * 지점을 통째로 빼도 개수 검사는 통과했다.
 *
 * 쓰기 주체에게 라벨을 들려 보내는 대신 **상태의 차이로 분류한다.** 그러면 프로덕션
 * 코드에 테스트용 인자가 새지 않고, 분류가 실제로 일어난 변화를 따라간다.
 */
export function classifyWrite(before: AgentState | undefined, next: AgentState): string {
  // 첫 쓰기도 이름을 가져야 한다. `undefined` 를 특별 취급하면 최초 예약이 이름을 잃는다.
  const prev: AgentState = before ?? {
    version: 0,
    maxLeaderToken: '0',
    planes: {
      http: { activationEpoch: '0', membershipRevision: '0', payloadDigest: '' },
      stream: { activationEpoch: '0', membershipRevision: '0', payloadDigest: '' },
    },
    reservations: { http: {}, stream: {} },
    completed: {},
    terminal: {},
    activationEvidence: {},
  };
  // **한 쓰기가 여러 평면을 바꿀 수 있다** — `reserveAll` 이 그렇다. 처음 찾은 것 하나만
  // 돌려주면 나머지 평면이 계측에서 통째로 사라진다. 일어난 변화를 전부 모은다.
  const changes: string[] = [];
  for (const plane of ['http', 'stream'] as const) {
    const moved = prev.planes[plane].activationEpoch !== next.planes[plane].activationEpoch;
    if (moved) changes.push(`commit:${plane}`);

    const prevSlots = prev.reservations[plane];
    const nextSlots = next.reservations[plane];
    for (const epoch of Object.keys(nextSlots)) {
      const p = prevSlots[epoch];
      const n = nextSlots[epoch]!;
      if (p === undefined) changes.push(`reserve:${plane}`);
      else if (p.stagedDigest === undefined && n.stagedDigest !== undefined) changes.push(`stage:${plane}`);
    }
    for (const epoch of Object.keys(prevSlots)) {
      // commit 도 슬롯을 지운다. 그건 위에서 이미 `commit:` 으로 셌으므로 빼야
      // 한 쓰기가 두 이름을 갖지 않는다.
      if (nextSlots[epoch] === undefined && !moved) {
        const how = Object.values(next.terminal).at(-1) ?? 'release';
        changes.push(`${how}:${plane}`);
      }
    }
  }
  if (changes.length > 0) return [...new Set(changes)].join('+');

  // 토큰 상승은 `admit` 의 부수효과라 거의 모든 쓰기에 딸려 온다. **맨 뒤에서** 본다 —
  // 앞에 두면 첫 예약이 `fence` 로 잘못 분류된다.
  if (prev.journal?.phase !== next.journal?.phase) return `journal:${next.journal?.phase ?? 'none'}`;
  if (prev.maxLeaderToken !== next.maxLeaderToken) return 'fence';
  if (JSON.stringify(prev.journal) !== JSON.stringify(next.journal)) {
    return `journal:${next.journal?.phase ?? 'none'}:update`;
  }
  // apply 경로를 놓는 쓰기 (6차 반례 ④). 이것도 이름이 있어야 계측에서 안 사라진다.
  if (prev.activeOperation !== undefined && next.activeOperation === undefined) return 'finish';
  if (prev.activeOperation === undefined && next.activeOperation !== undefined) return 'claim';
  return 'noop';
}

/** durable 저장의 직전/직후에도 죽일 수 있게 감싼다. */
export class FaultStore implements DurableStore {
  constructor(
    private readonly inner: DurableStore,
    private readonly clock: CrashClock,
  ) {}
  load(): AgentState | undefined {
    return this.inner.load() as AgentState | undefined;
  }
  async save(state: AgentState): Promise<void> {
    const label = classifyWrite(this.inner.load() as AgentState | undefined, state);
    this.clock.tick(`${label}:before`);
    await this.inner.save(state);
    this.clock.tick(`${label}:after`);
  }
}

/** 관측 가능한 가짜 부작용. 시계를 공유해 크래시 지점을 함께 센다. */
export class FakeEffects implements Effects {
  publishedGeneration: string | undefined;
  acceptingGeneration: string | undefined;
  publishCalls = 0;
  reloadSignals = 0;
  /** false 면 reload 를 보내도 새 세대가 활성화되지 않는다 (포트 점유 등). */
  reloadTakesEffect = true;
  /** §6.3 증거로 실어 보낼 값들. undefined 면 "관측하지 못했다" 다. */
  configTestPassed: boolean | undefined;
  errorLogGrowth: number | undefined;
  crashBeforeEffect: 'publish' | 'reload' | undefined;
  crashAfterEffect: 'publish' | 'reload' | undefined;

  constructor(readonly clock: CrashClock = new CrashClock()) {}

  /** 기본은 통과. 개별 테스트가 막고 싶을 때 바꾼다. */
  preflightOk = true;
  preflightCalls = 0;

  async preflight(_generation: string, _expectedDigest: string): Promise<PreflightResult> {
    this.preflightCalls += 1;
    return this.preflightOk
      ? { ok: true, configTestPassed: true }
      : { ok: false, reason: '주입된 preflight 실패' };
  }

  async publish(generation: string, lease?: ApplyLease): Promise<void> {
    if (this.crashBeforeEffect === 'publish') throw new CrashInjected('before publish');
    this.clock.tick('publish:before');
    // **되돌릴 수 없는 지점 직전.** 여기와 아래 대입 사이에 await 가 없다.
    lease?.assertValid();
    this.publishCalls += 1;
    this.publishedGeneration = generation;
    if (this.crashAfterEffect === 'publish') throw new CrashInjected('after publish');
    this.clock.tick('publish:after');
  }

  async observePublished(): Promise<string | undefined> {
    return this.publishedGeneration;
  }

  async signalReload(lease?: ApplyLease): Promise<void> {
    if (this.crashBeforeEffect === 'reload') throw new CrashInjected('before reload');
    this.clock.tick('reload:before');
    lease?.assertValid();
    this.reloadSignals += 1;
    if (this.reloadTakesEffect) this.acceptingGeneration = this.publishedGeneration;
    if (this.crashAfterEffect === 'reload') throw new CrashInjected('after reload');
    this.clock.tick('reload:after');
  }

  async observeActivation(): Promise<ActivationEvidence | undefined> {
    if (this.acceptingGeneration === undefined) return undefined;
    return {
      acceptingGeneration: this.acceptingGeneration,
      ...(this.configTestPassed === undefined ? {} : { configTestPassed: this.configTestPassed }),
      ...(this.errorLogGrowth === undefined ? {} : { errorLogGrowth: this.errorLogGrowth }),
    };
  }
}
