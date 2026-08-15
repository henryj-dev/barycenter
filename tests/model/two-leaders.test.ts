/**
 * bounded model — 두 리더가 같은 store 를 흔든다 (14차 검수)
 *
 * 검수가 준 모델을 그대로 쓴다. 작게 잡는 것이 요점이다 — 크게 잡으면 안 끝나고,
 * 안 끝나면 아무것도 못 배운다.
 *
 *   리더 토큰 2 · 세대 2 · 평면 2 · 같은 store 를 보는 인스턴스 2
 *   연산: apply · recover · abort · reconcile · fence
 *   yield: store save 전후 · 모든 Effects 호출 전후
 *
 * 손으로 짠 반례와 다른 점은 하나다. **교차를 내가 고르지 않는다.** 스케줄러가 훑는다.
 * 열네 라운드 동안 "내가 상상한 교차" 만 검사해 왔고, 13차 ①④ 를 재현 못 한 것도
 * 그래서였다.
 *
 * 속성이 깨지면 그 선택열을 그대로 찍는다 — 결정적이라 재현된다.
 *
 * ── 이 모델이 **못 보는 것** ────────────────────────────────────────────────
 *
 * 스케줄 공간을 다 훑지 못한다. DFS 150 + 무작위 350 이고, 큰 시나리오는 매번
 * "상한에서 끊었다" 가 찍힌다.
 *
 * **그래서 시나리오를 추가한다고 그 축이 덮이는 것이 아니다.** 15차 수정 둘
 * (`pendingEpochs` · reconcile lease 의 토큰 검사)을 겨냥해 시나리오를 넣었는데,
 * 뮤테이션을 돌려 보니 **여전히 안 잡힌다** — 그 교차가 500 개 표본에 안 들어온다.
 * 둘 다 conformance 가 잡는다(`review14-finalizer` · `review13-reconcile`).
 *
 * 시나리오가 그 자리를 **지나게** 만드는 것과 그 자리를 **때리는** 것은 다르다.
 * 지나게는 만들었고 때리지는 못했다. 적어 둔다 — 안 적으면 "모델이 본다" 고 넓게 읽는다.
 *
 * 스케줄 공간도 다 훑지 못한다. DFS 150 + 무작위 350 이고, 매번 "상한에서 끊었다" 가
 * 찍힌다. 초록이 "안전하다" 가 아니라 "**여기까지는 못 깼다**" 라는 뜻이다.
 */
import { describe, expect, it } from 'vitest';
import {
  DpAgent,
  DpRejection,
  tupleFor,
  type DurableStore,
  type StoredState,
} from '../../src/dp/agent.js';
import { ApplyRunner, type Effects, type PreflightResult } from '../../src/dp/apply.js';
import { LocalDataplaneDriver } from '../../src/dp/driver.js';
import type {
  ActivationEvidence,
  ApplyLease,
  Checked,
  ApplyOperation,
  PublishedState,
  PublishRecord,
} from '../../src/dp/operation.js';
import { Scheduler, ScheduleSpace, explore, probe, probeBounded } from './scheduler.js';

// ── 모델의 세계 ─────────────────────────────────────────────────────────

type Plane = 'http' | 'stream';
const PLANES: readonly Plane[] = ['http', 'stream'];

const OP = (id: string, generation: string, leaderToken: string, from: string, to: string): ApplyOperation => ({
  leaderToken,
  operationId: id,
  transitionId: id,
  affectedPlanes: ['http', 'stream'],
  targetGeneration: generation,
  generationDigest: `sha256:${generation}`,
  planes: {
    http: {
      expectedCurrent: { activationEpoch: from, membershipRevision: from },
      target: { activationEpoch: to, membershipRevision: to },
      payloadDigest: `sha256:h-${generation}`,
    },
    stream: {
      expectedCurrent: { activationEpoch: from, membershipRevision: from },
      target: { activationEpoch: to, membershipRevision: to },
      payloadDigest: `sha256:s-${generation}`,
    },
  },
});

