/**
 * 헬스 프로버와 멤버십 리듀서 (DESIGN.md §6.5 · §6.6 · §6.7)
 *
 * ── 범위를 먼저 밝힌다 ───────────────────────────────────────────────────
 *
 * **TCP 연결 검사만 한다.** HTTP 상태 코드도, 응답 본문도, 프로토콜별 헬스체크도 없다.
 * 드레인 관측(S2)도 없다. 그건 각각의 착수 게이트가 있는 별도 일이고, 여기서 흉내내면
 * "헬스체크가 있다" 는 말이 절반만 참이 된다.
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

export type ProbeOptions = {
  /** 프로브 주기. */
  intervalMs?: number;
  /** 한 프로브의 연결 예산. */
  timeoutMs?: number;
  /** 이만큼 연속 실패해야 `unhealthy` 로 내린다. */
  failThreshold?: number;
  /** 이만큼 연속 성공해야 `healthy` 로 올린다. */
  riseThreshold?: number;
};

const DEFAULTS = { intervalMs: 2000, timeoutMs: 1000, failThreshold: 2, riseThreshold: 1 };

/**
 * TCP 로 붙어 본다. **붙으면 산 것으로 본다.**
 *
 * 붙자마자 끊는다 — 백엔드에 요청을 남기지 않는 가장 싼 신호다. 이걸로 알 수 없는 것도
 * 분명히 있다(포트는 열렸는데 애플리케이션이 죽은 경우). 그건 프로토콜별 헬스체크의
 * 몫이고 여기서는 안 한다.
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
  async sweep(model: Model): Promise<{ changed: string[] }> {
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
    const runs = model.backends.map((b) => ({ backend: b, seq: this.#next++ }));

    const results = await Promise.all(runs.map(async ({ backend, seq }) => ({
      key: backend.key, seq,
      reason: await probeTcp(backend.host, backend.port, timeoutMs),
    })));

    const changed: string[] = [];
    for (const r of results) {
      const flipped = await this.db.tx(async (c) => {
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
        return r.key;
      });
      if (flipped !== undefined) changed.push(flipped);
    }
    return { changed };
  }

  start(onSweep: () => Promise<Model | undefined>, onChange: () => Promise<void>): void {
    if (this.#timer !== undefined) return;
    const tick = async (): Promise<void> => {
      if (this.#running) return;
      this.#running = true;
      try {
        const model = await onSweep();
        if (model !== undefined) {
          const { changed } = await this.sweep(model);
          if (changed.length > 0) await onChange();
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
  model: Model, health: Map<string, HealthState>,
): Model {
  return {
    ...model,
    backends: model.backends.filter((b) => health.get(b.key) !== 'unhealthy'),
  };
}
