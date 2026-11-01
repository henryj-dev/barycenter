/**
 * 전역 모드의 중계 (docs/design-global-mode.md §2.3·§2.4 · §1.1).
 *
 * **해석하지 않고 넘긴다.** 전역이 지역 응답의 모양을 알면 두 벌이 되고, 지역 버전이
 * 다르면 그 사이에서 깨진다. 요약(`/regions`)도 지역의 `status` 를 **그대로** 싣는다.
 *
 * **보는 사람의 자격으로 넘긴다** (2026-11-01 사용자 결정). 전역과 지역은 계정 PG 를 함께 쓰므로, 전역에 로그인한
 * 사람의 세션이 지역에서도 같은 사람이다. 쓰기는 그 자격으로만 넘긴다 — 권한·감사·step-up 은 지역이 판정한다.
 * 지역 auditor 토큰은 요약과 공유 SSE 상류(여럿이 나눠 보는 것)에만 쓴다.
 *
 * **메서드와 경로를 하나씩 적는다**(`RELAY_ROUTES`). 받은 메서드를 그대로 넘기는 일반 프록시는 두지 않는다.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Agent, request } from 'node:https';

import type { Region } from './registry.js';

/**
 * 중계를 허락하는 지역 API 경로 (`/api/v1/` 뒤). 지금 GUI 가 읽는 것들이다.
 *
 * `config/export`·`backup` 은 **일부러 뺀다.** 화면에 필요 없고, 전역을 지나는 순간
 * 모든 지역의 전체 설정이 한 곳에 모인다.
 */
export const RELAY_PATHS: readonly string[] = [
  'status', 'listeners', 'pools', 'backends', 'backends/status', 'routes',
  'certificates', 'tls-policies', 'sni-bindings', 'acme/orders', 'audit',
  'config/rendered', 'events',
  // 쓰기 흐름과 운영 화면이 읽는 것 (2026-11-01).
  'config/head', 'config/revisions', 'config/history', 'changesets/:id', 'plans/:id', 'operations/:id',
  'address-sets', 'cluster/nodes', 'cluster/nodes/:node/history', 'system/addresses', 'acme/accounts',
  'acme/orders/:id', 'sockets', 'health/backends',
];

/** 중계하는 쓰기 (`/api/v1/` 뒤). 범위는 지역 라우트와 같다 — 전역이 먼저 거르고, 지역이 다시 판정한다. */
export const RELAY_WRITES: readonly { method: 'POST' | 'PATCH' | 'DELETE'; path: string; scope: 'write' | 'apply' }[] = [
  { method: 'POST', path: 'changesets', scope: 'write' },
  { method: 'PATCH', path: 'changesets/:id', scope: 'write' },
  { method: 'DELETE', path: 'changesets/:id', scope: 'write' },
  { method: 'POST', path: 'changesets/:id/plan', scope: 'write' },
  { method: 'POST', path: 'changesets/:id/reopen', scope: 'write' },
  { method: 'POST', path: 'changesets/:id/commit', scope: 'write' },
  { method: 'POST', path: 'certificates/material', scope: 'write' },
  { method: 'POST', path: 'acme/accounts', scope: 'write' },
  { method: 'POST', path: 'backends/:id/drain', scope: 'write' },
  { method: 'DELETE', path: 'backends/:id/drain', scope: 'write' },
  { method: 'POST', path: 'apply', scope: 'apply' },
  { method: 'POST', path: 'apply/retry', scope: 'apply' },
  { method: 'POST', path: 'apply/rerender', scope: 'apply' },
  { method: 'POST', path: 'rollback', scope: 'apply' },
  { method: 'POST', path: 'recover', scope: 'apply' },
  { method: 'POST', path: 'operations/:id/cancel', scope: 'apply' },
];

/** 지역에 보낼 보는 사람의 자격. `Session` 은 계정 세션 id 다(`Authorization: Session <id>`). */
export type Credential = { kind: 'bearer'; token: string } | { kind: 'session'; id: string };