/** 우리가 보는 상태의 모양. `payload` 는 store 에게 불투명하지만 모델은 안다. */
type Seen = {
  maxLeaderToken: string;
  planes: Record<Plane, { activationEpoch: string }>;
  activeOperation?: { operationId: string; transitionId: string; leaderToken: string };
  journal?: { phase: string; op: { operationId: string; transitionId: string; leaderToken: string } };
  lastActivated?: PublishRecord;
  pendingActivation?: PublishRecord;
  lastPublishIntent?: PublishRecord;
};

const TERMINAL = new Set([
  'activated', 'partial_exhausted', 'failed', 'superseded', 'no_operation',
]);

/** 저장될 때마다 상태를 남긴다. 속성은 **역사**를 보고 판정한다. */
class ModelStore implements DurableStore {
  private current: StoredState | undefined;
  readonly history: Seen[] = [];

  constructor(private readonly sched: Scheduler, private readonly who: string) {}

  load(): StoredState | undefined {
    return this.current;
  }

  async save(state: StoredState): Promise<void> {
    await this.sched.yield(`${this.who}:save:before`);
    const live = this.current?.version ?? 0;
    if (state.version !== live + 1) {
      // CAS. 여기서 밀리는 것이 정상이다 — 러너가 다시 읽고 다시 판정한다.
      const { StoreConflict } = await import('../../src/dp/agent.js');
      throw new StoreConflict(`버전이 밀렸다 (${state.version} ≠ ${live + 1})`);
    }
    this.current = state;
    this.history.push(structuredClone(state.payload) as Seen);
    await this.sched.yield(`${this.who}:save:after`);
  }
}

/** 바깥 세상. 심볼릭 링크 하나와 nginx 하나가 있다고 친다. */
class World {
  published: PublishRecord | undefined;
  accepting: string | undefined;
  publishes = 0;
  reloads = 0;
}

class ModelEffects implements Effects {
  constructor(
    private readonly sched: Scheduler,
    private readonly world: World,
    private readonly who: string,
  ) {}

  private async at<T>(label: string, run: () => T): Promise<T> {
    await this.sched.yield(`${this.who}:${label}:before`);
    const out = run();
    await this.sched.yield(`${this.who}:${label}:after`);
    return out;
  }

  preflight(op: ApplyOperation): Promise<PreflightResult> {
    return this.at('preflight', () => ({ ok: true, configTestPassed: true }));
  }

  publish(record: PublishRecord, lease: ApplyLease): Promise<Checked> {
    return this.at('publish', () => {
      // **되돌릴 수 없는 연산 직전에 확인한다.** 동기라 확인과 부작용 사이가 없다.
      const checked = lease.assertValid();
      this.world.published = record;
      this.world.publishes += 1;
      return checked;
    });
  }

  observePublished(): Promise<PublishedState> {
    return this.at('observePublished', () =>
      this.world.published === undefined
        ? { kind: 'none' as const }
        : { kind: 'owned' as const, record: this.world.published });
  }

  signalReload(lease: ApplyLease): Promise<Checked> {
    return this.at('signalReload', () => {
      const checked = lease.assertValid();
      this.world.reloads += 1;
      this.world.accepting = this.world.published?.generation;
      return checked;
    });
  }

  observeActivation(): Promise<ActivationEvidence | undefined> {
    return this.at('observeActivation', () => ({ acceptingGeneration: this.world.accepting }));
  }
}

/**
 * 거부는 이 모델에서 **정상적인 결과**다 — 낡은 리더가 막히는 것이 우리가 원하는 것이다.
 *
 * 그 밖의 오류는 다르다. **특히 `InvariantViolation` 은 상태가 깨졌다는 뜻**이라 반드시
 * 드러나야 한다. 처음엔 이걸 `throw` 로 넘겼는데 `Promise.allSettled` 가 통째로 삼켜서,
 * 일부러 버그를 넣어도 모델이 초록이었다 — **하네스가 거짓말을 하고 있었다.**
 */
