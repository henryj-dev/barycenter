/**
 * 디스커버리 러너 — 풀마다 출처에 묻고 **마지막 성공 값**을 든다 (2026-11-05).
 *
 * 받은 것은 `intake()` 로 컨트롤 플레인에 들어간다(`ControlPlaneOptions.discovery`). 바뀌면 호출자가 기존
 * 멤버십 투영(`ControlPlane.projectHealth` — 헬스 · 드레인이 쓰는 그 경로)을 부른다. 새 적용 경로는 없다.
 * 세대도 리비전도 만들지 않는다 — 헬스처럼 **운영 상태**다.
 *
 * ── 안전장치 ──────────────────────────────────────────────────────────
 *
 *   · 출처 오류 · 타임아웃 · 이상한 답 → **마지막 성공 값을 그대로** 둔다. 한 번도 성공한 적이 없으면 정적 백엔드다
 *   · 정상 응답이 빈 목록 → 풀의 `emptyMeans`. 기본 `keep` 은 마지막 값을 지킨다(처음이면 정적).
 *     `empty` 면 그 풀의 백엔드가 0 이 된다 — 출처가 「아무도 없다」 고 한 것을 믿는다는 운영자의 선택이다
 *   · 풀의 출처 설정(`source` · `query` · `port`)이 바뀌면 들던 값을 버린다 — 다른 질문의 답을 지키지 않는다
 *   · 출처가 이 데몬에 설정되지 않았으면 「설정 안 됨」 이고 정적 백엔드다
 *
 * 폴링은 한 바퀴가 끝난 뒤 다음 바퀴를 잡는다(겹치지 않는다). 간격에 지터(±10%)를 둔다 — 노드 여럿이 같은 출처를
 * 같은 순간에 두드리지 않게.
 */
import type { DiscoverySourceKind, Model, PoolDiscovery } from '../../model/provisional.js';
import type { DiscoveryIntake, DiscoveredEndpoint } from '../discovery.js';
import type { SourceFailure } from '../sources/fetch.js';
import type { DiscoveredAddress, DiscoverySource } from './source.js';

export type DiscoveryState = 'pending' | 'ok' | 'error' | 'unconfigured';

export type DiscoveryPoolView = {
  pool: string;
  source: DiscoverySourceKind;
  query: string;
  state: DiscoveryState;
  /** 참이면 이 풀은 출처의 목록(`endpoints`)을 쓴다. 거짓이면 정적 백엔드다. */
  advertised: boolean;
  /** 쓰고 있는 출처의 목록 — 마지막으로 성공한 답(포트 덮기 뒤). */
  endpoints: DiscoveredAddress[];
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  error?: { reason: SourceFailure; detail: string };
  /** 마지막 답이 빈 목록이었고 `emptyMeans: keep` 이라 앞의 목록을 지켰다. */
  keptEmpty?: boolean;
};

type PoolState = DiscoveryPoolView & { spec: string };

export type TickResult = {
  /** 쓰는 목록이 바뀐 풀 — 멤버십을 다시 투영해야 한다. */
  changed: string[];
  /** 이번에 **새로** 실패한 풀(성공 → 실패, 또는 실패의 뜻이 바뀜). 알림 · 로그용 — 같은 실패를 매 주기 다시 말하지 않는다. */
  failed: DiscoveryPoolView[];
  /** 실패했다가 이번에 성공한 풀. */
  recovered: string[];
};

export type DiscoveryRunnerOptions = {
  sources: (kind: DiscoverySourceKind) => DiscoverySource | undefined;
  intervalMs: number;
  /** 0~1. 기본 0.1. */
  jitter?: number;
  now?: () => Date;
  random?: () => number;
};

const specOf = (d: PoolDiscovery): string => JSON.stringify([d.source, d.query, d.port ?? null]);

const sameList = (a: readonly DiscoveredAddress[], b: readonly DiscoveredAddress[]): boolean =>
  a.length === b.length && a.every((x, i) => x.host === b[i]?.host && x.port === b[i]?.port);

const viewOf = (s: PoolState): DiscoveryPoolView => {
  const { spec: _spec, ...view } = s;
  return { ...view, endpoints: [...view.endpoints] };
};

export class DiscoveryRunner {
  readonly #pools = new Map<string, PoolState>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;

  constructor(private readonly o: DiscoveryRunnerOptions) {}

  get intervalMs(): number {
    return this.o.intervalMs;
  }

