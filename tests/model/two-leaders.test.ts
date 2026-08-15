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
 * **시나리오가 그 자리를 지나게 만드는 것과 때리는 것은 다르다.** 15차 수정 둘을 겨냥해
 * 시나리오를 넣었는데 뮤테이션이 안 잡혔다 — 지나기만 한 것이다. 원인이 둘로 갈렸다.
 *
 *   · `pendingEpochs` — **교차가 너무 길었다.** "http commit → abort 전체 시퀀스 →
 *     stream commit" 이 표본에 안 들어온다. **준비 단계에서 http 만 넘겨 놓아** 무대를
 *     좁혔다. 어느 쪽이 언제 끼어드는지는 여전히 스케줄러가 정한다.
 *
 *   · reconcile lease 의 토큰 검사 — **속성이 없었다.** 게시와 HUP 은 상태에 안 남고
 *     바깥에서만 보이므로 P1~P5 중 어느 것도 볼 수 없었다. **P6** 을 만들었다:
 *     낡은 리더는 되돌릴 수 없는 연산을 내지 않는다.
 *
 * 둘 다 이제 잡힌다. **못 잡을 때는 이유가 둘 중 하나다 — 무대가 넓거나, 속성이 없거나.**
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
  journal?: {
    phase: string;
    op: {
      operationId: string;
      transitionId: string;
      leaderToken: string;
      // P10 이 보려면 **이 전환이 어디로 가려 했는지**가 있어야 한다. payload 에는 원래
      // 있었고 여기서 좁혀 놓았을 뿐이다.
      affectedPlanes: Plane[];
      planes: Record<Plane, { target: { activationEpoch: string } }>;
    };
  };
  lastActivated?: PublishRecord;
  pendingActivation?: PublishRecord;
  lastPublishIntent?: PublishRecord;
};

const TERMINAL = new Set([
  'activated', 'partial_exhausted', 'failed', 'superseded', 'no_operation',
]);

/**
 * 종단 중 **범위를 주장하는** 것들. P10 은 이것만 본다.
 *
 * `superseded` 는 "내 일이 아니게 됐다" 이고 `no_operation` 은 "할 일이 없었다" 다 —
 * 둘 다 몇 평면이 넘어갔는지 말하지 않으므로 좌표와 대조할 것이 없다.
 */
const EXTENT = new Set(['activated', 'partial_exhausted', 'failed']);

/**
 * 저장될 때마다 상태를 남긴다. 속성은 **역사**를 보고 판정한다.
 *
 * **누가 쓰는지로 라벨을 단다** (17차 검수). 전에는 모든 행위자의 save 가 `store:save:*`
 * 하나였다. `actorOf` 가 라벨 앞부분으로 행위자를 가르는데 그게 전부 'store' 로 뭉개져서,
 * preemption 예산이 "같은 행위자를 계속 돌린다" 를 잘못 계산했다 — 표본이 특정 창을
 * 구조적으로 못 지나는 원인 중 하나였다.
 *
 * 상태는 하나를 공유하고 **라벨만 갈라진다.** `for(who)` 가 그 행위자용 창구다.
 */
class ModelStore implements DurableStore {
  private current: StoredState | undefined;
  readonly history: Seen[] = [];

  constructor(private readonly sched: Scheduler, private readonly who: string) {}

  /** 같은 상태를 보는, 이름만 다른 창구. */
  for(who: string): DurableStore {
    const shared = this;
    return {
      load: () => shared.load(),
      save: (state) => shared.saveAs(who, state),
    };
  }

  load(): StoredState | undefined {
    return this.current;
  }

  save(state: StoredState): Promise<void> {
    return this.saveAs(this.who, state);
  }

  private async saveAs(who: string, state: StoredState): Promise<void> {
    await this.sched.yield(`${who}:save:before`);
    const live = this.current?.version ?? 0;
    if (state.version !== live + 1) {
      // CAS. 여기서 밀리는 것이 정상이다 — 러너가 다시 읽고 다시 판정한다.
      const { StoreConflict } = await import('../../src/dp/agent.js');
      throw new StoreConflict(`버전이 밀렸다 (${state.version} ≠ ${live + 1})`);
    }
    this.current = state;
    this.history.push(structuredClone(state.payload) as Seen);
    await this.sched.yield(`${who}:save:after`);
  }
}

/** 바깥 세상. 심볼릭 링크 하나와 nginx 하나가 있다고 친다. */
class World {
  published: PublishRecord | undefined;
  accepting: string | undefined;
  publishes = 0;
  reloads = 0;
  /**
   * **누가 부작용을 냈는가** (P6).
   *
   * 게시와 HUP 은 되돌릴 수 없다. 낡은 리더가 그걸 내면 lease 규약이 깨진 것이다 —
   * 그런데 그 사실은 **상태에 안 남는다.** 바깥에서만 보인다. 그래서 여기 적는다.
   */
  readonly effects: {
    what: string; token: string; maxAtTime: string; pendingAtTime?: string; generation?: string;
  }[] = [];