const swallow = (problems: Error[]) => async (p: Promise<unknown>): Promise<void> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof DpRejection) return;
    const name = (e as Error).name;
    if (name === 'StoreConflict' || name === 'EffectTimeout') return;
    problems.push(e as Error);
  }
};

// ── 속성 ────────────────────────────────────────────────────────────────

type Violation = { property: string; detail: string };

/**
 * `seed` 는 스케줄이 시작되기 **직전**의 상태다.
 *
 * 없으면 역사의 첫 항목이 전부 "새로 쓰였다" 로 보인다 — 준비 단계에서 넘어온 기록까지
 * P1 위반으로 잡혔다. **경계에서 나는 오탐이고, 하네스 버그다.** 모델을 넓히자마자
 * 나왔으니 시나리오를 늘릴 때마다 이런 것을 의심해야 한다.
 */
function checkProperties(
  history: readonly Seen[],
  world: World,
  problems: readonly Error[],
  stuck?: string,
  seed?: Seen,
): Violation[] {
  const bad: Violation[] = [];
  for (const p of problems) {
    bad.push({ property: `P0 예상 못 한 오류 (${p.name})`, detail: p.message });
  }
  const idOf = (r: PublishRecord | undefined): string =>
    r === undefined ? '∅' : `${r.generation}/${r.operationId}/${r.leaderToken}`;

  let promotions = 0;
  for (let i = 0; i < history.length; i += 1) {
    const s = history[i]!;
    const prev = i === 0 ? seed : history[i - 1]!;
    const max = BigInt(s.maxLeaderToken);

    // P1 — 낡은 행위자는 intent·후보·기준을 바꾸지 못한다.
    for (const [what, rec] of [
      ['lastPublishIntent', s.lastPublishIntent],
      ['pendingActivation', s.pendingActivation],
      ['lastActivated', s.lastActivated],
    ] as const) {
      if (rec === undefined) continue;
      const before = prev?.[what];
      const isNew = before === undefined || idOf(before) !== idOf(rec);
      if (isNew && BigInt(rec.leaderToken) < max) {
        bad.push({
          property: 'P1 낡은 행위자는 쓰지 못한다',
          detail: `${what} 이 토큰 ${rec.leaderToken} 으로 새로 쓰였다 (최신 ${s.maxLeaderToken})`,
        });
      }
    }

    // P3 — 완전한 후보만, 정확히 한 번 승격된다.
    const moved = idOf(prev?.lastActivated) !== idOf(s.lastActivated);
    if (moved && s.lastActivated !== undefined) {
      promotions += 1;
      const arrived = PLANES.every((p) => s.planes[p].activationEpoch !== '0');
      if (!arrived) {
        bad.push({
          property: 'P3 부분 후보는 승격되지 않는다',
          detail: `${idOf(s.lastActivated)} 이 승격됐는데 좌표는 `
            + `http=${s.planes.http.activationEpoch} stream=${s.planes.stream.activationEpoch}`,
        });
      }
    }

  }

  // P5 는 **시점 불변식이 아니다.**
  //
  // 검수는 "비종단 저널에는 동일 신원의 holder 가 있다" 를 줬다. 넣어 보니 깨진다 —
  // 같은 오퍼레이션을 미는 러너가 둘이면 하나가 저널을 쓴 뒤 다른 하나가 종단에 닿아
  // 실행권을 놓는다. 13차의 "terminal 이면 holder 0" 이 거짓이었던 것과 **같은 병**이다:
  // 저널과 실행권은 서로 다른 임계 구간에서 움직인다.
  //
  // 우리가 실제로 원하는 것은 그 상태가 **막히지 않는 것**이다. 그건 회복 가능성이고,
  // `once()` 가 스케줄 뒤에 복구를 한 번 돌려 확인한다 (아래 `stuck`).
  const last = history[history.length - 1];
  if (last !== undefined) {
    // P4 — 종단으로 끝났으면 실행권이 남지 않는다.
    if (last.journal !== undefined && TERMINAL.has(last.journal.phase)
      && last.activeOperation !== undefined) {
      bad.push({
        property: 'P4 종단 뒤 실행권은 없다',
        detail: `저널 ${last.journal.phase} 인데 ${last.activeOperation.operationId} 이 쥐고 있다`,
      });
    }
    // P2 — 기준이 섰으면 그것이 바깥에 올라가 있어야 한다.
    if (last.lastActivated !== undefined && world.published !== undefined) {
      const same = world.published.generation === last.lastActivated.generation;
      if (!same && world.accepting === last.lastActivated.generation) {
        bad.push({
          property: 'P2 기준과 바깥이 같은 말을 한다',
          detail: `기준은 ${last.lastActivated.generation} 인데 게시물은 ${world.published.generation}`,
        });
      }
    }
  }
  if (stuck !== undefined) {
    bad.push({
      property: 'P5 남은 저널은 복구가 이어받는다',
      detail: `스케줄이 끝난 뒤 복구가 ${stuck} 로 막혔다 — 그 전환은 영영 못 끝난다`,
    });
  }
  return bad;
}

