/**
 * 액세스 로그 수집 (2026-11-22).
 *
 * 엔진의 고리(`src/conf/access-log.ts`)를 주기마다 읽어 **이 노드의 메모리**에 둔다. DB 에는 안 쓴다 —
 * 트래픽 통계와 같은 판단이다. 최근 요청을 보는 것이 목적이고, 오래 남기려면 내보내기를 쓴다.
 *
 * ── 순번
 *
 *   엔진은 평면마다 `seq` 를 센다. 데몬은 평면마다 마지막에 읽은 순번을 들고, 그 뒤만 묻는다.
 *   `boot` 가 바뀌거나 `seq` 가 줄면 엔진이 다시 뜬 것이다 — 처음부터 다시 센다.
 *   두 번 묻는 사이에 고리가 한 바퀴를 넘게 돌면 그만큼은 못 읽는다. 그 수를 `dropped` 에 센다.
 *
 * ── 이름 풀기
 *
 *   엔진은 nginx 쪽 이름을 적는다(upstream 이름, `ip:port`). 데몬이 모델로 리소스 이름을 찾는다.
 *   못 찾은 것은 `null` 이다 — 이름을 짓지 않는다. 엔진이 적은 주소는 `upstreamAddr` 로 그대로 남는다.
 */
import { upstreamName } from '../conf/render.js';
import { parseAccessDump, type RawAccess } from '../conf/access-log.js';
import type { AccessAfter, TrafficDump } from '../dp/apply.js';
import type { Model } from '../model/provisional.js';
import { resolvePeer } from './membership.js';
import { canonicalPeer } from './traffic.js';

/** API 가 내는 한 줄. */
export type AccessEntry = {
  /** 줄의 이름. 엔진이 다시 뜨기 전까지 같다 — `h<boot>-<seq>` · `s<boot>-<seq>`. */
  id: string;
  /** 이 노드에서 받은 차례. 쪽 넘기기(`before` · `after`)에 쓴다. 데몬이 다시 뜨면 처음부터다. */
  cursor: number;
  /** 요청이 시작한 시각 (ISO). */
  at: string;
  plane: 'http' | 'stream';
  /** `http` · `tcp` · `udp`. http 평면은 TLS 를 풀었어도 `http` 다. */
  transport: 'http' | 'tcp' | 'udp';
  node?: string;
  client: string | null;
  method: string | null;
  host: string | null;
  /** 경로. 쿼리 문자열은 엔진이 이미 뺐다. */
  path: string | null;
  protocol: string | null;
  /** 클라이언트가 받은 상태. stream 은 nginx 의 세션 상태(200 · 400 · 502 …)다. */
  status: number;
  /** 백엔드가 준 상태. 백엔드를 거치지 않았으면 `null` 이다. */
  upstreamStatus: number | null;
  durationMs: number | null;
  timing: { connectMs: number | null; headerMs: number | null };
  bytesIn: number;
  bytesOut: number;
  listener: string | null;
  route: { kind: 'httpRoute' | 'passthroughRoute'; key: string } | null;
  pool: string | null;
  backend: string | null;
  /** 엔진이 고른 백엔드 주소 그대로. 이름을 못 풀어도 남는다. */
  upstreamAddr: string | null;
  requestId: string | null;
  tls: { sni: string | null; version: string | null } | null;
  userAgent: string | null;
  referer: string | null;
  forwardedFor: string | null;
};

export type AccessFilter = {
  /** 상태 계열 — `2xx` 같은 것. 비면 모두. */
  classes?: readonly string[];
  listener?: string;
  route?: string;
  pool?: string;
  backend?: string;
  /** 경로 · 호스트 · 클라이언트 · 요청 ID · 줄 이름에서 찾는다. 대소문자를 가리지 않는다. */
  q?: string;
};

export type AccessPage = {
  /** 새 것부터. */
  entries: AccessEntry[];
  /** 지금 가진 가장 새 줄의 `cursor`. 실시간으로 볼 때 다음 `after` 로 쓴다. 없으면 0. */
  cursor: number;
  /** `before` 로 더 오래된 쪽을 볼 수 있는가. */
  more: boolean;
};

export type AccessState =
  | { state: 'unsupported'; reason: string }
  | { state: 'unavailable'; reason: string }
  | { state: 'ok' };

export type AccessLogOptions = {
  /** 엔진 고리를 읽는다. 없으면 `unsupported` 다. */
  read?: (after: AccessAfter) => Promise<TrafficDump>;
  model: () => Promise<Model>;
  lua: () => { http: boolean; stream: boolean };
  node?: string;
  intervalMs?: number;
  /** 몇 줄을 둘까. 기본 10000 줄. */
  keep?: number;
  now?: () => number;
  resolve?: (hp: string) => Promise<string>;
};