  /**
   * **수렴이 무엇이라고 답했는가** (P7 · 18차 검수).
   *
   * 여기가 통째로 비어 있었다. P0~P6 은 store 역사와 부작용만 본다 — `reconcileConfig`
   * 의 **반환값**을 보는 속성이 하나도 없었다. 그래서 수렴이 거짓으로 `converged` 를
   * 답한 반례 넷(13차 ①④ · 16차 · 17차 A · 18차 #1)이 **전부 사람 손에 잡혔고 모델이
   * 잡은 것은 0** 이었다. "무대가 넓거나 속성이 없거나" 중 후자다.
   */
  readonly answers: {
    kind: string; generation?: string; pending?: string; baseline?: string; world?: string;
  }[] = [];
}

class ModelEffects implements Effects {
  constructor(
    private readonly sched: Scheduler,
    private readonly world: World,
    private readonly who: string,
    private readonly store?: ModelStore,
  ) {}

  /** 이 부작용을 낸 토큰과, 그 순간의 최신 토큰·미완 활성화를 함께 남긴다. */
  private witness(what: string, token: string, generation?: string): void {
    const payload = this.store?.load()?.payload as Seen | undefined;
    this.world.effects.push({
      what,
      token,
      maxAtTime: payload?.maxLeaderToken ?? '0',
      ...(generation !== undefined ? { generation } : {}),
      ...(payload?.pendingActivation !== undefined
        ? { pendingAtTime: payload.pendingActivation.generation } : {}),
    });
  }

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
      this.witness('publish', lease.leaderToken, record.generation);
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
      this.witness('reload', lease.leaderToken, this.world.published?.generation);
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
const swallow = (problems: Error[], rejections: string[]) =>
  async (p: Promise<unknown>): Promise<void> => {
    try {
      await p;
    } catch (e) {
      // **거부를 버리지 않는다** (20차 검수). 전에는 그냥 삼켰다. 그러면 "정당한 요청이
      // 거부되지 않는다" 방향의 속성을 **구조적으로** 못 쓴다 — 거부가 기록에 안 남으니까.
      // 20차 반례 셋이 전부 그 사각에 있었다.
      if (e instanceof DpRejection) {
        rejections.push(e.kind);
        return;
      }
      const name = (e as Error).name;
      if (name === 'StoreConflict' || name === 'EffectTimeout') return;
      problems.push(e as Error);
    }
  };

/**
 * 수렴을 부르고 **답과 그 순간의 상태를 함께** 남긴다.
 *
 * 답이 나온 뒤에 상태를 읽으면 늦다 — 그 사이 남이 또 바꾼다. 부른 직후 같은 tick 에서 읽는다.
 */
async function reconcileWitnessed(
  driver: {
    reconcileConfig(): Promise<{
      kind: string;
      record?: { generation: string };
      expected?: { generation: string };
    }>;
  },
  store: ModelStore,
  world: World,
): Promise<void> {
  const r = await driver.reconcileConfig();
  const payload = store.load()?.payload as Seen | undefined;
  const named = r.record ?? r.expected;
  world.answers.push({
    kind: r.kind,
    ...(named !== undefined ? { generation: named.generation } : {}),
    ...(world.published !== undefined ? { world: world.published.generation } : {}),
    ...(payload?.pendingActivation !== undefined
      ? { pending: payload.pendingActivation.generation } : {}),
    ...(payload?.lastActivated !== undefined
      ? { baseline: payload.lastActivated.generation } : {}),
  });
}

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
  blocked?: string,
  rejections: readonly string[] = [],
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