/** 지역으로 넘길 요청 하나. `path` 는 `/api/v1/` 뒤, 이미 값이 채워진 것이다. */
export type Forward = {
  method: string;
  path: string;
  search: string;
  /** JSON 본문. 없으면 본문 없이 보낸다. */
  body?: unknown;
  credential?: Credential;
  /** 지역이 낙관적 잠금에 쓴다(changeset PATCH). */
  ifMatch?: string;
  /** 사람의 주소. 지역의 `BARY_TRUSTED_PROXIES` 에 전역이 있으면 지역이 시도 제한·감사에 쓴다. */
  clientIp?: string;
};

const SUMMARY_TIMEOUT_MS = 3_000;
const RELAY_TIMEOUT_MS = 10_000;
/** 지역 응답 상한 — 원격 DP 드라이버와 같은 이유다(받는 쪽이 적고 하나가 여럿을 본다). */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export type RegionSummary = {
  name: string;
  gui: string;
  /** 연결·TLS·타임아웃까지 지나 HTTP 응답을 받았는가. */
  reachable: boolean;
  /** 401·403 — 인증서·tokens.json 설정 문제다. 장애와 섞지 않는다. */
  auth?: 'rejected';
  /** 200 일 때만. 지역의 `/api/v1/status` 본문 그대로. */
  status?: unknown;
  /** 지역이 말한 설치 판(commit). 지역이 말하지 않으면 null — 모른다. 200 일 때만. */
  regionBuild?: string | null;
  /** 전역과 지역의 판이 다르다. 둘 다 알 때만 싣는다. */
  buildMismatch?: boolean;
  /** 이번 관측 시각 (200 일 때만). */
  observedAt?: string;
  /** 마지막으로 200 을 받은 시각. **못 닿았을 때 지금 값처럼 보이지 않게** 따로 싣는다. */
  lastOkAt?: string;
  /** 못 닿았거나 비-200 일 때 이유. */
  error?: string;
};

type Fetched = { status: number; contentType: string; body: Buffer };

export class RegionRelay {
  readonly regions: readonly Region[];
  readonly #byName: Map<string, { region: Region; agent: Agent }>;
  readonly #lastOk = new Map<string, string>();
  readonly #streams = new Map<string, SharedStream>();
  readonly #now: () => Date;
  readonly #ownCommit: string | undefined;