export const DEFAULT_ACCESS_INTERVAL_MS = 2_000;
export const DEFAULT_ACCESS_KEEP = 10_000;
/** 한 주기에 평면마다 몇 번까지 이어 묻나. 엔진은 한 번에 많아야 1000 줄을 준다. */
const MAX_ROUNDS = 5;
/** 백엔드 주소 → 이름 표를 다시 만드는 간격. DNS 를 주기마다 묻지 않는다. */
const NAMES_TTL_MS = 30_000;

const CLASSES = ['1xx', '2xx', '3xx', '4xx', '5xx'] as const;
export const isStatusClass = (s: string): boolean => (CLASSES as readonly string[]).includes(s);

type Names = {
  at: number;
  sig: string;
  listeners: Set<string>;
  httpRoutes: Set<string>;
  ptRoutes: Set<string>;
  poolOfUpstream: Map<string, string>;
  backendsByPeer: Map<string, { pool: string; key: string }[]>;
};

export class AccessLogCollector {
  readonly intervalMs: number;
  readonly keep: number;
  private readonly entries: AccessEntry[] = [];
  private nextCursor = 1;
  private readonly seen: Partial<Record<'http' | 'stream', { boot: string; seq: number }>> = {};
  private droppedCount = 0;
  private lastError: string | undefined;
  private polled = false;
  private timer: NodeJS.Timeout | undefined;
  private names: Names | undefined;
  private readonly now: () => number;
  private readonly resolve: (hp: string) => Promise<string>;

