/**
 * 트래픽 통계 (2026-11-20).
 *
 * 엔진의 카운터(`src/conf/traffic.ts`)를 주기마다 읽어 **이 노드의 메모리**에 둔다. DB 에는
 * 안 쓴다 — 지난 한 시간을 보는 것이 목적이고, 재시작하면 비어도 된다.
 *
 * ── 무엇이 시계열이 되는가
 *
 *   카운터는 엔진이 뜬 뒤로 쌓인 합이다. 두 표본의 차이를 간격으로 나눈 것이 율이다.
 *   값이 줄면 엔진이 다시 떴다는 뜻이다(dict 는 프로세스 수명이다). 그때는 지금 값을
 *   그 사이의 증가로 본다 — Prometheus 의 `rate` 와 같은 규칙이다.
 *
 * ── 이름 풀기
 *
 *   카운터에는 nginx 쪽 이름이 있다(upstream 이름, `ip:port`). 데몬이 모델로 리소스 이름을 찾는다.
 *   못 찾은 것(예: 디스커버리가 찾은 백엔드)은 버린다 — 풀 수에는 이미 들어 있다.
 */
import { upstreamName } from '../conf/render.js';
import { parseTrafficDump, TRAFFIC_FIELDS, type TrafficField } from '../conf/traffic.js';
import type { TrafficDump } from '../dp/apply.js';
import type { Model } from '../model/provisional.js';
import { resolvePeer } from './membership.js';

/** API 가 쓰는 리소스 종류. 모델의 종류 이름과 같다. */
export type TrafficResourceKind = 'listener' | 'httpRoute' | 'passthroughRoute' | 'pool' | 'backend';
export const TRAFFIC_RESOURCE_KINDS: readonly TrafficResourceKind[] = [
  'listener', 'httpRoute', 'passthroughRoute', 'pool', 'backend',
];

type Values = Record<TrafficField, number>;

/** 표본 하나 — 리소스마다 누적값. 열쇠는 `<종류>\t<이름>` 이다. */
type Sample = { at: number; counters: Map<string, Values> };

/** 한 구간의 율. 표본 둘 사이다. */
export type TrafficPoint = {
  /** 구간이 끝난 시각 (ISO). */
  at: string;
  /** 초당 요청 (stream 은 초당 연결). */
  rps: number;
  /** 상태 계열별 초당 수. */
  status: { s1: number; s2: number; s3: number; s4: number; s5: number };
  /** 초당 받은 · 보낸 바이트. */
  bytesInPerS: number;
  bytesOutPerS: number;
  /** 평균 걸린 시간 (ms). 요청이 없으면 없다. */
  avgMs?: number;
};

/** 리소스 하나의 요약 — 마지막 구간의 율과 창 전체의 합. */
export type TrafficSummaryRow = {
  kind: TrafficResourceKind;
  key: string;
  last?: TrafficPoint;
  window: { requests: number; errors5xx: number; bytesIn: number; bytesOut: number; avgMs?: number };
};

export type TrafficState =
  | { state: 'unsupported'; reason: string }
  | { state: 'unavailable'; reason: string }
  | { state: 'ok' };

export type TrafficSamplerOptions = {
  /** 엔진 카운터를 읽는다. 없거나 Lua 가 없으면 `unsupported` 다. */
  read?: () => Promise<TrafficDump>;
  /** 지금 활성인 모델. 이름 풀기에 쓴다. */
  model: () => Promise<Model>;
  /** Lua 가 있는가 — 평면별. 둘 다 없으면 세지 않는 엔진이다. */
  lua: () => { http: boolean; stream: boolean };
  intervalMs?: number;
  /** 몇 개의 표본을 둘까. 기본 360 개(10 초 간격이면 한 시간). */
  keep?: number;
  now?: () => number;
  /** 이름 풀기의 DNS. 테스트가 갈아 끼운다. */
  resolve?: (hp: string) => Promise<string>;
};

export const DEFAULT_TRAFFIC_INTERVAL_MS = 10_000;
export const DEFAULT_TRAFFIC_KEEP = 360;

const zero = (): Values => Object.fromEntries(TRAFFIC_FIELDS.map((f) => [f, 0])) as Values;

/** `[::1]:80` 와 `::1:80` 을 같은 것으로 본다. */
export function canonicalPeer(hp: string): string {
  const cut = hp.lastIndexOf(':');
  if (cut <= 0) return hp;
  const host = hp.slice(0, cut);
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return `${bare.toLowerCase()}:${hp.slice(cut + 1)}`;
}