  /**
   * @param ownCommit 전역 자신의 설치 판. 지역 판과 다르면 요약에 `buildMismatch` 를 단다
   *   (설계 §2.4.1). 모르면(undefined) 비교하지 않는다 — 모르는 것을 「같다」로 접지 않는다.
   */
  constructor(regions: readonly Region[], opts: { now?: () => Date; ownCommit?: string } = {}) {
    this.regions = regions;
    this.#now = opts.now ?? (() => new Date());
    this.#ownCommit = opts.ownCommit;
    this.#byName = new Map(regions.map((r) => [r.name, {
      region: r,
      // `rejectUnauthorized` 를 끄는 길을 안 만든다 — 원격 DP 드라이버와 같다.
      agent: new Agent({ ca: r.ca, rejectUnauthorized: true, keepAlive: true }),
    }]));
  }

  has(name: string): boolean {
    return this.#byName.has(name);
  }

  /** 지역마다 독립 타임아웃으로 동시에 묻는다. 하나가 느려도 전체가 기다리지 않는다. */
  async summary(): Promise<RegionSummary[]> {
    return Promise.all(this.regions.map(async (r): Promise<RegionSummary> => {
      const base = { name: r.name, gui: r.gui };
      const last = (): { lastOkAt?: string } => {
        const v = this.#lastOk.get(r.name);
        return v === undefined ? {} : { lastOkAt: v };
      };
      let got: Fetched;
      try {
        got = await this.#get(r.name, 'status', '', SUMMARY_TIMEOUT_MS);
      } catch (e) {
        return { ...base, reachable: false, ...last(), error: messageOf(e) };
      }
      if (got.status === 401 || got.status === 403) {
        return { ...base, reachable: true, auth: 'rejected', ...last(), error: `지역이 ${got.status} 로 거절했다` };
      }
      if (got.status !== 200) {
        return { ...base, reachable: true, ...last(), error: `지역이 ${got.status} 를 냈다` };
      }
      let status: unknown;
      try {
        status = JSON.parse(got.body.toString('utf8'));
      } catch {
        return { ...base, reachable: true, ...last(), error: '지역 status 가 JSON 이 아니다' };
      }
      // **이름을 맞춰 본다** (docs/adr-host-dispatch.md). 목록에 이름을 잘못 적으면 다른 지역을 그 이름으로 보인다.
      // 지역이 이름을 말하지 않으면(`BARY_REGION` 없음) 비교하지 않는다 — 모르는 것을 「같다」로 접지 않는다.
      const said = (status as { region?: unknown } | null)?.region;
      if (typeof said === 'string' && said !== r.name) {
        return { ...base, reachable: true, ...last(), error: `지역이 자기 이름을 '${said}' 라고 한다 — 목록의 '${r.name}' 과 다르다` };
      }
      const at = this.#now().toISOString();
      this.#lastOk.set(r.name, at);
      return { ...base, reachable: true, status, observedAt: at, lastOkAt: at, ...this.#mismatch(status) };
    }));
  }

  /**
   * `GET /api/v1/regions/:name/<path>` 를 지역의 `GET /api/v1/<path>` 로 넘긴다.
   * 상태 코드와 본문은 그대로. 못 닿으면 502 `region_unreachable` — 지역이 판정한
   * 것과 우리가 못 물은 것을 섞지 않는다.
   */
  async relay(name: string, path: string, search: string, res: ServerResponse): Promise<void> {
    await this.forward(name, { method: 'GET', path, search }, res);
  }

  /**
   * 요청 하나를 지역으로 넘긴다. 자격을 주면 그것으로, 없으면 지역 auditor 토큰으로 묻는다 — **GET 만**.
   * 쓰기에 자격이 없으면 보내지 않는다(403) — auditor 로 쓰기를 시도하지 않는다.
   */
  async forward(name: string, f: Forward, res: ServerResponse): Promise<void> {
    if (f.method !== 'GET' && f.credential === undefined) {
      sendJson(res, 403, {
        code: 'no_forwardable_credential',
        message: '전역에서 지역을 고치려면 계정으로 로그인하거나 그 지역에도 있는 토큰으로 들어온다',
      });
      return;
    }
    let got: Fetched;
    try {
      got = await this.#send(name, f, RELAY_TIMEOUT_MS);
    } catch (e) {
      sendJson(res, 502, { code: 'region_unreachable', region: name, message: messageOf(e) });
      return;
    }
    res.writeHead(got.status, {
      'content-type': got.contentType,
      'content-length': String(got.body.length),
      'cache-control': 'no-store',
    });
    res.end(got.body);
  }

  /**
   * SSE 중계 — **지역마다 상류 하나를 보는 사람 전원이 나눠 쓴다** (설계 §2.3.1).
   */
  relayEvents(name: string, req: IncomingMessage, res: ServerResponse): void {
    const entry = this.#byName.get(name);
    if (entry === undefined) {
      sendJson(res, 404, { code: 'no_region', message: `지역 '${name}' 은 목록에 없다` });
      return;
    }
    let stream = this.#streams.get(name);
    if (stream === undefined) {
      stream = new SharedStream(
        () => request(`${entry.region.api}/api/v1/events`, {
          method: 'GET',
          agent: entry.agent,
          headers: { authorization: `Bearer ${entry.region.token}`, accept: 'text/event-stream' },
        }),
        name,
        () => this.#streams.delete(name),
      );
      this.#streams.set(name, stream);
    }
    stream.join(req, res);
  }

  close(): void {
    for (const s of [...this.#streams.values()]) s.shutdown();
  }

  /**
   * 판 비교 — 지역 `status.build.commit` 하나만 읽는다(본문의 나머지는 해석하지 않는다).
   * 지역이 판을 안 말하면(옛 판) `regionBuild: null` 로 「모른다」를 싣는다.
   */
  #mismatch(status: unknown): { regionBuild: string | null; buildMismatch?: boolean } {
    const build = (status as { build?: { commit?: unknown } | null } | null)?.build;
    const commit = typeof build?.commit === 'string' ? build.commit : null;
    if (commit === null) return { regionBuild: null };
    if (this.#ownCommit === undefined) return { regionBuild: commit };
    return { regionBuild: commit, buildMismatch: commit !== this.#ownCommit };
  }

  #get(name: string, path: string, search: string, timeoutMs: number): Promise<Fetched> {
    return this.#send(name, { method: 'GET', path, search }, timeoutMs);
  }

  #send(name: string, f: Forward, timeoutMs: number): Promise<Fetched> {
    const entry = this.#byName.get(name);
    if (entry === undefined) return Promise.reject(new Error(`지역 '${name}' 은 목록에 없다`));
    const body = f.body === undefined ? undefined : Buffer.from(JSON.stringify(f.body), 'utf8');
    const authorization = f.credential === undefined ? `Bearer ${entry.region.token}`
      : f.credential.kind === 'bearer' ? `Bearer ${f.credential.token}` : `Session ${f.credential.id}`;
    const headers: Record<string, string> = {
      authorization, accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(body.length) }),
      ...(f.ifMatch === undefined ? {} : { 'if-match': f.ifMatch }),
      ...(f.clientIp === undefined ? {} : { 'x-forwarded-for': f.clientIp }),
    };
    return new Promise<Fetched>((resolve, reject) => {
      const req = request(`${entry.region.api}/api/v1/${f.path}${f.search}`, {
        method: f.method,
        agent: entry.agent,
        timeout: timeoutMs,
        headers,
      }, (r) => {
        const chunks: Buffer[] = [];
        let size = 0;
        r.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_RESPONSE_BYTES) {
            r.destroy();
            reject(new Error(`지역 응답이 ${MAX_RESPONSE_BYTES}바이트를 넘는다`));
            return;
          }
          chunks.push(c);
        });
        r.on('end', () => resolve({
          status: r.statusCode ?? 0,
          contentType: r.headers['content-type'] ?? 'application/octet-stream',
          body: Buffer.concat(chunks),
        }));
        r.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error(`${timeoutMs}ms 안에 응답이 없다`)));
      req.on('error', reject);
      req.end(body);
    });
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 상류가 끊긴 뒤 재접속하지 않는다 — 보는 사람의 GUI 가 다시 붙고, 그때 새로 연다. */
const REPLAY_MAX = 1000;
const IDLE_CLOSE_MS = 10_000;