/**
 * DFS 로 앞쪽을 촘촘히 훑고, 무작위로 넓게 뿌린다. 둘 다 결정적이다.
 *
 * 하나만으로는 부족하다는 것을 뮤테이션으로 확인했다 — DFS 400 회가 finalizer 버그 둘을
 * 못 잡았고, 무작위가 잡았다.
 */
async function sweep(
  body: (space: ScheduleSpace) => Promise<void>,
): Promise<{ schedules: number; exhausted: boolean }> {
  const dfs = await explore(150, body);
  const random = await probe(0x5EED, 250, body);
  // 문맥 전환을 둘·셋으로 묶어 촘촘히 본다. 같은 예산으로 훨씬 깊이 들어간다.
  const bounded2 = await probeBounded(0xB0, 250, 2, body);
  const bounded3 = await probeBounded(0xB1, 250, 3, body);
  return {
    schedules: dfs.schedules + random.schedules + bounded2.schedules + bounded3.schedules,
    exhausted: dfs.exhausted,
  };
}

// ── 실행 ────────────────────────────────────────────────────────────────

const FAST = { attempts: 2, intervalMs: 0, sleep: async () => {}, effectTimeoutMs: 10_000 };

/** 한 스케줄을 돌리고 위반을 돌려준다. */
type Ctx = {
  sched: Scheduler;
  store: ModelStore;
  world: World;
  effects: (who: string) => ModelEffects;
  /** 거부가 아닌 오류가 여기 쌓인다. 하나라도 있으면 속성 위반이다. */
  problems: Error[];
  swallow: (p: Promise<unknown>) => Promise<void>;
};

async function once(
  space: ScheduleSpace,
  scenario: (ctx: Ctx) => (() => Promise<unknown>)[],
  setup?: (ctx: Ctx) => Promise<void>,
): Promise<{ violations: Violation[]; trace: string[]; choices: number[] }> {
  const sched = new Scheduler(space);
  const store = new ModelStore(sched, 'store');
  const world = new World();
  const problems: Error[] = [];
  const ctx: Ctx = {
    sched,
    store,
    world,
    effects: (who) => new ModelEffects(sched, world, who),
    problems,
    swallow: swallow(problems),
  };
  // 준비는 스케줄 밖에서 한다 — 관심 없는 교차를 훑지 않기 위해서다.
  if (setup !== undefined) await setup(ctx);
  const historyFrom = store.history.length;
  sched.arm();
  const tasks = scenario(ctx);
  await sched.run(tasks);
  const seedState = historyFrom === 0 ? undefined : store.history[historyFrom - 1];
  store.history.splice(0, historyFrom);

  // **스케줄 뒤에 복구를 한 번 돌린다.** 남은 상태가 이어받을 수 있는 것이어야 한다 —
  // 그게 "막히지 않는다" 의 뜻이다. 여기서는 교차가 없으므로 순수한 회복 가능성만 본다.
  sched.disarm();
  let stuck: string | undefined;
  try {
    await new ApplyRunner(new DpAgent(store), ctx.effects('after'), FAST).recover();
  } catch (e) {
    if (e instanceof DpRejection) stuck = e.kind;
    else problems.push(e as Error);
  }

  return {
    violations: checkProperties(store.history, world, problems, stuck, seedState),
    trace: sched.trace,
    choices: space.taken(),
  };
}

