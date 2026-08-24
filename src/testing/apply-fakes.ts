/**
 * 테스트용 크래시 주입과 가짜 부작용 — 검수 2026-08-24 G5
 *
 * ── 왜 `src/dp/apply.ts` 에서 나왔나
 *
 * 이것들은 **호출자가 테스트와 스파이크뿐**이다. 그런데 `apply.ts` 에 살면
 * `tsconfig.build.json` 이 `src` 를 통째로 담으므로 **배포 산출물(`dist/`)에 크래시
 * 주입 기계가 그대로 들어간다.** 배포 이미지가 `dist/` 를 통째로 복사하므로 실서비스
 * 컨테이너에 그 코드가 실린다.
 *
 * 그리고 `scripts/reachable.mjs` 의 `ALLOW` 에 예외로 적혀 있었다 — 예외는 값이 있지만
 * **예외를 안 만들 수 있으면 그게 낫다.**
 *
 * ── 스파이크는 여전히 이것들을 쓴다
 *
 * `spike/s12/runner.mjs` 가 실물 `FileStore` 를 `FaultStore` 로 감싸 크래시를 넣는다.
 * 그건 컨테이너 안에서 도는 **빌드 산출물**을 쓰므로(소스를 직접 못 돌린다), 이 파일도
 * 어딘가로는 빌드돼야 한다. `dist/` 가 아니라 **`dist-testing/`** 으로 나간다 —
 * 배포 이미지는 `dist/` 만 복사하므로 거기 안 실린다.
 */
import type { AgentState, DurableStore, StoredState } from '../dp/agent.js';
import type { Effects, PreflightResult } from '../dp/apply.js';
import type {
  ActivationEvidence, ApplyLease, ApplyOperation, Checked, Plane, PublishRecord, PublishedState,
} from '../dp/operation.js';

export class CrashInjected extends Error {
  constructor(readonly at: string) {
    super(`크래시 주입: ${at}`);
    this.name = 'CrashInjected';
  }
}

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
  // **한 쓰기가 저널까지 열면 이름이 그걸 말해야 한다** (16차). `reserveAll` 이 첫 저널을
  // 함께 쓰게 되면서, 예약 이름만 남고 "저널을 열었다" 가 이름에서 사라졌다. 지점을
  // 이름으로 판정하는데 이름이 하는 일을 다 안 말하면 계측이 거짓이 된다.
  if (prev.journal?.phase !== next.journal?.phase && next.journal !== undefined) {
    changes.push(`journal:${next.journal.phase}`);
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
  if (prev.lastPublishIntent?.generation !== next.lastPublishIntent?.generation
    || prev.lastPublishIntent?.operationId !== next.lastPublishIntent?.operationId) {
    return 'publish_intent_recorded';
  }
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
  load(): StoredState | undefined {
    return this.inner.load();
  }
  async save(state: StoredState): Promise<void> {
    const label = classifyWrite(
      this.inner.load()?.payload as AgentState | undefined,
      state.payload as AgentState,
    );
    this.clock.tick(`${label}:before`);
    await this.inner.save(state);
    this.clock.tick(`${label}:after`);
  }
}

/** 관측 가능한 가짜 부작용. 시계를 공유해 크래시 지점을 함께 센다. */
export class FakeEffects implements Effects {
  publishedRecord: PublishRecord | undefined;
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

  async preflight(_op: ApplyOperation): Promise<PreflightResult> {
    this.preflightCalls += 1;
    return this.preflightOk
      ? { ok: true, configTestPassed: true }
      : { ok: false, reason: '주입된 preflight 실패' };
  }

  async publish(record: PublishRecord, lease: ApplyLease): Promise<Checked> {
    if (this.crashBeforeEffect === 'publish') throw new CrashInjected('before publish');
    this.clock.tick('publish:before');
    // **되돌릴 수 없는 지점 직전.** 여기와 아래 대입 사이에 await 가 없다.
    const checked = lease.assertValid();
    this.publishCalls += 1;
    this.publishedRecord = record;
    if (this.crashAfterEffect === 'publish') throw new CrashInjected('after publish');
    this.clock.tick('publish:after');
    return checked;
  }

  async observePublished(): Promise<PublishedState> {
    return this.publishedRecord === undefined
      ? { kind: 'none' }
      : { kind: 'owned', record: this.publishedRecord };
  }

  /** 편의 — 테스트가 세대 이름만 볼 때. */
  get publishedGeneration(): string | undefined {
    return this.publishedRecord?.generation;
  }

  async signalReload(lease: ApplyLease): Promise<Checked> {
    if (this.crashBeforeEffect === 'reload') throw new CrashInjected('before reload');
    this.clock.tick('reload:before');
    const checked = lease.assertValid();
    this.reloadSignals += 1;
    if (this.reloadTakesEffect) this.acceptingGeneration = this.publishedRecord?.generation;
    if (this.crashAfterEffect === 'reload') throw new CrashInjected('after reload');
    this.clock.tick('reload:after');
    return checked;
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
