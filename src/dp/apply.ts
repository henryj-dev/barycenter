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
  type ApplyResult,
  type Plane,
  type PlaneProgress,
} from './operation.js';
import { DpRejection } from './agent.js';
import { tupleFor } from './agent.js';

export type Phase = ApplyPhase;

/** reload 재전송 상한. 넘으면 실패로 확정한다 (§6.2). */
export const RELOAD_ATTEMPT_LIMIT = 2;

/** DP Agent 가 소유하는 외부 부작용. **전부 관측 가능해야 한다.** */
export interface Effects {
  publish(generation: string): Promise<void>;
  /** 지금 `current` symlink 가 가리키는 세대. */
  observePublished(): Promise<string | undefined>;
  signalReload(): Promise<void>;
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

    // §3.5 · §9.1.1 blocker 1 — 리더 토큰과 좌표 CAS 가 게시보다 먼저다.
    // 두 평면 중 하나라도 막히면 **이미 잡은 예약을 반납하고** 아무것도 하지 않는다.
    const reserved: Plane[] = [];
    try {
      for (const plane of planesOf(op)) {
        await this.agent.reserve(tupleFor(op, plane));
        reserved.push(plane);
      }
    } catch (e) {
      // **종단으로 닫지 않는다.** 아직 아무 부작용도 내지 않았으므로 같은
      // operationId 로 다시 시도할 수 있어야 한다 (§6.2 — 없던 일이지 실패가 아니다).
      for (const plane of reserved) {
        await ignoreRejection(this.agent.release(tupleFor(op, plane)));
      }
      throw e;
    }