describe('두 리더가 같은 store 를 흔든다 — 스케줄을 생성해서 본다', () => {
  it('apply 와 fence 가 교차해도 다섯 속성이 성립한다', async () => {
    let failure: { violations: Violation[]; trace: string[]; choices: number[] } | undefined;

    const run = await sweep(async (space) => {
      if (failure !== undefined) return;
      const r = await once(space, ({ store, effects, swallow }) => {
        const a = OP('A', 'gen-A', '10', '0', '1');
        return [
          () => swallow(new ApplyRunner(new DpAgent(store), effects('A'), FAST).run(a)),
          async () => {
            await swallow(new DpAgent(store).fence('11'));
          },
        ];
      });
      if (r.violations.length > 0) failure = r;
    });

    console.log(`  스케줄 ${run.schedules} 개 · ${run.exhausted ? '전부 훑었다' : '상한에서 끊었다'}`);
    if (failure !== undefined) {
      console.error('선택열:', JSON.stringify(failure.choices));
      console.error('경로:', failure.trace.join(' → '));
      for (const v of failure.violations) console.error(`  ${v.property}: ${v.detail}`);
    }
    expect(failure?.violations ?? [], '속성이 깨졌다').toEqual([]);
    expect(run.schedules, '스케줄을 하나도 못 훑었다').toBeGreaterThan(1);
  }, 120_000);

  it('두 인스턴스가 같은 오퍼레이션을 밀어도 다섯 속성이 성립한다', async () => {
    let failure: { violations: Violation[]; trace: string[]; choices: number[] } | undefined;

    const run = await sweep(async (space) => {
      if (failure !== undefined) return;
      const r = await once(space, ({ store, effects, swallow }) => {
        const a = OP('A', 'gen-A', '10', '0', '1');
        return [
          () => swallow(new ApplyRunner(new DpAgent(store), effects('one'), FAST).run(a)),
          () => swallow(new ApplyRunner(new DpAgent(store), effects('two'), FAST).run(a)),
        ];
      });
      if (r.violations.length > 0) failure = r;
    });

    console.log(`  스케줄 ${run.schedules} 개 · ${run.exhausted ? '전부 훑었다' : '상한에서 끊었다'}`);
    if (failure !== undefined) {
      console.error('선택열:', JSON.stringify(failure.choices));
      console.error('경로:', failure.trace.join(' → '));
      for (const v of failure.violations) console.error(`  ${v.property}: ${v.detail}`);
    }
    expect(failure?.violations ?? [], '속성이 깨졌다').toEqual([]);
    expect(run.schedules).toBeGreaterThan(1);
  }, 120_000);

  it('apply 와 reconcile 이 교차해도 다섯 속성이 성립한다', async () => {
    let failure: { violations: Violation[]; trace: string[]; choices: number[] } | undefined;

    const run = await sweep(async (space) => {
      if (failure !== undefined) return;
      const r = await once(
        space,
        ({ store, effects, swallow }) => {
          // 이미 gen-A 가 서 있다. 이제 gen-B 로 옮기는 동안 수렴이 끼어든다.
          const b = OP('B', 'gen-B', '10', '1', '2');
          return [
            () => swallow(new ApplyRunner(new DpAgent(store), effects('apply'), FAST).run(b)),
            () => swallow(
              LocalDataplaneDriver.create({ store, effects: effects('rec') }).reconcileConfig(),
            ),
          ];
        },
        async ({ store, effects }) => {
          const a = OP('A', 'gen-A', '10', '0', '1');
          await LocalDataplaneDriver.create({ store, effects: effects('seed') }).applyConfig(a);
        },
      );
      if (r.violations.length > 0) failure = r;
    });

    console.log(`  스케줄 ${run.schedules} 개 · ${run.exhausted ? '전부 훑었다' : '상한에서 끊었다'}`);
    if (failure !== undefined) {
      console.error('선택열:', JSON.stringify(failure.choices));
      console.error('경로:', failure.trace.join(' → '));
      for (const v of failure.violations) console.error(`  ${v.property}: ${v.detail}`);
    }
    expect(failure?.violations ?? [], '속성이 깨졌다').toEqual([]);
    expect(run.schedules, '교차가 생기지 않았다 — 모델이 좁다').toBeGreaterThan(1);
  }, 120_000);

  /**
   * **부분 커밋을 만드는 시나리오** (14차 뒤 보강).
   *
   * `ModelEffects` 가 두 평면을 늘 성공시켜서, 처음 세 시나리오로는 부분 활성화가
   * 만들어지지 않았다 — `finalizeCandidate` 가 도착을 안 보게 하는 뮤테이션을 모델이
   * 통째로 놓쳤다. **통과가 넓어 보였을 뿐 그 축을 안 본 것이다.**
   *
   * 한 평면만 abort 하는 행위자를 넣으면 그 평면의 commit 이 막히고 부분이 만들어진다.
   */
  it('한 평면이 막혀도 부분 활성화가 기준이 되지 않는다', async () => {
    let failure: { violations: Violation[]; trace: string[]; choices: number[] } | undefined;

    const run = await sweep(async (space) => {
      if (failure !== undefined) return;
      const r = await once(space, ({ store, effects, swallow }) => {
        const a = OP('A', 'gen-A', '10', '0', '1');
        return [
          () => swallow(new ApplyRunner(new DpAgent(store), effects('apply'), FAST).run(a)),
          // 남이 stream 슬롯을 걷어찬다. 그 평면은 못 넘어간다.
          () => swallow(new DpAgent(store).abort(tupleFor(a, 'stream'))),
        ];
      });
      if (r.violations.length > 0) failure = r;
    });

    console.log(`  스케줄 ${run.schedules} 개 · ${run.exhausted ? '전부 훑었다' : '상한에서 끊었다'}`);
    if (failure !== undefined) {
      console.error('선택열:', JSON.stringify(failure.choices));
      console.error('경로:', failure.trace.join(' → '));
      for (const v of failure.violations) console.error(`  ${v.property}: ${v.detail}`);
    }
    expect(failure?.violations ?? [], '속성이 깨졌다').toEqual([]);
    expect(run.schedules).toBeGreaterThan(1);
  }, 120_000);

  /**
   * **밀던 러너와 복구가 겹친다.**
   *
   * 운영에서 흔한 모양이다 — 프로세스가 죽은 줄 알고 다른 쪽이 복구를 시작했는데 원래
   * 러너가 살아 있었다. 종단 재진입과 실행권 반납이 여기서 얽힌다.
   */
  it('밀던 러너와 복구가 겹쳐도 다섯 속성이 성립한다', async () => {
    let failure: { violations: Violation[]; trace: string[]; choices: number[] } | undefined;

    const run = await sweep(async (space) => {
      if (failure !== undefined) return;
      const r = await once(space, ({ store, effects, swallow }) => {
        const a = OP('A', 'gen-A', '10', '0', '1');
        return [
          () => swallow(new ApplyRunner(new DpAgent(store), effects('run'), FAST).run(a)),
          () => swallow(new ApplyRunner(new DpAgent(store), effects('rec'), FAST).recover()),
        ];
      });
      if (r.violations.length > 0) failure = r;
    });

    console.log(`  스케줄 ${run.schedules} 개 · ${run.exhausted ? '전부 훑었다' : '상한에서 끊었다'}`);
    if (failure !== undefined) {
      console.error('선택열:', JSON.stringify(failure.choices));
      console.error('경로:', failure.trace.join(' → '));
      for (const v of failure.violations) console.error(`  ${v.property}: ${v.detail}`);
    }
    expect(failure?.violations ?? [], '속성이 깨졌다').toEqual([]);
    expect(run.schedules).toBeGreaterThan(1);
  }, 120_000);

  /**
   * **수렴 중에 리더가 바뀐다.**
   *
   * 13차 ① 과 14차 회귀가 둘 다 이 자리였다. 손으로는 두 번 다 틀렸으니 생성해서 본다.
   */
  it('수렴 중에 리더가 바뀌어도 다섯 속성이 성립한다', async () => {
    let failure: { violations: Violation[]; trace: string[]; choices: number[] } | undefined;

    const run = await sweep(async (space) => {
      if (failure !== undefined) return;
      const r = await once(
        space,
        ({ store, effects, swallow }) => [
          () => swallow(
            LocalDataplaneDriver.create({ store, effects: effects('rec') }).reconcileConfig(),
          ),
          () => swallow(new DpAgent(store).fence('11')),
        ],
        async ({ store, world, effects }) => {
          await LocalDataplaneDriver.create({ store, effects: effects('seed') })
            .applyConfig(OP('A', 'gen-A', '10', '0', '1'));
          // **바깥을 어긋나게 둔다.** 정합하면 수렴이 읽고 끝나서 게시·HUP 경로를
          // 아예 안 지난다 — lease 검사를 시험할 수가 없다.
          world.published = undefined;
        },
      );
      if (r.violations.length > 0) failure = r;
    });

    console.log(`  스케줄 ${run.schedules} 개 · ${run.exhausted ? '전부 훑었다' : '상한에서 끊었다'}`);
    if (failure !== undefined) {
      console.error('선택열:', JSON.stringify(failure.choices));
      console.error('경로:', failure.trace.join(' → '));
      for (const v of failure.violations) console.error(`  ${v.property}: ${v.detail}`);
    }
    expect(failure?.violations ?? [], '속성이 깨졌다').toEqual([]);
    expect(run.schedules).toBeGreaterThan(1);
  }, 120_000);

  /**
   * **서로 다른 두 오퍼레이션이 같은 좌표를 노린다.**
   *
   * 15차에 `pendingEpochs` 를 넣으면서 "완결의 뜻은 후보가 정한다" 고 했는데, 그 뜻이
   * **실행권에서** 온다. 실행권이 다른 오퍼레이션 것으로 바뀌는 사이에 후보가 만들어지면
   * 어떻게 되는가 — 손으로는 그 순간을 고를 자신이 없어서 생성해서 본다.
   */
  it('두 오퍼레이션이 같은 좌표를 노려도 다섯 속성이 성립한다', async () => {
    let failure: { violations: Violation[]; trace: string[]; choices: number[] } | undefined;

    const run = await sweep(async (space) => {
      if (failure !== undefined) return;
      const r = await once(space, ({ store, effects, swallow }) => {
        const a = OP('A', 'gen-A', '10', '0', '1');
        const b = OP('B', 'gen-B', '10', '0', '1');
        return [
          () => swallow(new ApplyRunner(new DpAgent(store), effects('A'), FAST).run(a)),
          () => swallow(new ApplyRunner(new DpAgent(store), effects('B'), FAST).run(b)),
        ];
      });
      if (r.violations.length > 0) failure = r;
    });

    console.log(`  스케줄 ${run.schedules} 개 · ${run.exhausted ? '전부 훑었다' : '상한에서 끊었다'}`);
    if (failure !== undefined) {
      console.error('선택열:', JSON.stringify(failure.choices));
      console.error('경로:', failure.trace.join(' → '));
      for (const v of failure.violations) console.error(`  ${v.property}: ${v.detail}`);
    }
    expect(failure?.violations ?? [], '속성이 깨졌다').toEqual([]);
    expect(run.schedules).toBeGreaterThan(1);
  }, 120_000);

  /**
   * **셋이 얽힌다** — 밀고, 리더가 바뀌고, 한 평면이 걷어차인다.
   *
   * 15차 수정 셋(`pendingEpochs` · lease 이중 검사 · `failAll` 이 좌표를 읽는 것)이
   * 전부 이 교차에서 만난다.
   */
  it('밀기·승계·걷어차기가 겹쳐도 다섯 속성이 성립한다', async () => {
    let failure: { violations: Violation[]; trace: string[]; choices: number[] } | undefined;

    const run = await sweep(async (space) => {
      if (failure !== undefined) return;
      const r = await once(space, ({ store, effects, swallow }) => {
        const a = OP('A', 'gen-A', '10', '0', '1');
        return [
          () => swallow(new ApplyRunner(new DpAgent(store), effects('run'), FAST).run(a)),
          () => swallow(new DpAgent(store).fence('11')),
          () => swallow(new DpAgent(store).abort(tupleFor(a, 'stream'))),
        ];
      });
      if (r.violations.length > 0) failure = r;
    });

    console.log(`  스케줄 ${run.schedules} 개 · ${run.exhausted ? '전부 훑었다' : '상한에서 끊었다'}`);
    if (failure !== undefined) {
      console.error('선택열:', JSON.stringify(failure.choices));
      console.error('경로:', failure.trace.join(' → '));
      for (const v of failure.violations) console.error(`  ${v.property}: ${v.detail}`);
    }
    expect(failure?.violations ?? [], '속성이 깨졌다').toEqual([]);
    expect(run.schedules).toBeGreaterThan(1);
  }, 120_000);

  /**
   * **호출자가 평면을 하나만 담아 끝낸다.**
   *
   * 15차 ① 이 이 모양이었다 — `abortConfig` 는 호출자가 준 오퍼레이션을 그대로 쓴다.
   * 담긴 평면만 보고 완결을 판정하면 부분 활성화가 기준으로 올라간다. 고쳤지만,
   * **모델이 그 자리를 안 지나고 있었다.** 지나게 만든다.
   */
  it('평면 하나만 담은 abort 가 끼어들어도 다섯 속성이 성립한다', async () => {
    let failure: { violations: Violation[]; trace: string[]; choices: number[] } | undefined;

    const run = await sweep(async (space) => {
      if (failure !== undefined) return;
      const r = await once(space, ({ store, effects, swallow }) => {
        const a = OP('A', 'gen-A', '10', '0', '1');
        const half: ApplyOperation = {
          ...a,
          affectedPlanes: ['http'],
          planes: { http: a.planes.http! },
        };
        return [
          () => swallow(new ApplyRunner(new DpAgent(store), effects('run'), FAST).run(a)),
          () => swallow(
            LocalDataplaneDriver.create({ store, effects: effects('ab') }).abortConfig(half),
          ),
        ];
      });
      if (r.violations.length > 0) failure = r;
    });

    console.log(`  스케줄 ${run.schedules} 개 · ${run.exhausted ? '전부 훑었다' : '상한에서 끊었다'}`);
    if (failure !== undefined) {
      console.error('선택열:', JSON.stringify(failure.choices));
      console.error('경로:', failure.trace.join(' → '));
      for (const v of failure.violations) console.error(`  ${v.property}: ${v.detail}`);
    }
    expect(failure?.violations ?? [], '속성이 깨졌다').toEqual([]);
    expect(run.schedules).toBeGreaterThan(1);
  }, 120_000);
});
