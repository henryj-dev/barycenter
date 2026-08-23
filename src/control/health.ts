/**
 * 헬스 프로버와 멤버십 리듀서 (DESIGN.md §6.5 · §6.6 · §6.7)
 *
 * ── 범위를 먼저 밝힌다 ───────────────────────────────────────────────────
 *
 * HTTP 풀은 GET 본문으로 판정한다. TCP/UDP 는 연결만 본다. 드레인 숫자는 없다.
 * 빼는 것은 리듀서가 하고, inflight 를 지어내지 않는다.
 *
 * ── 왜 리듀서가 하나인가 (§6.6) ─────────────────────────────────────────
 *
 * v2 는 *"admin_state 는 사용자 소유, 헬스는 프로버 소유라 경합하지 않는다"* 고 했다.
 * **소유가 다른 것과 경합이 없는 것은 다르다** — 둘 다 결국 같은 peer eligibility 를
 * 갱신하므로, 늦게 도착한 헬스 델타가 방금 내린 `disabled` 를 되돌릴 수 있다.
 *
 * 그래서 **단일 리듀서**가 `{커밋된 리비전, 원시 헬스}` 를 합성한다. 프로버는 헬스만 쓰고
 * peer 를 통째로 덮지 않는다. 이 저장소에서 `admin_state` 에 해당하는 것은
 * `backends.enabled` 이고, 꺼진 백엔드는 **모델에 아예 안 나온다** — 즉 어떤 헬스 값으로도
 * 되살아나지 않는다 (§6.6 "admin_state 가 항상 우선한다").
 *
 * ── 관측에도 ABA 가 있다 (§6.6) ─────────────────────────────────────────
 *
 * 같은 백엔드·같은 주소·같은 설정이어도 **먼저 시작한 프로브가 나중에 시작한 것보다 늦게
 * 끝나면** 낡은 결과가 최신 판정을 덮는다. 그래서 프로브마다 시작 순번을 싣고, 그 번호가
 * 마지막 반영값보다 클 때만 적용한다.
 */
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';

import type { Model } from '../model/provisional.js';
import { log } from '../obs/log.js';
import type { Db, Queryable } from '../store/pg.js';

export type HealthState = 'healthy' | 'unhealthy' | 'unknown';

export type HealthRow = {
  backendKey: string;
  state: HealthState;
  observedAt: string;
  detail: string | undefined;
};

/** 판정이 바뀐 한 줄. SSE `health` 델타가 이 모양이다. */
export type HealthFlip = { backendKey: string; state: HealthState };

export type ProbeOptions = {
  /** 프로브 주기. */
  intervalMs?: number;
  /** 한 프로브의 연결 예산. */
  timeoutMs?: number;
  /** 이만큼 연속 실패해야 `unhealthy` 로 내린다. */
  failThreshold?: number;
  /** 이만큼 연속 성공해야 `healthy` 로 올린다. */
  riseThreshold?: number;
  /** 한 번에 찌르는 백엔드 수. 기본 32. */
  concurrency?: number;
};

const DEFAULTS = {
  intervalMs: 2000, timeoutMs: 1000, failThreshold: 2, riseThreshold: 1,
  /**
   * 한 번에 찌르는 백엔드 수 (검수 B-07 부수).
   *
   * 전에는 `Promise.all` 로 **전부 동시에** 찔렀다. 백엔드가 수백 개면 매 틱마다 그만큼의
   * 연결이 한꺼번에 나가고, 그건 헬스체크가 만드는 부하가 트래픽보다 커지는 자리다.
   */
  concurrency: 32,
};

/** 상한을 두고 나눠 돈다. **순서는 보존한다** — 각 결과가 자기 `seq` 와 짝이어야 한다. */
export async function inBatches<T, R>(
  items: readonly T[], limit: number, run: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...await Promise.all(items.slice(i, i + limit).map(run)));
  }
  return out;
}

/** HTTP 풀이 기본으로 GET 하는 경로. 백엔드가 트래픽 경로와 같은 `/` 를 연다. */
export const HTTP_PROBE_PATH = '/';

/**
 * TCP 로 붙어 본다. **붙으면 산 것으로 본다.**
 *
 * 붙자마자 끊는다 — 백엔드에 요청을 남기지 않는 가장 싼 신호다. HTTP 풀은 이걸로
 * 안 판정한다. 포트만 열린 죽은 앱을 살았다고 하면 본문 프로브가 있는 이유가 없다.
 */
export function probeTcp(host: string, port: number, timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const s = connect({ host, port });
    const done = (reason: string | undefined): void => {
      s.destroy();
      resolve(reason);
    };
    s.setTimeout(timeoutMs, () => done(`${timeoutMs}ms 안에 연결되지 않았다`));
    s.on('connect', () => done(undefined));
    s.on('error', (e) => done(e.message));
  });
}