const slotOf = (kind: TrafficResourceKind, key: string): string => `${kind}\t${key}`;

export class TrafficSampler {
  readonly intervalMs: number;
  readonly keep: number;
  private readonly samples: Sample[] = [];
  private lastError: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly now: () => number;
  private readonly resolve: (hp: string) => Promise<string>;

  constructor(private readonly opts: TrafficSamplerOptions) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_TRAFFIC_INTERVAL_MS;
    this.keep = Math.max(2, opts.keep ?? DEFAULT_TRAFFIC_KEEP);
    this.now = opts.now ?? Date.now;
    this.resolve = opts.resolve ?? resolvePeer;
  }

  start(): void {
    if (this.timer !== undefined || this.opts.read === undefined) return;
    // **주기 안의 실패로 데몬이 죽지 않게 한다** (2026-11-22, web-01). `tick` 의 모델 읽기는 DB 를 탄다 — PG 연결이
    // 끊기자 처리되지 않은 rejection 이 되어 데몬이 세 번 죽었다. 표본 하나를 잃을 뿐이다. 다음 주기가 다시 읽는다.
    const run = (): void => {
      this.tick().catch((e: unknown) => {
        this.lastError = `표본을 못 만들었다: ${e instanceof Error ? e.message : String(e)}`;
      });
    };
    run();
    this.timer = setInterval(run, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 세는 엔진인가, 읽을 수 있는가. */
  state(): TrafficState {
    const lua = this.opts.lua();
    if (this.opts.read === undefined || (!lua.http && !lua.stream)) {
      return { state: 'unsupported', reason: '엔진에 Lua 가 없다 — 트래픽 카운터는 OpenResty 에서만 센다' };
    }
    if (this.lastError !== undefined && this.samples.length === 0) {
      return { state: 'unavailable', reason: this.lastError };
    }
    return { state: 'ok' };
  }

  /** 표본 하나를 읽는다. 테스트가 직접 부른다. */
  async tick(): Promise<void> {
    if (this.opts.read === undefined) return;
    let dump: TrafficDump;
    try {
      dump = await this.opts.read();
    } catch (e) {
      this.lastError = `엔진 카운터를 못 읽었다: ${e instanceof Error ? e.message : String(e)}`;
      return;
    }
    if (dump.http === undefined && dump.stream === undefined) {
      this.lastError = '엔진 admin 이 카운터를 안 줬다 (admin 소켓이 없거나 엔진이 멈췄다)';
      return;
    }
    const model = await this.opts.model();
    const counters = await this.resolveNames(model, dump);
    this.lastError = undefined;
    this.samples.push({ at: this.now(), counters });
    while (this.samples.length > this.keep) this.samples.shift();
  }

  private async resolveNames(model: Model, dump: TrafficDump): Promise<Map<string, Values>> {
    const out = new Map<string, Values>();
    const add = (kind: TrafficResourceKind, key: string, v: Partial<Values>): void => {
      const s = slotOf(kind, key);
      const cur = out.get(s) ?? zero();
      for (const f of TRAFFIC_FIELDS) cur[f] += v[f] ?? 0;
      out.set(s, cur);
    };
    const poolOfUpstream = new Map(model.pools.map((p) => [upstreamName(p.key), p.key]));
    const listeners = new Set(model.listeners.map((l) => l.key));
    const httpRoutes = new Set(model.httpRoutes.map((r) => r.key));
    const ptRoutes = new Set(model.passthroughRoutes.map((r) => r.key));
    // peer → 백엔드. 풀마다 따로 둔다 — 같은 주소가 두 풀에 있을 수 있다.
    const peerCache = new Map<string, string>();
    const backendsByPeer = new Map<string, { pool: string; key: string }[]>();
    for (const b of model.backends) {
      const hp = `${b.host}:${b.port}`;
      let peer = peerCache.get(hp);
      if (peer === undefined) {
        try { peer = canonicalPeer(await this.resolve(hp)); } catch { peer = canonicalPeer(hp); }
        peerCache.set(hp, peer);
      }
      const list = backendsByPeer.get(peer) ?? [];
      list.push({ pool: b.pool, key: b.key });
      backendsByPeer.set(peer, list);
    }

    for (const plane of ['http', 'stream'] as const) {
      const text = dump[plane];
      if (text === undefined) continue;
      for (const c of parseTrafficDump(text)) {
        switch (c.kind) {
          case 'listener': {
            // 평문 리다이렉트 소켓(`<리스너>~http`)은 그 리스너의 것이다.
            const key = c.id.endsWith('~http') ? c.id.slice(0, -'~http'.length) : c.id;
            if (listeners.has(key)) add('listener', key, c.values);
            break;
          }
          case 'route': {
            if (plane === 'http' && httpRoutes.has(c.id)) add('httpRoute', c.id, c.values);
            if (plane === 'stream' && ptRoutes.has(c.id)) add('passthroughRoute', c.id, c.values);
            break;
          }
          case 'pool': {
            const key = poolOfUpstream.get(c.id);
            if (key !== undefined) add('pool', key, c.values);
            break;
          }
          case 'backend': {
            const pool = c.upstream === undefined || c.upstream === '' ? undefined : poolOfUpstream.get(c.upstream);
            const cands = backendsByPeer.get(canonicalPeer(c.peer ?? '')) ?? [];
            const hit = pool === undefined
              ? (cands.length === 1 ? cands[0] : undefined)
              : cands.find((x) => x.pool === pool);
            if (hit !== undefined) add('backend', hit.key, c.values);
            break;
          }
        }
      }
    }
    return out;
  }

  /** 리소스 하나의 시계열. 표본이 둘 미만이면 비어 있다. */
  series(kind: TrafficResourceKind, key: string): TrafficPoint[] {
    const s = slotOf(kind, key);
    const points: TrafficPoint[] = [];
    for (let i = 1; i < this.samples.length; i += 1) {
      const a = this.samples[i - 1]!;
      const b = this.samples[i]!;
      points.push(pointBetween(a.counters.get(s), b.counters.get(s), a.at, b.at));
    }
    return points;
  }

  /** 모든 리소스의 요약. 종류로 거를 수 있다. */
  summary(kind?: TrafficResourceKind): TrafficSummaryRow[] {
    const keys = new Set<string>();
    for (const smp of this.samples) for (const k of smp.counters.keys()) keys.add(k);
    const rows: TrafficSummaryRow[] = [];
    for (const slot of [...keys].sort()) {
      const [k, key] = slot.split('\t') as [TrafficResourceKind, string];
      if (kind !== undefined && k !== kind) continue;
      const pts = this.series(k, key);
      const win = { requests: 0, errors5xx: 0, bytesIn: 0, bytesOut: 0, ms: 0 };
      for (let i = 1; i < this.samples.length; i += 1) {
        const d = delta(this.samples[i - 1]!.counters.get(slot), this.samples[i]!.counters.get(slot));
        win.requests += d.n; win.errors5xx += d.s5; win.bytesIn += d.bi; win.bytesOut += d.bo; win.ms += d.ms;
      }
      rows.push({
        kind: k, key,
        ...(pts.length === 0 ? {} : { last: pts[pts.length - 1]! }),
        window: {
          requests: win.requests, errors5xx: win.errors5xx, bytesIn: win.bytesIn, bytesOut: win.bytesOut,
          ...(win.requests === 0 ? {} : { avgMs: round(win.ms / win.requests) }),
        },
      });
    }
    return rows;
  }

  /** 창의 처음과 끝 (ISO). 표본이 없으면 없다. */
  window(): { from?: string; to?: string; samples: number } {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    return {
      samples: this.samples.length,
      ...(first === undefined ? {} : { from: new Date(first.at).toISOString() }),
      ...(last === undefined ? {} : { to: new Date(last.at).toISOString() }),
    };
  }
}

const round = (x: number): number => Math.round(x * 1000) / 1000;

/** 두 누적값의 차이. 줄었으면 엔진이 다시 뜬 것이다 — 지금 값을 증가로 본다. */
function delta(a: Values | undefined, b: Values | undefined): Values {
  const out = zero();
  if (b === undefined) return out;
  for (const f of TRAFFIC_FIELDS) {
    const prev = a?.[f] ?? 0;
    const cur = b[f];
    out[f] = cur >= prev ? cur - prev : cur;
  }
  return out;
}

function pointBetween(a: Values | undefined, b: Values | undefined, from: number, to: number): TrafficPoint {
  const d = delta(a, b);
  const secs = Math.max(0.001, (to - from) / 1000);
  const per = (x: number): number => round(x / secs);
  return {
    at: new Date(to).toISOString(),
    rps: per(d.n),
    status: { s1: per(d.s1), s2: per(d.s2), s3: per(d.s3), s4: per(d.s4), s5: per(d.s5) },
    bytesInPerS: per(d.bi),
    bytesOutPerS: per(d.bo),
    ...(d.n === 0 ? {} : { avgMs: round(d.ms / d.n) }),
  };
}