    await this.write({ op, phase: 'publish_intent', reloadAttempts: 0, progress: progressOf(op, 'reserved') });
    return this.drive();
  }

  /**
   * 재시작 후 이어받는다. 저널의 단계에서 시작하되, **애매한 지점은 관측으로 확정**한다.
   */
  async recover(): Promise<ApplyResult> {
    const j = this.agent.readJournal();
    // §6.2 #1 — 첫 저널 쓰기 전에 죽었으면 부작용도 없다. "실패" 가 아니라 "없던 일" 이다.
    if (j === undefined) return emptyResult();
    if (isTerminalPhase(j.phase)) return resultOf(j);
    return this.drive();
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

  private async drive(): Promise<ApplyResult> {
    // 절대 상한. 논리 오류가 프로세스를 매달면 안 된다.
    const HARD_LIMIT = 64;
    for (let guard = 0; ; guard += 1) {
      const j = this.agent.readJournal();
      if (j === undefined) return emptyResult();
      if (guard > HARD_LIMIT) {
        throw new Error(
          `apply 상태기계가 ${HARD_LIMIT} 회 안에 끝나지 않았다 (phase=${j.phase}). ` +
            `전이 규칙에 사이클이 있다.`,
        );
      }
      const gen = j.op.targetGeneration;

      switch (j.phase) {
        case 'publish_intent': {
          // 기록은 있는데 게시했는지 모른다 → 관측한다. 이미 됐으면 다시 하지 않는다.
          if ((await this.effects.observePublished()) !== gen) {
            await this.effects.publish(gen);
          }
          await this.write({ ...j, phase: 'published' });
          break;
        }
        case 'published': {
          // §6.5-1 — 슬롯은 **HUP 앞에** 올린다. 새 워커가 accept 를 시작한 뒤에 올리면
          // 그 사이 옛 상태로 peer 를 고른다. **두 평면 다** 올린 뒤에 신호를 보낸다.
          for (const plane of planesOf(j.op)) {
            await this.agent.stage(tupleFor(j.op, plane), gen);
          }
          await this.write({ ...j, phase: 'membership_staged', progress: progressOf(j.op, 'staged') });
          break;
        }
        case 'membership_staged': {
          await this.write({ ...j, phase: 'reload_intent' });
          break;
        }
        case 'reload_intent': {
          // 신호를 보냈는지 모른다 → **먼저 관측한다.** 이미 반영됐으면 재전송하지 않는다.
          const seen = await this.observe();
          if (provesActivation(seen, gen)) {
            await this.write({ ...j, phase: 'reload_observed', ...(seen ? { evidence: seen } : {}) });
            break;
          }
          if (j.reloadAttempts >= RELOAD_ATTEMPT_LIMIT) {
            // 상한을 넘었다. 무한 재전송은 워커 세대만 쌓는다 (§6.4 admission control).
            // **실패도 종단이다.** 전 평면의 슬롯을 반납한다.
            await this.failAll(j);
            break;
          }
          await this.write({ ...j, reloadAttempts: j.reloadAttempts + 1 });
          await this.effects.signalReload();
          const after = await this.awaitActivation(gen);
          if (after !== undefined) {
            await this.write({ ...this.agent.readJournal()!, evidence: after });
          }
          break;
        }
        case 'reload_observed': {
          // 다시 관측한다. 저널을 쓴 사이에 세대가 또 바뀌었을 수 있다.
          const evidence = await this.observe();
          if (!provesActivation(evidence, gen)) {
            await this.write({ ...j, phase: 'reload_intent' });
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
          await this.write({ ...j, phase, progress, evidence: evidence! });
          break;
        }
        case 'activated':
        case 'partially_activated':
        case 'failed':
        case 'no_operation':
          return resultOf(j);
      }
    }
  }

  /** 전 평면을 실패로 닫는다. 슬롯을 반납해야 좌표가 영구히 잠기지 않는다. */
  private async failAll(j: JournalEntry): Promise<void> {
    for (const plane of planesOf(j.op)) {
      await ignoreRejection(this.agent.fail(tupleFor(j.op, plane)));
    }
    await this.write({ ...j, phase: 'failed', progress: progressOf(j.op, 'failed') });
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
  for (const plane of ['http', 'stream'] as const) {
    const before = prev.planes[plane];
    const after = next.planes[plane];
    if (before.activationEpoch !== after.activationEpoch) return `commit:${plane}`;

    const prevSlots = prev.reservations[plane];
    const nextSlots = next.reservations[plane];
    for (const epoch of Object.keys(nextSlots)) {
      const p = prevSlots[epoch];
      const n = nextSlots[epoch]!;
      if (p === undefined) return `reserve:${plane}`;
      if (p.stagedDigest === undefined && n.stagedDigest !== undefined) return `stage:${plane}`;
    }
    for (const epoch of Object.keys(prevSlots)) {
      if (nextSlots[epoch] === undefined) {
        const how = Object.values(next.terminal).at(-1) ?? 'release';
        return `${how}:${plane}`;
      }
    }
  }

  // 토큰 상승은 `admit` 의 부수효과라 거의 모든 쓰기에 딸려 온다. **맨 뒤에서** 본다 —
  // 앞에 두면 첫 예약이 `fence` 로 잘못 분류된다.
  if (prev.journal?.phase !== next.journal?.phase) return `journal:${next.journal?.phase ?? 'none'}`;
  if (prev.maxLeaderToken !== next.maxLeaderToken) return 'fence';
  if (JSON.stringify(prev.journal) !== JSON.stringify(next.journal)) {
    return `journal:${next.journal?.phase ?? 'none'}:update`;
  }
  return 'noop';
}

/** durable 저장의 직전/직후에도 죽일 수 있게 감싼다. */
export class FaultStore implements DurableStore {
  constructor(
    private readonly inner: DurableStore,
    private readonly clock: CrashClock,
  ) {}
  load(): AgentState | undefined {
    return this.inner.load();
  }
  async save(state: AgentState): Promise<void> {
    const label = classifyWrite(this.inner.load(), state);
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

  async publish(generation: string): Promise<void> {
    if (this.crashBeforeEffect === 'publish') throw new CrashInjected('before publish');
    this.clock.tick('publish:before');
    this.publishCalls += 1;
    this.publishedGeneration = generation;
    if (this.crashAfterEffect === 'publish') throw new CrashInjected('after publish');
    this.clock.tick('publish:after');
  }

  async observePublished(): Promise<string | undefined> {
    return this.publishedGeneration;
  }

  async signalReload(): Promise<void> {
    if (this.crashBeforeEffect === 'reload') throw new CrashInjected('before reload');
    this.clock.tick('reload:before');
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