export type HttpProbeOpts = {
  path: string;
  /** 산 것으로 볼 상태 코드. 없으면 2xx. */
  expectStatus?: number[];
  /** 있으면 본문이 이 문자열이어야 산다. 없으면 본문을 안 본다. */
  expectBody?: string;
};

/**
 * HTTP GET 으로 판정한다 — **상태 코드가 먼저다** (검수 B-07).
 *
 * 전에는 **본문이 비어 있지 않으면 살았다고 봤다.** 그래서 500·502·503 과 함께 온 에러
 * 페이지가 전부 `healthy` 였다 — 죽은 백엔드가 계속 트래픽을 받는다. "연결만 열린 죽은
 * 앱" 을 막으려고 본문을 보게 했는데, **정작 앱이 죽었다고 말하는 신호를 안 봤다.**
 *
 * 기본은 2xx 다. 204 처럼 본문이 없는 정상 응답도 산 것이고, 200 에 빈 본문을 주는
 * 헬스 경로도 산 것이다 — 그 판정은 상태 코드가 한다.
 */
export function probeHttp(
  host: string, port: number, timeoutMs: number, opts: HttpProbeOpts,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const req = httpRequest({ host, port, path: opts.path, method: 'GET', timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => { chunks.push(c); });
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        const want = opts.expectStatus;
        const statusOk = want === undefined ? status >= 200 && status < 300 : want.includes(status);
        if (!statusOk) {
          resolve(want === undefined
            ? `${status} 다 (2xx 가 아니다)`
            : `${status} 다 (기대: ${want.join(', ')})`);
          return;
        }
        const expect = opts.expectBody;
        if (expect !== undefined) {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve(body === expect ? undefined : (body === '' ? '본문이 비어 있다' : '본문이 기대와 다르다'));
          return;
        }
        resolve(undefined);
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(`${timeoutMs}ms 안에 응답이 없다`);
    });
    req.on('error', (e) => resolve(e.message));
    req.end();
  });
}

/** 스위퍼가 풀 `protocolClass` 로 고르는 자리. HTTP 는 본문, 나머지는 TCP 연결. */
export function probeBackend(
  protocolClass: 'http' | 'tcp' | 'udp' | undefined,
  host: string, port: number, timeoutMs: number, httpOpts?: HttpProbeOpts,
): Promise<string | undefined> {
  if (protocolClass === 'http') {
    return probeHttp(host, port, timeoutMs, httpOpts ?? { path: HTTP_PROBE_PATH });
  }
  return probeTcp(host, port, timeoutMs);
}

/**
 * 이 풀의 HTTP 헬스체크 설정 (검수 B-07).
 *
 * **`HttpProbeOpts` 는 있는데 `HealthProber` 가 안 넘겼다** — 이 저장소가 반복해서 잡는
 * *"필드는 있는데 아무도 안 읽는다"* 의 한 판이다. 이 함수가 그 다리다.
 *
 * stream 풀(tcp·udp)에는 `undefined` — 거기엔 요청 개념이 없고 프로버는 연결만 본다.
 *
 * 안 적으면 `GET /` + 2xx 다. 좁히는 것은 옵트인이고, **안 좁힌 배포의 판정이 안 바뀐다.**
 */
export function healthCheckOf(model: Model, poolKey: string): HttpProbeOpts | undefined {
  const pool = model.pools.find((p) => p.key === poolKey);
  if (pool === undefined || pool.protocolClass !== 'http') return undefined;
  const spec = pool.healthCheck;
  return {
    path: spec?.path ?? HTTP_PROBE_PATH,
    ...(spec?.expectStatus === undefined ? {} : { expectStatus: spec.expectStatus }),
    ...(spec?.expectBody === undefined ? {} : { expectBody: spec.expectBody }),
  };
}

/**
 * 헬스 이벤트를 발행한다 — **판정 변경과 outbox 삽입을 같은 트랜잭션에서** (§6.6).
 *
 * 커서는 잠금 행으로 발급한다. `nextval` 을 쓰면 번호 순서와 커밋 순서가 달라져,
 * cut 이후에 커밋된 낮은 번호가 **영구 누락**된다.
 */
async function emit(
  c: Queryable, backendKey: string, state: HealthState, detail: string | undefined,
): Promise<string> {
  const cur = (await c.query(
    'SELECT next_seq::text AS n FROM health_cursor FOR UPDATE',
  )).rows[0];
  const seq = String(cur?.['n'] ?? '1');
  await c.query('UPDATE health_cursor SET next_seq = next_seq + 1');
  await c.query(
    'INSERT INTO health_events (seq, backend_key, state, detail) VALUES ($1,$2,$3,$4)',
    [seq, backendKey, state, detail ?? null],
  );
  return seq;
}