  constructor(private readonly opts: AccessLogOptions) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_ACCESS_INTERVAL_MS;
    this.keep = Math.max(1, opts.keep ?? DEFAULT_ACCESS_KEEP);
    this.now = opts.now ?? Date.now;
    this.resolve = opts.resolve ?? resolvePeer;
  }

  start(): void {
    if (this.timer !== undefined || this.opts.read === undefined) return;
    // 주기 안의 실패로 데몬이 죽지 않게 한다 — 트래픽 표본과 같은 규칙이다 (2026-11-22, web-01).
    const run = (): void => {
      this.tick().catch((e: unknown) => {
        this.lastError = `액세스 로그를 못 읽었다: ${e instanceof Error ? e.message : String(e)}`;
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

  state(): AccessState {
    const lua = this.opts.lua();
    if (this.opts.read === undefined || (!lua.http && !lua.stream)) {
      return { state: 'unsupported', reason: '엔진에 Lua 가 없다 — 액세스 로그는 OpenResty 에서만 적는다' };
    }
    if (this.lastError !== undefined && !this.polled) return { state: 'unavailable', reason: this.lastError };
    return { state: 'ok' };
  }

  /** 고리가 한 바퀴를 넘게 돌아 못 읽은 줄 수. 데몬이 뜬 뒤로 센다. */
  dropped(): number {
    return this.droppedCount;
  }

  /** 가진 줄의 수와 처음 · 끝 시각. */
  window(): { kept: number; from?: string; to?: string } {
    const first = this.entries[0];
    const last = this.entries[this.entries.length - 1];
    return {
      kept: this.entries.length,
      ...(first === undefined ? {} : { from: first.at }),
      ...(last === undefined ? {} : { to: last.at }),
    };
  }

  /** 한 주기. 테스트가 직접 부른다. */
  async tick(): Promise<void> {
    if (this.opts.read === undefined) return;
    const lua = this.opts.lua();
    const planes = (['http', 'stream'] as const).filter((p) => lua[p]);
    let model: Model | undefined;
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const after: AccessAfter = {};
      for (const p of planes) after[p] = this.seen[p]?.seq ?? 0;
      let dump: TrafficDump;
      try {
        dump = await this.opts.read(after);
      } catch (e) {
        this.lastError = `엔진 고리를 못 읽었다: ${e instanceof Error ? e.message : String(e)}`;
        return;
      }
      if (planes.every((p) => dump[p] === undefined)) {
        this.lastError = '엔진 admin 이 액세스 로그를 안 줬다 (admin 소켓이 없거나 엔진이 멈췄다)';
        return;
      }
      model ??= await this.opts.model();
      const names = await this.namesFor(model);
      let again = false;
      for (const p of planes) {
        const text = dump[p];
        if (text === undefined) continue;
        const parsed = parseAccessDump(text);
        if (parsed === undefined) continue;
        const prev = this.seen[p];
        // 엔진이 다시 떴다 — 순번이 처음부터다. 이번 답은 옛 순번 뒤를 물은 것이니 버리고 다시 묻는다.
        if (prev !== undefined && (parsed.boot !== prev.boot || parsed.seq < prev.seq)) {
          this.seen[p] = { boot: parsed.boot, seq: 0 };
          again = true;
          continue;
        }
        const base = prev?.seq ?? 0;
        // 머리(`seq`)보다 새 줄은 받지 않는다. 덤프하는 사이에 다른 요청이 그 칸을 덮어쓴 것이다 — 받으면 순번이 앞질러
        // 그 사이의 줄을 영영 건너뛴다. 다음 주기에 제자리에서 받는다.
        const fresh = parsed.entries.filter((e) => e.q > base && e.q <= parsed.seq);
        const first = fresh[0]?.q;
        if (prev !== undefined && first !== undefined && first > base + 1) this.droppedCount += first - base - 1;
        for (const e of fresh) this.push(this.entryOf(p, parsed.boot, e, names));
        const top = fresh.length === 0 ? base : fresh[fresh.length - 1]!.q;
        this.seen[p] = { boot: parsed.boot, seq: Math.max(base, top) };
        if (top < parsed.seq) again = true;
      }
      this.polled = true;
      this.lastError = undefined;
      if (!again) return;
    }
  }

  private push(e: AccessEntry): void {
    this.entries.push(e);
    if (this.entries.length > this.keep) this.entries.splice(0, this.entries.length - this.keep);
  }

  private async namesFor(model: Model): Promise<Names> {
    const at = this.now();
    // 모델의 이름 집합이 같고 표가 젊으면 그대로 쓴다. DNS 는 주기마다 묻지 않는다.
    const sig = JSON.stringify([
      model.listeners.map((l) => l.key), model.httpRoutes.map((r) => r.key), model.passthroughRoutes.map((r) => r.key),
      model.pools.map((p) => p.key), model.backends.map((b) => `${b.key}@${b.pool}=${b.host}:${b.port}`),
    ]);
    if (this.names !== undefined && this.names.sig === sig && at - this.names.at < NAMES_TTL_MS) return this.names;
    const backendsByPeer = new Map<string, { pool: string; key: string }[]>();
    const cache = new Map<string, string>();
    for (const b of model.backends) {
      const hp = `${b.host}:${b.port}`;
      let peer = cache.get(hp);
      if (peer === undefined) {
        try { peer = canonicalPeer(await this.resolve(hp)); } catch { peer = canonicalPeer(hp); }
        cache.set(hp, peer);
      }
      const list = backendsByPeer.get(peer) ?? [];
      list.push({ pool: b.pool, key: b.key });
      backendsByPeer.set(peer, list);
    }
    this.names = {
      at,
      sig,
      listeners: new Set(model.listeners.map((l) => l.key)),
      httpRoutes: new Set(model.httpRoutes.map((r) => r.key)),
      ptRoutes: new Set(model.passthroughRoutes.map((r) => r.key)),
      poolOfUpstream: new Map(model.pools.map((p) => [upstreamName(p.key), p.key])),
      backendsByPeer,
    };
    return this.names;
  }

  private entryOf(plane: 'http' | 'stream', boot: string, e: RawAccess, n: Names): AccessEntry {
    const lkey = e.l === undefined ? undefined : e.l.endsWith('~http') ? e.l.slice(0, -'~http'.length) : e.l;
    const listener = lkey !== undefined && n.listeners.has(lkey) ? lkey : null;
    let route: AccessEntry['route'] = null;
    if (e.r !== undefined) {
      if (plane === 'http' && n.httpRoutes.has(e.r)) route = { kind: 'httpRoute', key: e.r };
      if (plane === 'stream' && n.ptRoutes.has(e.r)) route = { kind: 'passthroughRoute', key: e.r };
    }
    const pool = e.p === undefined ? null : n.poolOfUpstream.get(e.p) ?? null;
    let backend: string | null = null;
    if (e.ua !== undefined) {
      const cands = n.backendsByPeer.get(canonicalPeer(e.ua)) ?? [];
      const hit = pool === null ? (cands.length === 1 ? cands[0] : undefined) : cands.find((x) => x.pool === pool);
      backend = hit?.key ?? null;
    }
    const ms = (s: number | undefined): number | null => (s === undefined ? null : Math.round(s * 1000 * 1000) / 1000);
    const tls = e.sni !== undefined || e.tv !== undefined ? { sni: e.sni ?? null, version: e.tv ?? null } : null;
    return {
      id: `${plane === 'http' ? 'h' : 's'}${boot.replace(/[^0-9]/g, '')}-${e.q}`,
      cursor: this.nextCursor++,
      at: new Date(Math.round(e.t * 1000)).toISOString(),
      plane,
      transport: plane === 'http' ? 'http' : e.tr ?? 'tcp',
      ...(this.opts.node === undefined ? {} : { node: this.opts.node }),
      client: e.c ?? null,
      method: e.m ?? null,
      host: e.h ?? null,
      path: e.u ?? null,
      protocol: e.pr ?? null,
      status: e.s,
      upstreamStatus: e.us ?? null,
      durationMs: ms(e.d),
      timing: { connectMs: ms(e.uc), headerMs: ms(e.uh) },
      bytesIn: e.bi ?? 0,
      bytesOut: e.bo ?? 0,
      listener,
      route,
      pool,
      backend,
      upstreamAddr: e.ua ?? null,
      requestId: e.id ?? null,
      tls,
      userAgent: e.ag ?? null,
      referer: e.rf ?? null,
      forwardedFor: e.xf ?? null,
    };
  }

  /**
   * 줄을 거르고 쪽으로 낸다. 새 것부터.
   *
   *   `before` 그 cursor 보다 오래된 것 (다음 쪽)
   *   `after`  그 cursor 보다 새 것 (실시간)
   */
  list(f: AccessFilter, page: { limit: number; before?: number; after?: number }): AccessPage {
    const q = f.q?.trim().toLowerCase();
    const match = (e: AccessEntry): boolean => {
      if (f.classes !== undefined && f.classes.length > 0 && !f.classes.includes(`${Math.floor(e.status / 100)}xx`)) return false;
      if (f.listener !== undefined && e.listener !== f.listener) return false;
      if (f.route !== undefined && e.route?.key !== f.route) return false;
      if (f.pool !== undefined && e.pool !== f.pool) return false;
      if (f.backend !== undefined && e.backend !== f.backend) return false;
      if (q !== undefined && q !== '') {
        const hay = `${e.path ?? ''} ${e.host ?? ''} ${e.client ?? ''} ${e.requestId ?? ''} ${e.id} ${e.tls?.sni ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    };
    const out: AccessEntry[] = [];
    let more = false;
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      const e = this.entries[i]!;
      if (page.before !== undefined && e.cursor >= page.before) continue;
      if (page.after !== undefined && e.cursor <= page.after) break;
      if (!match(e)) continue;
      if (out.length === page.limit) { more = true; break; }
      out.push(e);
    }
    const lastE = this.entries[this.entries.length - 1];
    return { entries: out, cursor: lastE?.cursor ?? 0, more };
  }

  get(id: string): AccessEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i -= 1) if (this.entries[i]!.id === id) return this.entries[i];
    return undefined;
  }
}

/** 내보내기의 CSV 칸. 줄 하나가 한 행이다. */
export const ACCESS_CSV_COLUMNS = [
  'id', 'at', 'node', 'transport', 'client', 'method', 'host', 'path', 'protocol', 'status', 'upstreamStatus',
  'durationMs', 'connectMs', 'headerMs', 'bytesIn', 'bytesOut', 'listener', 'routeKind', 'route', 'pool',
  'backend', 'upstreamAddr', 'requestId', 'sni', 'tlsVersion', 'userAgent', 'referer', 'forwardedFor',
] as const;

/**
 * CSV 한 행. 수식 주입을 막는다 — `=` `+` `-` `@` 로 시작하는 칸은 앞에 `'` 를 붙인다(스프레드시트가 식으로 읽는다).
 */
export function accessCsvRow(e: AccessEntry): string {
  const v: Record<(typeof ACCESS_CSV_COLUMNS)[number], string | number | null | undefined> = {
    id: e.id, at: e.at, node: e.node, transport: e.transport, client: e.client, method: e.method, host: e.host,
    path: e.path, protocol: e.protocol, status: e.status, upstreamStatus: e.upstreamStatus, durationMs: e.durationMs,
    connectMs: e.timing.connectMs, headerMs: e.timing.headerMs, bytesIn: e.bytesIn, bytesOut: e.bytesOut,
    listener: e.listener, routeKind: e.route?.kind, route: e.route?.key, pool: e.pool, backend: e.backend,
    upstreamAddr: e.upstreamAddr, requestId: e.requestId, sni: e.tls?.sni, tlsVersion: e.tls?.version,
    userAgent: e.userAgent, referer: e.referer, forwardedFor: e.forwardedFor,
  };
  return ACCESS_CSV_COLUMNS.map((k) => {
    const x = v[k];
    if (x === null || x === undefined) return '';
    if (typeof x === 'number') return String(x);
    const safe = /^[=+\-@\t\r]/.test(x) ? `'${x}` : x;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  }).join(',');
}