    // P10 — **어디까지 갔는지 적은 말이 좌표와 맞는가** (23차 CE-A).
    //
    // §3.4 는 **네 번 재발했다**: 13차 ③(`failAll` 이 "다 실패" 로 넘어간 평면을 숨김) ·
    // 21차 CE-C(`abortConfig` 에서 같은 것) · 22차 R2(전부 넘어갔는데 "부분") ·
    // 23차 CE-A(부분 봉투가 "전부"). 네 번 다 다른 자리였고 네 번 다 손으로 찾았다.
    //
    // **이유는 무대가 좁아서가 아니다.** 모델에는 이미 부분 봉투 abort 시나리오가 있고
    // 그 자리를 매번 지나갔다 — 그런데 **P0~P9 중 저널의 말이 참인지 보는 속성이 하나도
    // 없었다.** 속성 없는 축은 무대가 아무리 넓어도 안 잡힌다. 22차가 P8 에서 배운 것과
    // 같다: 없는 검사는 스윕도 못 지운다.
    //
    // **검출력을 재 봤다.** CE-A 를 되돌리면 기존 시나리오("부분 커밋 상태에서 부분
    // abort")가 잡는다. 21차 CE-C 모양(넘어간 평면을 숨기고 `failed`)도 잡는다.
    // **22차 R2 모양(전부 넘어갔는데 "부분")은 못 잡는다** — 전 평면 커밋 뒤 abort 라는
    // 무대가 모델에 없어서다. 그쪽은 conformance 가 든다. 여기 적어 두는 이유는 22차에
    // P8 에서 배운 것 때문이다: **검출력을 재지 않고 넣은 절은 자구로만 이행한 것이다.**
    //
    // 판정은 **그 말이 쓰인 순간**에만 한다. 저널이 종단으로 닫힌 뒤에도 좌표는 다음
    // 오퍼레이션이 움직일 수 있고, 그걸 옛 말과 대조하면 오탐이다.
    //
    // `superseded` · `no_operation` 은 뺀다 — 그 둘은 **범위를 주장하지 않는다.**
    if (s.journal !== undefined && EXTENT.has(s.journal.phase)) {
      const j = s.journal;
      const same = prev?.journal !== undefined
        && prev.journal.phase === j.phase
        && prev.journal.op.operationId === j.op.operationId
        && prev.journal.op.transitionId === j.op.transitionId
        && prev.journal.op.leaderToken === j.op.leaderToken;
      if (!same) {
        const planes = j.op.affectedPlanes;
        const moved = planes.filter(
          (plane) => s.planes[plane]?.activationEpoch === j.op.planes[plane]?.target.activationEpoch,
        );
        const truth = moved.length === planes.length
          ? 'activated'
          : moved.length > 0 ? 'partial_exhausted' : 'failed';
        if (truth !== j.phase) {
          bad.push({
            property: 'P10 어디까지 갔는지 적은 말이 좌표와 맞는다',
            detail: `저널은 ${j.phase} 인데 좌표는 ${moved.length}/${planes.length} 넘어갔다`
              + ` (${planes.map((x) => `${x}=${s.planes[x]?.activationEpoch}`).join(' ')})`,
          });
        }
      }
    }

