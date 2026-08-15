/**
 * 결정적 스케줄러 — 교차 진입을 **손으로 고르지 않는다** (14차 검수)
 *
 * 열네 라운드 동안 반례를 손으로 짰다. 그러면 **내가 상상한 교차만** 검사한다. 13차 ①④ 를
 * "재현되지 않는다" 고 잘못 판정한 것도 그래서였다 — 시나리오가 약했지 코드가 안전한 게
 * 아니었다.
 *
 * 두 계측기가 재는 축은 각각 하나뿐이다.
 *
 *   · 표면 해시   → **시그니처** 축
 *   · 불변식      → store 에 저장되는 **상태** 축
 *
 * 최근 결함은 셋 다 **세 번째 축**에 있었다 — `await` 사이의 리더 교체, 외부 효과,
 * 종단 재진입, 같은 store 를 보는 여러 인스턴스. 그 축은 "언제 누가 끼어드는가" 이고,
 * 그건 스케줄을 **생성**해야 잡힌다.
 *
 * 여기서 하는 일은 단순하다. 모든 관심 지점에서 태스크를 세우고, 어느 것을 깨울지
 * 스케줄러가 고른다. 고르는 순서를 DFS 로 **전부** 훑는다.
 *
 * 결정적이라는 것이 중요하다. 실패하면 같은 선택열로 정확히 재현되고, 그걸 그대로
 * `tests/conformance/*.test.ts` 로 옮길 수 있다.
 */

/**
 * 선택 지점의 DFS 열거.
 *
 * 한 번 돌 때마다 지나온 선택 지점과 각 지점의 선택지 개수를 기록한다. 다음 스케줄은
 * **가장 늦은 미탐색 분기**를 하나 밀어 만든다 — 사전식으로 빠짐없이 훑는다.
 */
export class ScheduleSpace {
  private path: { chosen: number; options: number }[] = [];

  constructor(
    private readonly prefix: readonly number[] = [],
    /** 접두사를 넘어선 지점에서 무엇을 고를지. 없으면 0 (DFS). */
    private readonly beyond?: (options: number, ctx: PickContext) => number,
  ) {}

  /** 선택지가 `options` 개인 지점. 어느 것을 고를지 답한다. */
  pick(options: number, ctx: PickContext = { labels: [], last: undefined }): number {
    const depth = this.path.length;
    const wanted = depth < this.prefix.length
      ? (this.prefix[depth] ?? 0)
      : (this.beyond?.(options, ctx) ?? 0);
    // 접두사가 더 넓은 지점에서 만들어졌을 수 있다 — 범위를 벗어나면 0 으로 접는다.
    const chosen = wanted < options ? wanted : 0;
    this.path.push({ chosen, options });
    return chosen;
  }

  /** 다음 스케줄의 접두사. 더 훑을 것이 없으면 `undefined`. */
  next(): number[] | undefined {
    for (let i = this.path.length - 1; i >= 0; i -= 1) {
      const at = this.path[i]!;
      if (at.chosen + 1 < at.options) {
        return [...this.path.slice(0, i).map((p) => p.chosen), at.chosen + 1];
      }
    }
    return undefined;
  }

  /** 이번 회차가 실제로 지나온 선택열. 실패를 재현할 때 쓴다. */
  taken(): number[] {
    return this.path.map((p) => p.chosen);
  }
}

/** 고를 때 보는 것. 어떤 태스크들이 서 있고, 직전에 무엇이 돌았는가. */
export type PickContext = { labels: readonly string[]; last: string | undefined };

type Parked = { label: string; resume: () => void };

/**
 * 협조적 스케줄러.
 *
 * 태스크는 `yield()` 에서 선다. 스케줄러는 **한 번에 하나만** 깨우고, 그것이 다음
 * `yield` 나 완료까지 갈 때까지 기다린다(정지). 그래서 인터리빙이 완전히 결정된다.
 *
 * 정지 판정은 "도는 태스크 수" 로 한다. 모든 await 가 이미 해결된 promise 라서
 * 마이크로태스크만 비우면 반드시 다음 `yield` 나 완료에 도달한다 — store 도 effects 도
 * 가짜이므로 실제 I/O 가 없다.
 */
export class Scheduler {
  private parked: Parked[] = [];
  private running = 0;
  private onQuiet: (() => void) | undefined;
  readonly trace: string[] = [];
  private lastActor: string | undefined;

  constructor(private readonly space: ScheduleSpace) {}

  /**
   * 준비 단계에서는 세우지 않는다.
   *
   * 모델에 초기 상태가 필요할 때가 있다 — 예를 들어 reconcile 을 보려면 기준이 이미
   * 서 있어야 한다. 그걸 스케줄 안에서 만들면 관심 없는 교차만 잔뜩 훑게 된다.
   */
  private armed = false;

  arm(): void {
    this.armed = true;
  }

  /** 스케줄이 끝났다. 이 뒤의 작업은 아무도 깨워 주지 않으므로 세우면 안 된다. */
  disarm(): void {
    this.armed = false;
  }

  /** 관심 지점. 여기서 다른 태스크가 끼어들 수 있다. */
  yield(label: string): Promise<void> {
    if (!this.armed) return Promise.resolve();
    this.leave();
    return new Promise<void>((resolve) => {
      this.parked.push({
        label,
        resume: () => {
          this.running += 1;
          resolve();
        },
      });
    });
  }