export class HealthProber {
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  /**
   * 프로브 시작 순번. **단조** — 늦게 끝난 낡은 관측을 가려낸다 (§6.6 ABA).
   *
   * **저장된 값에서 이어 붙인다.** 처음엔 1 부터 셌는데, 그러면 프로세스가 재기동하거나
   * 리더가 바뀔 때 새 프로세스의 1 번이 옛 프로세스의 50 번보다 작아서 **자기 관측을
   * 전부 버린다** — 헬스가 영영 얼어붙는다. 메모리 카운터와 durable 판정을 같은 축으로
   * 비교하면 반드시 이렇게 된다.
   */
  #next = 0;

  constructor(
    private readonly db: Db,
    private readonly opts: ProbeOptions = {},
  ) {}

  /** 한 바퀴 돈다. 테스트가 직접 부를 수 있도록 공개한다. */
  async sweep(model: Model): Promise<{ flipped: HealthFlip[] }> {
    const timeoutMs = this.opts.timeoutMs ?? DEFAULTS.timeoutMs;
    const fail = this.opts.failThreshold ?? DEFAULTS.failThreshold;
    const rise = this.opts.riseThreshold ?? DEFAULTS.riseThreshold;

    // 저장된 최대값에서 이어 붙인다. 재기동·리더 교체를 건너 단조가 유지된다.
    if (this.#next === 0) {
      const row = (await this.db.query(
        'SELECT COALESCE(MAX(probe_start_seq), 0)::text AS m FROM backend_health')).rows[0];
      this.#next = Number(row?.['m'] ?? 0) + 1;
    }

    // **시작 순번을 먼저 다 발급한다.** 프로브가 끝나는 순서는 시작 순서와 다르다.
    const classOf = new Map(model.pools.map((p) => [p.key, p.protocolClass]));
    const runs = model.backends.map((b) => ({ backend: b, seq: this.#next++ }));

    /**
     * **풀의 헬스체크 설정을 넘긴다** (검수 B-07). 전에는 안 넘겨서 옵션 타입이 있어도
     * 아무도 안 읽는 상태였다. 그리고 **나눠 돈다** — 전부 동시에 찌르면 헬스체크가
     * 만드는 부하가 트래픽보다 커진다.
     */
    const results = await inBatches(runs, this.opts.concurrency ?? DEFAULTS.concurrency,
      async ({ backend, seq }) => ({
        key: backend.key, seq,
        reason: await probeBackend(
          classOf.get(backend.pool), backend.host, backend.port, timeoutMs,
          healthCheckOf(model, backend.pool),
        ),
      }));

    const flipped: HealthFlip[] = [];
    for (const r of results) {
      const flip = await this.db.tx(async (c) => {
        const row = (await c.query(
          `SELECT state, probe_start_seq, consecutive, last_ok FROM backend_health
            WHERE backend_key = $1 FOR UPDATE`, [r.key],
        )).rows[0];
        const prevSeq = row === undefined ? 0 : Number(row['probe_start_seq']);
        // **낡은 관측은 버린다** (§6.6 ABA). 늦게 끝난 옛 프로브가 최신 판정을 덮으면
        // `disable → enable` 같은 A-B-A 에서 조용히 틀린 상태로 굳는다.
        if (r.seq <= prevSeq) return undefined;

        const prevState = (row?.['state'] as HealthState | undefined) ?? 'unknown';
        const ok = r.reason === undefined;

        // **결과의 연속을 센다.** 상태의 연속을 세면(처음에 그렇게 짰다) `healthy` 인
        // 동안 실패가 몇 번 이어져도 매번 1 로 리셋돼 임계값에 영원히 도달하지 못한다 —
        // 프로버가 `ECONNREFUSED` 를 보는데 판정은 `healthy` 로 굳었다.
        const sameAsLast = row !== undefined && row['last_ok'] === ok;
        const streak = sameAsLast ? Number(row['consecutive']) + 1 : 1;

        // 임계값을 넘어야 판정이 바뀐다. 한 번의 실패로 빼면 흔들림에 멤버십이 요동친다.
        let next = prevState;
        if (ok && prevState !== 'healthy' && streak >= rise) next = 'healthy';
        if (!ok && prevState !== 'unhealthy' && streak >= fail) next = 'unhealthy';

        await c.query(
          `INSERT INTO backend_health
             (backend_key, state, probe_start_seq, consecutive, last_ok, observed_at, detail)
           VALUES ($1,$2,$3,$4,$5,now(),$6)
           ON CONFLICT (backend_key) DO UPDATE SET
             state=EXCLUDED.state, probe_start_seq=EXCLUDED.probe_start_seq,
             consecutive=EXCLUDED.consecutive, last_ok=EXCLUDED.last_ok,
             observed_at=now(), detail=EXCLUDED.detail`,
          [r.key, next, String(r.seq), streak, ok, r.reason ?? null],
        );
        if (next === prevState) return undefined;
        // **판정 변경과 이벤트를 같은 트랜잭션에서** 쓴다 (§6.6).
        await emit(c, r.key, next, r.reason);
        return { backendKey: r.key, state: next };
      });
      if (flip !== undefined) flipped.push(flip);
    }
    return { flipped };
  }

  start(
    onSweep: () => Promise<Model | undefined>,
    onChange: (flips: HealthFlip[]) => Promise<void>,
  ): void {
    if (this.#timer !== undefined) return;
    const tick = async (): Promise<void> => {
      if (this.#running) return;
      this.#running = true;
      try {
        const model = await onSweep();
        if (model !== undefined) {
          const { flipped } = await this.sweep(model);
          if (flipped.length > 0) await onChange(flipped);
        }
      } catch (e) {
        // **프로버 장애는 판정 동결이다** (§6.7). 마지막 판정을 유지하고 멤버십도 유지한다.
        log.error('prober.failed', { error: String(e), effect: '판정 동결' });
      } finally {
        this.#running = false;
      }
    };
    this.#timer = setInterval(() => void tick(), this.opts.intervalMs ?? DEFAULTS.intervalMs);
    this.#timer.unref();
    void tick();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}

/** 지금 판정. 없는 백엔드는 `unknown` 이다. */
export async function currentHealth(db: Db): Promise<Map<string, HealthState>> {
  const rows = (await db.query('SELECT backend_key, state FROM backend_health')).rows;
  return new Map(rows.map((r) => [String(r['backend_key']), r['state'] as HealthState]));
}

export async function healthRows(db: Db): Promise<HealthRow[]> {
  const rows = (await db.query(
    `SELECT backend_key, state, observed_at, detail FROM backend_health ORDER BY backend_key`,
  )).rows;
  return rows.map((r) => ({
    backendKey: String(r['backend_key']),
    state: r['state'] as HealthState,
    observedAt: new Date(String(r['observed_at'])).toISOString(),
    detail: r['detail'] === null ? undefined : String(r['detail']),
  }));
}

/**
 * **단일 리듀서** — 커밋된 모델과 원시 헬스를 합성한다 (§6.6).
 *
 * `unhealthy` 만 뺀다. `unknown` 은 **안 뺀다** — 아직 재보지 못한 것과 죽은 것은 다르고,
 * 기동 직후 전부 `unknown` 일 때 다 빼면 멤버십이 통째로 비어 버린다.
 *
 * **의도적 zero-peer 와 갱신 실패를 구분한다** (§6.7). 풀의 모든 백엔드가 `unhealthy` 면
 * 그건 실제로 빈 멤버십이고 요청은 실패해야 한다 — 옛 peer 를 남겨 두면 죽은 백엔드가
 * 계속 트래픽을 받는다. 여기서는 **뺀 결과를 그대로** 돌려주고, 남기는 판단은 하지 않는다.
 */
export function reduceMembership(
  model: Model, health: Map<string, HealthState>, draining: ReadonlySet<string> = new Set(),
): Model {
  return {
    ...model,
    backends: model.backends.filter((b) =>
      health.get(b.key) !== 'unhealthy' && !draining.has(b.key)),
  };
}

/**
 * 슬롯을 엔진에 쓸지.
 *
 * 적격 peer 가 있는데 슬롯이 비면 **갱신 실패**다 — 마지막 셋을 지워서는 안 된다 (S4 fail-open).
 * 적격이 0 이고 슬롯도 비면 **의도적 zero-peer** 다 — 빈 셋을 써서 죽은 peer 가
 * 재시작 부트스트랩으로 되살아나면 안 된다 (S3).
 */
export function shouldPushMembership(eligibleCount: number, slotCount: number): boolean {
  if (slotCount > 0) return true;
  return eligibleCount === 0;
}

/** 이 평면의 적격 백엔드 수. HTTP 가 비었다고 stream 을 건너뛰면 안 된다 (S5). */
export function eligibleCountForPlane(model: Model, plane: 'http' | 'stream'): number {
  return model.backends.filter((b) => {
    const pool = model.pools.find((p) => p.key === b.pool);
    if (pool === undefined) return false;
    return plane === 'http' ? pool.protocolClass === 'http' : pool.protocolClass !== 'http';
  }).length;
}
