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
import type { DurableStore, AgentState } from './agent.js';

export type Phase =
  | 'publish_intent'
  | 'published'
  | 'reload_intent'
  | 'reload_observed'
  | 'activated'
  | 'failed'
  /** 저널이 비어 있다 — 이 오퍼레이션은 시작조차 못 했다. 복구할 것이 없다 (§6.2 #1). */
  | 'no_operation';

/** reload 재전송 상한. 넘으면 실패로 확정한다 (§6.2). */
export const RELOAD_ATTEMPT_LIMIT = 2;

export type JournalEntry = {
  operationId: string;
  targetGeneration: string;
  phase: Phase;
  reloadAttempts: number;
};

/** DP Agent 가 소유하는 외부 부작용. **전부 관측 가능해야 한다.** */
export interface Effects {
  publish(generation: string): Promise<void>;
  /** 지금 `current` symlink 가 가리키는 세대. */
  observePublished(): Promise<string | undefined>;
  signalReload(): Promise<void>;
  /** 지금 새 연결을 받는 세대 (§6.3 워커 레지스트리). */
  observeAccepting(): Promise<string | undefined>;
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
  private journal: JournalEntry | undefined;
  private readonly poll: PollPolicy;

  constructor(
    private readonly store: DurableStore,
    private readonly effects: Effects,
    poll: Partial<PollPolicy> = {},
  ) {
    this.journal = readJournal(this.store.load());
    this.poll = { ...DEFAULT_POLL, ...poll };
  }

  /** 신호 직후 반영을 기다린다. 예산 안에 안 바뀌면 그냥 돌아가 상위가 판정한다. */
  private async awaitAccepting(target: string): Promise<void> {
    for (let i = 0; i < this.poll.attempts; i += 1) {
      if ((await this.effects.observeAccepting()) === target) return;
      await this.poll.sleep(this.poll.intervalMs);
    }
  }

  phases(): Phase[] {
    return this.history;
  }
  private history: Phase[] = [];

  async run(op: { operationId: string; targetGeneration: string }): Promise<Phase> {
    await this.write({ ...op, phase: 'publish_intent', reloadAttempts: 0 });
    return this.drive();
  }

  /**
   * 재시작 후 이어받는다. 저널의 단계에서 시작하되, **애매한 지점은 관측으로 확정**한다.
   */
  async recover(): Promise<Phase> {
    const j = this.journal;
    // §6.2 #1 — 첫 저널 쓰기 전에 죽었으면 부작용도 없다. "실패" 가 아니라 "없던 일" 이다.
    // 컨트롤 플레인이 같은 plan 으로 다시 시도하면 된다.
    if (j === undefined) return 'no_operation';
    if (j.phase === 'activated' || j.phase === 'failed') return j.phase;
    return this.drive();
  }

  private async drive(): Promise<Phase> {
    // 절대 상한. 논리 오류가 프로세스를 매달면 안 된다 — 상태기계가 진행하지 못하면
    // **매달리는 대신 실패**해야 관측되고 알림이 나간다.
    // 단계 수 × reload 상한보다 넉넉하되 유한하다.
    const HARD_LIMIT = 64;
    for (let guard = 0; ; guard += 1) {
      if (guard > HARD_LIMIT) {
        throw new Error(
          `apply 상태기계가 ${HARD_LIMIT} 회 안에 끝나지 않았다 (phase=${this.journal?.phase}). ` +
            `전이 규칙에 사이클이 있다.`,
        );
      }
      const j = this.journal!;
      switch (j.phase) {
        case 'publish_intent': {
          // 기록은 있는데 게시했는지 모른다 → 관측한다. 이미 됐으면 다시 하지 않는다.
          if ((await this.effects.observePublished()) !== j.targetGeneration) {
            await this.effects.publish(j.targetGeneration);
          }
          await this.write({ ...j, phase: 'published' });
          break;
        }
        case 'published': {
          await this.write({ ...j, phase: 'reload_intent' });
          break;
        }
        case 'reload_intent': {
          // 신호를 보냈는지 모른다 → **먼저 관측한다.** 이미 반영됐으면 재전송하지 않는다.
          if ((await this.effects.observeAccepting()) === j.targetGeneration) {
            await this.write({ ...j, phase: 'reload_observed' });
            break;
          }
          if (j.reloadAttempts >= RELOAD_ATTEMPT_LIMIT) {
            // 상한을 넘었다. 무한 재전송은 워커 세대만 쌓는다 (§6.4 admission control).
            await this.write({ ...j, phase: 'failed' });
            break;
          }
          await this.write({ ...j, reloadAttempts: j.reloadAttempts + 1 });
          await this.effects.signalReload();
          // 신호가 반영될 시간을 준다. 이걸 빼면 멀쩡한 reload 를 실패로 몰고
          // 재전송만 늘린다 (실제 nginx 에 붙여 보고서야 드러났다).
          await this.awaitAccepting(j.targetGeneration);
          break;
        }
        case 'reload_observed': {
          const accepting = await this.effects.observeAccepting();
          await this.write({
            ...j,
            phase: accepting === j.targetGeneration ? 'activated' : 'reload_intent',
          });
          break;
        }
        case 'activated':
        case 'failed':
          return j.phase;
      }
    }
  }

  /** 저널 쓰기는 durable 하다. 여기가 §6.2 표의 "intent fsync" 지점이다. */
  private async write(entry: JournalEntry): Promise<void> {
    const state = this.store.load() ?? emptyState();
    await this.store.save({ ...state, journal: entry } as AgentState & { journal: JournalEntry });
    this.journal = entry;
    if (this.history[this.history.length - 1] !== entry.phase) this.history.push(entry.phase);
  }
}

function readJournal(state: AgentState | undefined): JournalEntry | undefined {
  return (state as (AgentState & { journal?: JournalEntry }) | undefined)?.journal;
}

const emptyState = (): AgentState => ({
  maxLeaderToken: '0',
  planes: {
    http: { activationEpoch: '0', membershipRevision: '0', payloadDigest: '' },
    stream: { activationEpoch: '0', membershipRevision: '0', payloadDigest: '' },
  },
  staged: { http: {}, stream: {} },
  completed: {},
  aborted: {},
});

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

  tick(label: string): void {
    const at = this.steps;
    this.steps += 1;
    if (this.crashAt === at) throw new CrashInjected(`${label}#${at}`);
  }
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
    this.clock.tick('save:before');
    await this.inner.save(state);
    this.clock.tick('save:after');
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

  async observeAccepting(): Promise<string | undefined> {
    return this.acceptingGeneration;
  }
}