/**
 * 지역 하나의 SSE 상류와 그것을 나눠 받는 사람들.
 *
 * GUI 는 `snapshot` 을 **전체 교체**로, 그 밖의 이벤트를 델타로 읽는다. 그래서 늦게 들어온
 * 사람에게 **마지막 snapshot + 그 뒤 이벤트**를 먼저 주면 처음부터 본 사람과 같은 상태다.
 * 기록이 `REPLAY_MAX` 를 넘으면 상류를 다시 연다 — 새 snapshot 이 오고 기록이 비워진다.
 */
class SharedStream {
  readonly #open: () => ReturnType<typeof request>;
  readonly #name: string;
  readonly #onGone: () => void;
  readonly #subs = new Set<ServerResponse>();
  #up: ReturnType<typeof request> | undefined;
  /** 상류가 200 으로 열렸는가. 열리기 전 들어온 사람은 헤더를 기다린다. */
  #live = false;
  #replay: string[] = [];
  #buf = '';
  #idle: NodeJS.Timeout | undefined;
  #gone = false;

  constructor(open: () => ReturnType<typeof request>, name: string, onGone: () => void) {
    this.#open = open;
    this.#name = name;
    this.#onGone = onGone;
    this.#connect();
  }

  join(req: IncomingMessage, res: ServerResponse): void {
    if (this.#idle !== undefined) {
      clearTimeout(this.#idle);
      this.#idle = undefined;
    }
    this.#subs.add(res);
    if (this.#live) this.#greet(res);
    req.on('close', () => this.#leave(res));
  }

  shutdown(): void {
    if (this.#gone) return;
    this.#gone = true;
    if (this.#idle !== undefined) clearTimeout(this.#idle);
    this.#up?.destroy();
    for (const r of this.#subs) r.end();
    this.#subs.clear();
    this.#onGone();
  }

  #greet(res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    for (const frame of this.#replay) res.write(frame);
  }

  #leave(res: ServerResponse): void {
    this.#subs.delete(res);
    if (this.#subs.size > 0 || this.#gone) return;
    this.#idle = setTimeout(() => this.shutdown(), IDLE_CLOSE_MS);
    this.#idle.unref();
  }

  #connect(): void {
    this.#live = false;
    this.#replay = [];
    this.#buf = '';
    const up = this.#open();
    this.#up = up;
    // **옛 상류의 마지막 신호가 새 상류를 닫지 않게** 한다 — 기록이 넘쳐 다시 열 때 옛
    // 연결을 끊으면 그 연결의 end·error 가 뒤늦게 온다.
    const current = (): boolean => this.#up === up && !this.#gone;
    up.on('response', (r) => {
      if (!current()) { r.resume(); return; }
      if (r.statusCode !== 200) {
        // 스트림이 아니면 본문을 그대로 기다리던 사람 전원에게 넘기고 닫는다 (401·403·5xx).
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => {
          const body = Buffer.concat(chunks);
          for (const s of this.#subs) {
            if (!s.headersSent) s.writeHead(r.statusCode ?? 502, { 'content-type': r.headers['content-type'] ?? 'application/json' });
            s.end(body);
          }
          this.#subs.clear();
          this.shutdown();
        });
        return;
      }
      this.#live = true;
      for (const s of this.#subs) if (!s.headersSent) this.#greet(s);
      r.setEncoding('utf8');
      r.on('data', (chunk: string) => { if (current()) this.#feed(chunk); });
      r.on('end', () => { if (current()) this.shutdown(); });
      r.on('error', () => { if (current()) this.shutdown(); });
    });
    up.on('error', (e) => {
      if (!current()) return;
      for (const s of this.#subs) {
        if (!s.headersSent) sendJson(s, 502, { code: 'region_unreachable', region: this.#name, message: e.message });
        else s.end();
      }
      this.#subs.clear();
      this.shutdown();
    });
    // 연결 수립까지만 타임아웃이다 — 열린 스트림은 오래 사는 것이 정상이다.
    up.setTimeout(RELAY_TIMEOUT_MS, () => {
      if (!this.#live) up.destroy(new Error(`${RELAY_TIMEOUT_MS}ms 안에 응답이 없다`));
    });
    up.end();
  }

  /** 프레임(빈 줄로 끝난다) 단위로 자른다. 바이트는 그대로 흘린다. */
  #feed(chunk: string): void {
    this.#buf += chunk;
    let at: number;
    while ((at = this.#buf.indexOf('\n\n')) !== -1) {
      const frame = this.#buf.slice(0, at + 2);
      this.#buf = this.#buf.slice(at + 2);
      for (const s of this.#subs) s.write(frame);
      // 하트비트(주석 줄뿐인 프레임)는 기록하지 않는다 — 다시 보낼 뜻이 없다.
      if (frame.split('\n').every((l) => l === '' || l.startsWith(':'))) continue;
      if (/^event: snapshot$/m.test(frame)) {
        this.#replay = [frame];
      } else {
        this.#replay.push(frame);
        if (this.#replay.length > REPLAY_MAX) {
          // 새 snapshot 으로 기록을 비운다. 보던 사람은 스냅샷을 한 번 더 받는다(교체라 해가 없다).
          const old = this.#up;
          this.#connect();
          old?.destroy();
          return;
        }
      }
    }
  }
}