    // P1 — 낡은 행위자는 **지금 하려는 일**을 바꾸지 못한다.
    //
    // 처음엔 `pendingActivation` 과 `lastActivated` 도 여기서 봤다. **틀렸다** (17차 반례 B).
    // 그 둘은 **일어난 일의 기록**이고, 기록에 적힌 토큰은 "누가 활성화했나" 라는 역사다 —
    // 지금 쓰는 사람이 누구인지가 아니다.
    //
    // 실제로 갈리는 자리: 전 평면이 넘어간 후보가 서 있는데 `fence('11')` 이 끼어들면,
    // `supersede` 가 후보를 승격시킨다(14차 고아 방지). 그 **한 쓰기**에서 `max` 가 11 이
    // 되면서 토큰 10 짜리 기준이 새로 쓰인다. 쓰는 사람은 신임인데 기록은 옛 사건이다.
    // 그걸 위반으로 세면 정당한 승계를 위반이라고 부르게 된다.
    //
    // `lastPublishIntent` 는 다르다 — "지금 게시하려는 것" 이라 **현재 리더의 주장**이다.
    // 낡은 러너가 그걸 덮은 것이 14차에 모델이 찾은 진짜 버그였고, 그건 여기 남는다.
    //
    // 활성화 기록 쪽은 다른 것들이 지킨다: I5(토큰 ≤ max) · I6(기준은 후보를 거쳐서만
    // 생긴다) · P3(부분 후보는 승격되지 않는다).
    for (const [what, rec] of [
      ['lastPublishIntent', s.lastPublishIntent],
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
  // ── P6 — 낡은 리더는 되돌릴 수 없는 연산을 내지 않는다 ────────────────
  //
  // lease 규약이 약속하는 것이 정확히 이것이다. 그런데 **상태에 안 남는다** — 게시와
  // HUP 은 바깥에서만 보인다. 그래서 누가 냈는지를 World 가 적고 여기서 본다.
  // 이 속성이 없어서 reconcile lease 의 토큰 검사를 빼는 뮤테이션이 통과했다.
  for (const e of world.effects) {
    if (BigInt(e.token) < BigInt(e.maxAtTime)) {
      bad.push({
        property: 'P6 낡은 리더는 부작용을 내지 않는다',
        detail: `토큰 ${e.token} 이 ${e.what} 을 냈다 (그 순간 최신은 ${e.maxAtTime})`,
      });
    }
  }

  // ── P7 — 수렴이 "다 됐다" 고 말할 때는 정말 다 돼 있어야 한다 ────────
  //
  // `converged(r)` 는 호출자에게 **손 떼도 된다**는 뜻이다. 틀리면 제일 비싼 답이다.
  // 그 순간 (1) 끝나지 않은 활성화가 없어야 하고 (2) 답한 것이 실제 기준이어야 한다.
  for (const a of world.answers) {
    // **`repaired` 도 settled 주장이다** (19차 검수). 처음엔 `converged` 만 봤는데,
    // "제자리로 돌려놨다" 도 "손 떼도 된다" 와 같은 무게의 답이다.
    //
    // 처음엔 이빨이 없었다 — 시나리오가 `repaired` 답에 끝나지 않은 전환이 겹치는 자리를
    // 안 지났다. **속성이 없어서가 아니라 무대가 좁아서**였고, 그건 고치는 방법이 다르다.
    // 바깥을 어긋나게 둔 시나리오를 넣어 그 자리를 지나게 했고, 이제 게이트를 무력화하면
    // P7 이 두 절에서 터진다(확인했다).
    if (a.kind !== 'converged' && a.kind !== 'repaired') continue;
    if (a.pending !== undefined) {
      bad.push({
        property: 'P7 수렴은 끝나지 않은 전환을 덮지 않는다',
        detail: `${a.kind}(${a.generation}) 인데 끝나지 않은 것 ${a.pending} 가 남아 있다`,
      });
    }
    if (a.generation !== undefined && a.baseline !== undefined && a.generation !== a.baseline) {
      bad.push({
        property: 'P7 수렴이 답한 것이 기준이다',
        detail: `${a.kind}(${a.generation}) 인데 기준은 ${a.baseline} 다`,
      });
    }
    // **바깥도 본다** (19차 검수). durable 만 보면 "기준과 세상이 갈라진 채 수렴했다" 를
    // 못 잡는다 — 수렴의 존재 이유가 바로 그 둘을 맞추는 것이다.
    if (a.generation !== undefined && a.world !== undefined && a.generation !== a.world) {
      bad.push({
        property: 'P7 수렴이 답한 것이 바깥에 올라가 있다',
        detail: `${a.kind}(${a.generation}) 인데 바깥은 ${a.world} 다`,
      });
    }
  }

  // ── P8 — **좋은 일이 일어난다** (20차 검수) ──────────────────────────
  //
  // 계측기 넷이 전부 "나쁜 일이 안 일어난다" 만 봤다. 그런데 20차 반례 셋은 **전부**
  // 반대쪽에서 났다 — 정당한 오퍼레이션이 거부되고, 좌표가 잠기고, 처방이 죽었다.
  // 상태는 내내 정합했으므로 불변식도 P0~P7 도 무풍이었다.
  //
  // 여기서 두 가지를 본다.
  //   · 스케줄이 끝난 뒤 **깨끗한 좌표에 대한 새 오퍼레이션이 들어간다** (`blocked`)
  //   · 영구 거부(`slot_taken`·`operation_in_flight`)가 **끝까지 남지 않는다**
  // ── P9 — 부작용은 **끝난 활성화를 되돌리지 않는다** (20차 검수) ──────
  //
  // 19차 #3 이 이 모양이었다: 수렴이 되돌리는 사이 다른 인스턴스가 새 세대를 전 평면
  // 커밋했는데, 수렴이 **옛 기준을 게시하고 HUP 을 보냈다.** 답은 참이었다(diverged)
  // — 거짓은 **세상**에 있었다. P6 은 토큰만, P7 은 답만 본다.
  //
  // 20차 검수가 실측했다: 부작용 게이트 셋을 지운 뮤턴트를 **모델 전부가 통과**시킨다.
  //
  // ⚠️ **속성은 만들었지만 아직 그 창을 못 지난다. 네 번 시도했다.**
  //
  // 무대 자체는 성립한다 — 그 시나리오에서 게시가 2000 회 넘게 나가고 그중 700 회 이상은
  // 후보가 선 채로 나간다(테스트가 그 수를 센다). 다만 그건 전부 **러너가 자기 후보를
  // 게시하는 것**이라 정상이다. 필요한 것은 **수렴이 남의 후보 위로** 게시하는 순간인데,
  // 후보가 수렴 시작 전에 서면 라운드 머리가 먼저 잡고, 도중에 생기게 하려면 관측 두 번
  // 사이를 정확히 맞춰야 한다 — 표본에 안 들어온다.
  //
  // **초록을 "안전하다" 로 읽으면 안 된다.** 그래서 게시 수를 세어 "무대는 지났다" 만
  // 단언한다 — 무대도 안 지났으면 그건 다른 문제다.
  //
  // 지금 이 창을 지키는 것은 conformance 다(`review17-deadlock` 의 "되돌리는 사이 후보가
  // 생기면 게시도 HUP 도 나가지 않는다"). **속성이 없는 것과 무대가 좁은 것은 다르고,
  // 이건 후자다** — 고치려면 스케줄러가 아니라 시나리오를 더 파야 한다.
  for (const e of world.effects) {
    if (e.pendingAtTime === undefined) continue;
    // **자기 것을 내보내는 것은 정상이다.** 러너는 자기 후보를 게시한다 — 그때도
    // `pendingActivation` 이 있다. 위반은 **남의 활성화 위로** 내보낼 때다.
    if (e.generation === e.pendingAtTime) continue;
    bad.push({
      property: 'P9 부작용은 끝난 활성화를 되돌리지 않는다',
      detail: `${e.what}(${e.generation ?? '?'}) 이 나갔는데 그 순간 승격 안 된 `
        + `활성화 ${e.pendingAtTime} 가 있었다`,
    });
  }

  if (blocked !== undefined) {
    bad.push({
      property: 'P8 정리된 뒤에는 새 오퍼레이션이 들어간다',
      detail: `스케줄이 끝나고 복구까지 했는데 새 오퍼레이션이 ${blocked} 로 막혔다`,
    });
  }
  // **거부가 남았는지는 탐침이 답한다** (22차 검수).
  //
  // 21차에 "영구 거부가 끝까지 남지 않는다" 를 넣는다며 `blocked && rejections.includes(…)`
  // 절을 추가했는데, 그 조건이 위 절의 **진부분집합**이라 독립 검출력이 0 이었다 —
  // 위가 안 터지면 절대 안 터지고, 터질 때는 위가 이미 터져 있다. 22차가 정적으로 짚었다.
  // **자구로만 이행한 것이다.**
  //
  // 정직하게 적는다: 이 방향을 잡는 것은 **fresh-op 탐침(`blocked`) 하나**다.
  // `rejections` 는 진단용 기록이고 판정자가 아니다. 판정에 쓰려면 "정리 뒤에도 남았는가"
  // 를 탐침 없이 볼 방법이 있어야 하는데, 지금은 없다.
  //
  // 그리고 이 하네스는 `mutate.mjs` 의 대상(`src/dp` 다섯 파일) 밖이라 **스윕이 영원히 못
  // 지운다.** 계측기의 계측기가 없다는 뜻이고, 그래서 여기 주석이 더 정확해야 한다.

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
  /** 거부의 종류. 정상 결과지만 **기록은 남긴다** (P8). */
  rejections: string[];
  swallow: (p: Promise<unknown>) => Promise<void>;
};

async function once(
  space: ScheduleSpace,
  scenario: (ctx: Ctx) => (() => Promise<unknown>)[],
  setup?: (ctx: Ctx) => Promise<void>,
): Promise<{
  violations: Violation[];
  trace: string[];
  choices: number[];
  effects: World['effects'];
}> {
  const sched = new Scheduler(space);
  const store = new ModelStore(sched, 'store');
  const world = new World();
  const problems: Error[] = [];
  const rejections: string[] = [];
  const ctx: Ctx = {
    sched,
    store,
    world,
    effects: (who) => new ModelEffects(sched, world, who, store),
    problems,
    rejections,
    swallow: swallow(problems, rejections),
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

  // **정리된 뒤에는 일이 되어야 한다** (P8 · 20차 검수). 여기까지 오면 남은 것을 다
  // 치운 상태다. 그 뒤 **아직 아무도 안 쓴 좌표**로 새 오퍼레이션을 하나 넣어 본다 —
  // 막히면 앞선 교차가 무언가를 영구히 잠근 것이다.
  let blocked: string | undefined;
  // **지금 좌표에서 한 칸 올린다.** 고정값을 쓰면 `coordinate_mismatch` 가 나는데 그건
  // 봉쇄가 아니라 내 탐침이 틀린 것이다 — 처음에 그렇게 짜서 전 시나리오가 빨개졌다.
  const after = new DpAgent(store);
  const token = after.maxLeaderToken();
  /** 평면마다 **지금 그 평면의 좌표**에서 올린다 — 부분 활성화면 둘이 다르다. */
  const step = (plane: Plane) => {
    const at = after.coordinate(plane).activationEpoch;
    const to = String(BigInt(at) + 1n);
    return {
      expectedCurrent: {
        activationEpoch: at,
        membershipRevision: after.coordinate(plane).membershipRevision,
      },
      target: { activationEpoch: to, membershipRevision: to },
      payloadDigest: `sha256:${plane}-fresh`,
    };
  };
  const fresh: ApplyOperation = {
    leaderToken: token,
    operationId: 'fresh',
    transitionId: 'fresh',
    affectedPlanes: ['http', 'stream'],
    targetGeneration: 'gen-fresh',
    generationDigest: 'sha256:gen-fresh',
    planes: { http: step('http'), stream: step('stream') },
  };
  try {
    const r = await new ApplyRunner(new DpAgent(store), ctx.effects('fresh'), FAST).run(fresh);
    if (r.phase !== 'activated') blocked = r.phase;
  } catch (e) {
    if (e instanceof DpRejection) blocked = e.kind;
    else problems.push(e as Error);
  }

  return {
    violations: checkProperties(
      store.history, world, problems, stuck, seedState, blocked, rejections,
    ),
    trace: sched.trace,
    choices: space.taken(),
    effects: world.effects,
  };
}

describe('두 리더가 같은 store 를 흔든다 — 스케줄을 생성해서 본다', () => {
  it('apply 와 fence 가 교차해도 속성이 전부 성립한다', async () => {
    let failure: { violations: Violation[]; trace: string[]; choices: number[] } | undefined;

    const run = await sweep(async (space) => {
      if (failure !== undefined) return;
      const r = await once(space, ({ store, effects, swallow }) => {
        const a = OP('A', 'gen-A', '10', '0', '1');
        return [
          () => swallow(new ApplyRunner(new DpAgent(store.for('A')), effects('A'), FAST).run(a)),
          async () => {
            await swallow(new DpAgent(store.for('fence')).fence('11'));
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

  it('두 인스턴스가 같은 오퍼레이션을 밀어도 속성이 전부 성립한다', async () => {
    let failure: { violations: Violation[]; trace: string[]; choices: number[] } | undefined;

    const run = await sweep(async (space) => {
      if (failure !== undefined) return;
      const r = await once(space, ({ store, effects, swallow }) => {
        const a = OP('A', 'gen-A', '10', '0', '1');
        return [
          () => swallow(new ApplyRunner(new DpAgent(store.for('one')), effects('one'), FAST).run(a)),
          () => swallow(new ApplyRunner(new DpAgent(store.for('two')), effects('two'), FAST).run(a)),
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

  it('apply 와 reconcile 이 교차해도 속성이 전부 성립한다', async () => {
    let failure: { violations: Violation[]; trace: string[]; choices: number[] } | undefined;

    const run = await sweep(async (space) => {
      if (failure !== undefined) return;
      const r = await once(
        space,
        ({ store, world, effects, swallow }) => {
          // 이미 gen-A 가 서 있다. 이제 gen-B 로 옮기는 동안 수렴이 끼어든다.
          const b = OP('B', 'gen-B', '10', '1', '2');
          return [
            () => swallow(new ApplyRunner(new DpAgent(store.for('apply')), effects('apply'), FAST).run(b)),
            () => swallow(reconcileWitnessed(
              LocalDataplaneDriver.create({ store: store.for('rec'), effects: effects('rec') }),
              store, world,
            )),
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
          () => swallow(new DpAgent(store.for('ab')).abort(tupleFor(a, 'stream'))),
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
  it('밀던 러너와 복구가 겹쳐도 속성이 전부 성립한다', async () => {
    let failure: { violations: Violation[]; trace: string[]; choices: number[] } | undefined;

    const run = await sweep(async (space) => {
      if (failure !== undefined) return;
      const r = await once(space, ({ store, effects, swallow }) => {
        const a = OP('A', 'gen-A', '10', '0', '1');
        return [
          () => swallow(new ApplyRunner(new DpAgent(store.for('run')), effects('run'), FAST).run(a)),
          () => swallow(new ApplyRunner(new DpAgent(store.for('rec')), effects('rec'), FAST).recover()),
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
  it('수렴 중에 리더가 바뀌어도 속성이 전부 성립한다', async () => {
    let failure: { violations: Violation[]; trace: string[]; choices: number[] } | undefined;

    const run = await sweep(async (space) => {
      if (failure !== undefined) return;
      const r = await once(
        space,
        ({ store, effects, swallow }) => [
          () => swallow(
            LocalDataplaneDriver.create({ store, effects: effects('rec') }).reconcileConfig(),
          ),
          () => swallow(new DpAgent(store.for('fence')).fence('11')),
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
  it('두 오퍼레이션이 같은 좌표를 노려도 속성이 전부 성립한다', async () => {
    let failure: { violations: Violation[]; trace: string[]; choices: number[] } | undefined;

    const run = await sweep(async (space) => {
      if (failure !== undefined) return;
      const r = await once(space, ({ store, effects, swallow }) => {
        const a = OP('A', 'gen-A', '10', '0', '1');
        const b = OP('B', 'gen-B', '10', '0', '1');
        return [
          () => swallow(new ApplyRunner(new DpAgent(store.for('A')), effects('A'), FAST).run(a)),
          () => swallow(new ApplyRunner(new DpAgent(store.for('B')), effects('B'), FAST).run(b)),
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
  it('밀기·승계·걷어차기가 겹쳐도 속성이 전부 성립한다', async () => {
    let failure: { violations: Violation[]; trace: string[]; choices: number[] } | undefined;

    const run = await sweep(async (space) => {
      if (failure !== undefined) return;
      const r = await once(space, ({ store, effects, swallow }) => {
        const a = OP('A', 'gen-A', '10', '0', '1');
        return [
          () => swallow(new ApplyRunner(new DpAgent(store.for('run')), effects('run'), FAST).run(a)),
          () => swallow(new DpAgent(store.for('fence')).fence('11')),
          () => swallow(new DpAgent(store.for('ab')).abort(tupleFor(a, 'stream'))),
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
  it('평면 하나만 담은 abort 가 끼어들어도 속성이 전부 성립한다', async () => {
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
          () => swallow(new ApplyRunner(new DpAgent(store.for('run')), effects('run'), FAST).run(a)),
          () => swallow(
            LocalDataplaneDriver.create({ store: store.for('ab'), effects: effects('ab') }).abortConfig(half),
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

  /**
   * **창을 좁혀서 겨냥한다.**
   *
   * 앞의 시나리오들은 그 자리를 *지나기만* 했다 — 뮤테이션이 안 잡혔다. 교차가
   * "http commit → abort 전체 시퀀스 → stream commit" 처럼 길어서 표본에 안 들어온다.
   *
   * 준비 단계에서 **http 만 넘겨 놓는다.** 그러면 스케줄이 시작될 때 이미 창 안이고,
   * 남은 것은 "stream 을 마저 넘기는 러너" 와 "평면 하나만 담아 끝내는 abort" 둘뿐이다.
   * 수렴 시나리오에 기준을 미리 세워 둔 것과 같은 수법이다.
   *
   * 이건 교차를 **고르는** 것이 아니다 — 어느 쪽이 언제 끼어드는지는 여전히 스케줄러가
   * 정한다. 무대만 좁혔다.
   */
  it('부분 커밋 상태에서 부분 abort 가 끼어들어도 기준이 서지 않는다', async () => {
    let failure: { violations: Violation[]; trace: string[]; choices: number[] } | undefined;
    const a = OP('A', 'gen-A', '10', '0', '1');
    const half: ApplyOperation = {
      ...a,
      affectedPlanes: ['http'],
      planes: { http: a.planes.http! },
    };

    const run = await sweep(async (space) => {
      if (failure !== undefined) return;
      const r = await once(
        space,
        ({ store, effects, swallow }) => [
          // 남은 평면을 마저 넘긴다.
          () => swallow(new ApplyRunner(new DpAgent(store), effects('run'), FAST).recover()),
          // 그 사이 호출자가 **평면 하나만 담아** 끝낸다.
          () => swallow(
            LocalDataplaneDriver.create({ store: store.for('ab'), effects: effects('ab') }).abortConfig(half),
          ),
        ],
        async ({ store }) => {
          const agent = new DpAgent(store);
          await agent.reserveAll(a);
          await agent.stage(tupleFor(a, 'http'), null);
          await agent.commit(tupleFor(a, 'http'), { acceptingGeneration: 'gen-A' });
          await agent.writeJournal({
            op: a, phase: 'reload_observed', reloadAttempts: 1, seq: 1,
            progress: { http: 'committed', stream: 'staged' },
          });
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
   * **`repaired` 자리를 지나게 만든다** (19차 검수가 P7 의 그쪽 절에 이빨이 없다고 했다).
   *
   * 앞의 수렴 시나리오는 바깥이 정합하거나 기준이 없어서 되돌리기까지 안 갔다. 여기서는
   * **바깥을 어긋나게 둔 채** 시작해 수렴이 실제로 되돌리게 하고, 그 위로 다른 인스턴스가
   * 새 활성화를 끝낸다. 그러면 `repaired` 를 답할 자리에 끝나지 않은 전환이 겹친다.
   *
   * 무대만 좁혔다 — 누가 언제 끼어드는지는 여전히 스케줄러가 정한다.
   */
  it('되돌리는 중에 새 활성화가 끝나도 속성이 전부 성립한다', async () => {
    let failure: { violations: Violation[]; trace: string[]; choices: number[] } | undefined;

    const run = await sweep(async (space) => {
      if (failure !== undefined) return;
      const r = await once(
        space,
        ({ store, world, effects, swallow }) => {
          const b = OP('B', 'gen-B', '10', '1', '2');
          return [
            () => swallow(reconcileWitnessed(
              LocalDataplaneDriver.create({ store: store.for('rec'), effects: effects('rec') }),
              store, world,
            )),
            () => swallow(new ApplyRunner(new DpAgent(store.for('B')), effects('B'), FAST).run(b)),
          ];
        },
        async ({ store, world, effects }) => {
          await LocalDataplaneDriver.create({ store, effects: effects('seed') })
            .applyConfig(OP('A', 'gen-A', '10', '0', '1'));
          // **바깥을 어긋나게 둔다** — 그래야 수렴이 되돌리기 경로로 들어간다.
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
   * **고아 뒤에 새 오퍼레이션이 들어온다** (20차 CE-3 의 모양).
   *
   * 비종단 저널 + 실행권 없음 상태를 준비 단계에서 만들고, 그 위로 새 오퍼레이션과
   * 복구가 겹치게 한다. 20차 반례 셋이 전부 이 무대에서 났는데 모델에는 없었다.
   *
   * P8("정리된 뒤에는 새 오퍼레이션이 들어간다")이 여기서 이빨을 갖는다 — 고아 청소를
   * 되돌리면 좌표가 잠기고, 그건 상태 위반이 아니라 **일이 안 되는 것**이라 P0~P7 이
   * 통째로 무풍이었다.
   */
  it('고아 위로 새 오퍼레이션이 와도 속성이 전부 성립한다', async () => {
    let failure: { violations: Violation[]; trace: string[]; choices: number[] } | undefined;

    const run = await sweep(async (space) => {
      if (failure !== undefined) return;
      const r = await once(
        space,
        ({ store, effects, swallow }) => {
          const b = OP('B', 'gen-B', '10', '0', '1');
          return [
            () => swallow(new ApplyRunner(new DpAgent(store.for('B')), effects('B'), FAST).run(b)),
            () => swallow(new ApplyRunner(new DpAgent(store.for('rec')), effects('rec'), FAST).recover()),
          ];
        },
        async ({ store }) => {
          // 고아를 만든다 — 비종단 저널이 남고 실행권만 놓인다.
          const agent = new DpAgent(store);
          const a = OP('A', 'gen-A', '10', '0', '1');
          await agent.reserveAll(a, { op: a, phase: 'preflight', reloadAttempts: 0, progress: {} });
          await agent.writeJournal({
            op: a, phase: 'published', reloadAttempts: 0,
            seq: (agent.readJournal()?.seq ?? 0) + 1,
            progress: { http: 'reserved', stream: 'reserved' },
          });
          await agent.finishOperation(a);
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
   * **후보가 이미 서 있는 채로 수렴이 돈다** (P9 를 겨냥한 무대).
   *
   * 19차 #3 의 모양이다: 승격 안 된 활성화가 있는데 수렴이 옛 기준을 게시한다. 답은
   * 참이어도(diverged) **세상이 되감긴다** — P6 은 토큰만, P7 은 답만 봐서 못 본다.
   *
   * 준비 단계에서 gen-B 를 전 평면 커밋해 후보를 세워 두고, 바깥은 어긋나게 둔다.
   * 그러면 수렴이 되돌리기 경로로 들어가는데 그 앞에 후보가 있다.
   */
  it('후보가 선 채로 수렴이 돌아도 세상이 되감기지 않는다', async () => {
    let failure: { violations: Violation[]; trace: string[]; choices: number[] } | undefined;
    let publishes = 0;
    let withPending = 0;

    const run = await sweep(async (space) => {
      if (failure !== undefined) return;
      const r = await once(
        space,
        ({ store, world, effects, swallow }) => [
          () => swallow(reconcileWitnessed(
            LocalDataplaneDriver.create({ store: store.for('rec'), effects: effects('rec') }),
            store, world,
          )),
          // 두 평면을 넘긴다 — 첫 commit 이 수렴의 관측 창 안에 들어가면 후보가 그때 생긴다.
          async () => {
            const b2 = OP('B', 'gen-B', '10', '1', '2');
            const mine = new DpAgent(store.for('B'));
            for (const plane of ['http', 'stream'] as const) {
              await swallow(mine.commit(tupleFor(b2, plane), { acceptingGeneration: 'gen-B' }));
            }
          },
        ],
        async ({ store, world, effects }) => {
          await LocalDataplaneDriver.create({ store, effects: effects('seed') })
            .applyConfig(OP('A', 'gen-A', '10', '0', '1'));
          // gen-B 를 **한 평면만** 남겨 둔다. 그러면 후보가 수렴 **도중에** 생긴다 —
          // 미리 세워 두면 라운드 머리 검사가 먼저 걸려 게시까지 안 간다. 교차에 필요한
          // 전환 수를 하나로 줄이는 것이 요점이다.
          const agent = new DpAgent(store);
          const b = OP('B', 'gen-B', '10', '1', '2');
          await agent.reserveAll(b, { op: b, phase: 'preflight', reloadAttempts: 0, progress: {} });
          for (const plane of ['http', 'stream'] as const) {
            await agent.stage(tupleFor(b, plane), null);
          }
          // **커밋은 하나도 안 한다** — 후보가 준비 단계에 있으면 라운드 머리 검사가
          // 먼저 걸려 게시까지 안 간다. 후보가 **수렴 도중에** 생겨야 부작용 게이트가
          // 시험된다. stage 까지만 해 두면 태스크의 첫 commit 이 그 창에 들어갈 수 있다.
          world.published = undefined;
        },
      );
      publishes += r.effects.filter((e) => e.what === 'publish').length;
      withPending += r.effects.filter((e) => e.what === 'publish' && e.pendingAtTime !== undefined).length;
      if (r.violations.length > 0) failure = r;
    });

    console.log(`  스케줄 ${run.schedules} 개 · ${run.exhausted ? '전부 훑었다' : '상한에서 끊었다'}`);
    console.log(`  게시 ${publishes} 회 · 후보가 서 있던 게시 ${withPending} 회`);
    if (failure !== undefined) {
      console.error('선택열:', JSON.stringify(failure.choices));
      for (const v of failure.violations) console.error(`  ${v.property}: ${v.detail}`);
    }
    expect(failure?.violations ?? [], '속성이 깨졌다').toEqual([]);
    expect(run.schedules).toBeGreaterThan(1);
    // **무대가 실제로 그 자리를 지나는지 센다.** 안 지나면 초록은 "안전하다" 가 아니라
    // "거기까지 못 갔다" 다 — 그 구분이 없으면 계측기를 잘못 읽는다.
    expect(publishes, '수렴이 되돌리기까지 가지 않았다 — 무대가 성립하지 않는다')
      .toBeGreaterThan(0);
  }, 120_000);
});