  private leave(): void {
    this.running -= 1;
    if (this.running === 0) {
      const quiet = this.onQuiet;
      this.onQuiet = undefined;
      quiet?.();
    }
  }

  private quiescent(): Promise<void> {
    if (this.running === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.onQuiet = resolve;
    });
  }

  /**
   * 태스크들을 한 스케줄로 끝까지 돌린다.
   *
   * 각 태스크의 결과는 **던지지 않고** 돌려준다 — 거부(`DpRejection`)는 이 모델에서
   * 정상적인 결과다. 우리가 보는 것은 그 뒤에 남은 상태다.
   */
  async run(tasks: readonly (() => Promise<unknown>)[]): Promise<PromiseSettledResult<unknown>[]> {
    const settled = tasks.map((task) => {
      this.running += 1;
      return task().finally(() => this.leave());
    });
    const results = Promise.allSettled(settled);

    await this.quiescent();
    let steps = 0;
    while (this.parked.length > 0) {
      if (steps > 4096) throw new Error('스케줄이 끝나지 않는다 — 모델에 사이클이 있다');
      steps += 1;
      const at = this.space.pick(this.parked.length, {
        labels: this.parked.map((x) => x.label),
        last: this.lastActor,
      });
      const [chosen] = this.parked.splice(at, 1);
      this.lastActor = actorOf(chosen!.label);
      this.trace.push(chosen!.label);
      chosen!.resume();
      await this.quiescent();
    }
    return results;
  }
}

/**
 * 스케줄 공간을 유한하게 훑는다.
 *
 * `limit` 은 안전장치다. 다 훑었으면 몇 개를 봤는지 돌려준다 — 그 숫자가 작으면 모델이
 * 좁은 것이고, 그건 통과보다 먼저 알아야 할 사실이다.
 */
export async function explore(
  limit: number,
  body: (space: ScheduleSpace) => Promise<void>,
): Promise<{ schedules: number; exhausted: boolean }> {
  let prefix: readonly number[] | undefined = [];
  let schedules = 0;
  while (prefix !== undefined) {
    if (schedules >= limit) return { schedules, exhausted: false };
    const space: ScheduleSpace = new ScheduleSpace(prefix);
    schedules += 1;
    await body(space);
    prefix = space.next() as readonly number[] | undefined;
  }
  return { schedules, exhausted: true };
}

/**
 * 무작위 표본.
 *
 * DFS 는 **가장 늦은 분기**를 밀며 훑는다. 그래서 예산 안에서는 꼬리 근처만 본다 —
 * 정작 중요한 것은 "리더가 **언제** 바뀌는가" 같은 **앞쪽** 선택인데 거기까지 못 간다.
 * 실제로 finalizer 뮤테이션 둘을 DFS 400 회가 못 잡았다.
 *
 * 시드를 고정한 PRNG 로 균일하게 뽑는다. 결정적이라 실패하면 그대로 재현된다.
 */
export async function probe(
  seed: number,
  runs: number,
  body: (space: ScheduleSpace) => Promise<void>,
): Promise<{ schedules: number }> {
  // xorshift32 — 작고 결정적이면 충분하다.
  let state = seed >>> 0 || 1;
  const rand = (): number => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x1_0000_0000;
  };
  for (let i = 0; i < runs; i += 1) {
    await body(new ScheduleSpace([], (options) => Math.floor(rand() * options)));
  }
  return { schedules: runs };
}

/** 라벨의 앞부분이 행위자다 — `A:publish:before` 에서 `A`. */
export const actorOf = (label: string): string => label.slice(0, label.indexOf(':'));

/**
 * **preemption bounding** — 문맥 전환 횟수를 묶어 공간을 좁힌다.
 *
 * 무작위 표본에는 한계가 있다. 시나리오가 커지면 500 개를 뽑아도 특정 교차가 안 들어온다 —
 * 15차 수정 둘을 겨냥해 시나리오를 넣었는데도 뮤테이션이 안 잡히는 것을 확인했다.
 *
 * 동시성 버그는 대개 **문맥 전환 두세 번**이면 드러난다(CHESS 의 관찰). 그래서 "돌던
 * 태스크를 계속 돌리되, 전환은 K 번까지만" 으로 좁힌다. 같은 예산으로 훨씬 촘촘해진다.
 *
 * 전환 예산이 남아 있으면 무작위로 고르고, 다 쓰면 **직전 행위자를 계속** 돌린다.
 */
export async function probeBounded(
  seed: number,
  runs: number,
  maxPreemptions: number,
  body: (space: ScheduleSpace) => Promise<void>,
): Promise<{ schedules: number }> {
  let state = seed >>> 0 || 1;
  const rand = (): number => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x1_0000_0000;
  };
  for (let i = 0; i < runs; i += 1) {
    let budget = maxPreemptions;
    await body(new ScheduleSpace([], (options, ctx) => {
      const sameIdx = ctx.last === undefined
        ? -1
        : ctx.labels.findIndex((l) => actorOf(l) === ctx.last);
      if (budget <= 0 && sameIdx >= 0) return sameIdx;
      const choice = Math.floor(rand() * options);
      const picked = ctx.labels[choice];
      if (sameIdx >= 0 && picked !== undefined && actorOf(picked) !== ctx.last) budget -= 1;
      return choice;
    }));
  }
  return { schedules: runs };
}