  /**
   * 한 바퀴. 모델에서 출처가 있는 풀을 모두 (함께) 묻는다. **던지지 않는다** — 출처 하나의 고장이 다른 풀을 막지 않는다.
   */
  async tick(model: Model): Promise<TickResult> {
    const now = (this.o.now ?? (() => new Date()))().toISOString();
    const changed: string[] = [];
    const failed: DiscoveryPoolView[] = [];
    const recovered: string[] = [];

    const wanted = new Map(model.pools.flatMap((p) => (p.discovery === undefined ? [] : [[p.key, p.discovery] as const])));
    // 출처가 없어진 풀 — 들던 값을 버린다. 쓰고 있었다면 멤버십이 정적으로 돌아간다.
    for (const [pool, s] of this.#pools) {
      if (!wanted.has(pool)) {
        this.#pools.delete(pool);
        if (s.advertised) changed.push(pool);
      }
    }

    await Promise.all([...wanted].map(async ([pool, d]) => {
      const spec = specOf(d);
      let s = this.#pools.get(pool);
      if (s === undefined || s.spec !== spec) {
        if (s?.advertised === true) changed.push(pool);
        s = { pool, source: d.source, query: d.query, state: 'pending', advertised: false, endpoints: [], spec };
        this.#pools.set(pool, s);
      }
      const before = { advertised: s.advertised, endpoints: s.endpoints, state: s.state, reason: s.error?.reason };
      s.lastAttemptAt = now;

      const source = this.o.sources(d.source);
      if (source === undefined) {
        s.state = 'unconfigured';
        s.error = { reason: 'unconfigured', detail: `이 데몬에 ${d.source} 출처가 설정되지 않았다 — 정적 백엔드를 쓴다 (docs/runbook-data-sources.md)` };
      } else {
        let r: Awaited<ReturnType<DiscoverySource['resolve']>>;
        try {
          r = await source.resolve(d.query);
        } catch (e) {
          // 어댑터는 던지지 않게 썼다. 그래도 빠져나온 것은 실패로 닫는다 — 마지막 값을 지킨다.
          r = { ok: false, reason: 'unavailable', detail: e instanceof Error ? e.message : String(e) };
        }
        if (!r.ok) {
          // **마지막 성공 값을 그대로 둔다.** `advertised` · `endpoints` 를 건드리지 않는다.
          s.state = 'error';
          s.error = { reason: r.reason, detail: r.detail };
        } else {
          const list = d.port === undefined ? r.endpoints : dedupe(r.endpoints.map((e) => ({ host: e.host, port: d.port! })));
          s.state = 'ok';
          delete s.error;
          s.lastSuccessAt = now;
          if (list.length === 0 && (d.emptyMeans ?? 'keep') === 'keep') {
            s.keptEmpty = true;            // 앞의 목록(없으면 정적)을 지킨다
          } else {
            delete s.keptEmpty;
            s.advertised = true;
            s.endpoints = list;
          }
        }
      }

      if (before.advertised !== s.advertised || !sameList(before.endpoints, s.endpoints)) changed.push(pool);
      if ((s.state === 'error' || s.state === 'unconfigured')
        && (before.state !== s.state || before.reason !== s.error?.reason)) failed.push(viewOf(s));
      if (s.state === 'ok' && (before.state === 'error' || before.state === 'unconfigured')) recovered.push(pool);
    }));

    return { changed: [...new Set(changed)].sort(), failed, recovered };
  }

  /** 컨트롤 플레인이 받을 것. 출처의 목록을 쓰는 풀이 없으면 `undefined` — 정적 모델 그대로다. */
  intake(): DiscoveryIntake | undefined {
    const pools = [...this.#pools.values()].filter((s) => s.advertised);
    if (pools.length === 0) return undefined;
    const endpoints: DiscoveredEndpoint[] = pools.flatMap((s) => s.endpoints.map((e) => ({ pool: s.pool, host: e.host, port: e.port })));
    return { advertised: true, endpoints, pools: pools.map((s) => s.pool) };
  }

  views(): DiscoveryPoolView[] {
    return [...this.#pools.values()].sort((a, b) => (a.pool < b.pool ? -1 : 1)).map(viewOf);
  }

  view(pool: string): DiscoveryPoolView | undefined {
    const s = this.#pools.get(pool);
    return s === undefined ? undefined : viewOf(s);
  }

  /**
   * 주기적으로 돈다. `getModel` 이 `undefined` 면 그 바퀴를 건너뛴다. `onTick` 의 실패는 삼킨다(호출자가 로그) —
   * 투영이 한 번 실패해도 다음 바퀴가 같은 목록으로 다시 투영할 수 있게, 바뀐 풀은 `onTick` 이 다시 받는다.
   */
  start(getModel: () => Promise<Model | undefined>, onTick: (r: TickResult) => Promise<void>): void {
    this.#stopped = false;
    let retry: string[] = [];
    const loop = async (): Promise<void> => {
      try {
        const model = await getModel();
        if (model !== undefined) {
          const r = await this.tick(model);
          const merged = { ...r, changed: [...new Set([...retry, ...r.changed])].sort() };
          try {
            await onTick(merged);
            retry = [];
          } catch {
            retry = merged.changed;
          }
        }
      } catch {
        // 모델을 못 읽었다(DB 장애 등) — 들던 값을 지키고 다음 바퀴를 기다린다.
      }
      if (this.#stopped) return;
      const j = this.o.jitter ?? 0.1;
      const spread = 1 + j * (2 * (this.o.random ?? Math.random)() - 1);
      this.#timer = setTimeout(() => { void loop(); }, Math.max(100, Math.round(this.o.intervalMs * spread)));
      this.#timer.unref?.();
    };
    void loop();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
  }
}

function dedupe(list: readonly DiscoveredAddress[]): DiscoveredAddress[] {
  const m = new Map(list.map((e) => [`${e.host}|${e.port}`, e]));
  return [...m.values()].sort((a, b) => (a.host === b.host ? a.port - b.port : a.host < b.host ? -1 : 1));
}
