/**
 * 공유 PG — 사람 계정 PG 의 `auth_throttle`(마이그레이션 005)에서 센다. 같은 PG 를 보는 인스턴스가 **함께** 센다.
 *
 * 새 표를 만들지 않는다. `auth_throttle` 은 키가 `<용도>:<IP>` 인 표이고, 사람 로그인이 `login:` · `reset:` 을 쓴다.
 * 여기는 **`api:`** 를 쓴다 — API 인증 실패(틀린 토큰 · 낡은 세션 · 매핑 없는 인증서)는 사람 로그인과 따로 센다.
 * 오래된 행은 `AccountService.purgeExpired` 가 지운다(마지막 실패 15분 뒤 — 여기 TTL 10분보다 길다).
 *
 * 수치는 메모리 구현(`AuthFailureLimiter`)과 같다. 판정은 **한 문장의 upsert** 로 한다 — 두 노드가 동시에 더해도
 * 하나도 잃지 않는다(행 잠금).
 */
import { byDialect, dialectOf, type Database, type Queryable } from '../../store/db.js';
import type { LimitResult, RateLimitStore } from './store.js';

export type PgRateLimitOptions = {
  db: Queryable;
  maxFailures?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  ttlMs?: number;
  /** 키 앞머리. 기본 `api:`. */
  prefix?: string;
  now?: () => number;
};

/** 받은 것이 `Database` 면 트랜잭션을 열고, 이미 트랜잭션의 연결이면 그대로 쓴다. */
function inTx<T>(q: Queryable, fn: (c: Queryable) => Promise<T>): Promise<T> {
  const tx = (q as Partial<Database>).tx;
  return typeof tx === 'function' ? tx.call(q, fn) as Promise<T> : fn(q);
}

export function pgRateLimit(o: PgRateLimitOptions): RateLimitStore {
  const max = o.maxFailures ?? 5;
  const base = o.baseDelayMs ?? 1_000;
  const cap = o.maxDelayMs ?? 60_000;
  const ttl = o.ttlMs ?? 10 * 60_000;
  const prefix = o.prefix ?? 'api:';
  const now = o.now ?? Date.now;
  const why = (e: unknown): string => `계정 PG(auth_throttle)에 닿지 못했다: ${e instanceof Error ? e.message : String(e)}`;

  return {
    kind: 'pg',
    async record(key): Promise<LimitResult> {
      const t = now();
      try {
        // 마지막 실패에서 ttl 이 지났으면 1 부터. 대기는 같은 문장에서 정한다 — 읽고 다시 쓰는 사이에 끼어들 틈이 없다.
        const text = byDialect(o.db, {
          postgres: `INSERT INTO auth_throttle (key, failures, last_failure_at, blocked_until)
           VALUES ($1, 1, $2, CASE WHEN 1 >= $4 THEN $2::timestamptz + make_interval(secs => $5::double precision / 1000) END)
           ON CONFLICT (key) DO UPDATE SET
             failures = CASE WHEN auth_throttle.last_failure_at <= $3 THEN 1 ELSE auth_throttle.failures + 1 END,
             last_failure_at = $2,
             blocked_until = CASE
               WHEN (CASE WHEN auth_throttle.last_failure_at <= $3 THEN 1 ELSE auth_throttle.failures + 1 END) >= $4
               THEN $2::timestamptz + make_interval(secs => LEAST($6::double precision,
                 $5::double precision * power(2, (CASE WHEN auth_throttle.last_failure_at <= $3 THEN 1 ELSE auth_throttle.failures + 1 END) - $4)) / 1000)
               END
           RETURNING failures`,
          // SQLite: 시각은 ISO 텍스트다 — 간격은 `strftime` 의 초 수정자로 더한다(형식이 같아 문자열 비교가 시각 비교다).
          sqlite: `INSERT INTO auth_throttle (key, failures, last_failure_at, blocked_until)
           VALUES ($1, 1, $2, CASE WHEN 1 >= $4 THEN strftime('%Y-%m-%dT%H:%M:%fZ', $2, '+' || ($5 / 1000.0) || ' seconds') END)
           ON CONFLICT (key) DO UPDATE SET
             failures = CASE WHEN auth_throttle.last_failure_at <= $3 THEN 1 ELSE auth_throttle.failures + 1 END,
             last_failure_at = $2,
             blocked_until = CASE
               WHEN (CASE WHEN auth_throttle.last_failure_at <= $3 THEN 1 ELSE auth_throttle.failures + 1 END) >= $4
               THEN strftime('%Y-%m-%dT%H:%M:%fZ', $2, '+' || (min($6 * 1.0,
                 $5 * pow(2, (CASE WHEN auth_throttle.last_failure_at <= $3 THEN 1 ELSE auth_throttle.failures + 1 END) - $4)) / 1000.0) || ' seconds')
               END
           RETURNING failures`,
          // MySQL: RETURNING 이 없어 같은 트랜잭션에서 다시 읽는다. SET 은 왼쪽부터라 failures 를 먼저 새 값으로 두고
          // blocked_until 이 그 새 값을 본다(PG 는 같은 CASE 를 되풀이한다). last_failure_at 은 둘 다 옛 값을 본 뒤에 바꾼다.
          mysql: `INSERT INTO auth_throttle (key, failures, last_failure_at, blocked_until)
           VALUES ($1, 1, $2, CASE WHEN 1 >= $4 THEN DATE_ADD(CAST($2 AS DATETIME(6)), INTERVAL CAST($5 * 1000 AS SIGNED) MICROSECOND) END)
           ON DUPLICATE KEY UPDATE
             failures = CASE WHEN last_failure_at <= $3 THEN 1 ELSE failures + 1 END,
             blocked_until = CASE
               WHEN failures >= $4
               THEN DATE_ADD(CAST($2 AS DATETIME(6)),
                 INTERVAL CAST(LEAST($6, $5 * POWER(2, failures - $4)) * 1000 AS SIGNED) MICROSECOND)
               END,
             last_failure_at = VALUES(last_failure_at)`,
        });
        const v = [`${prefix}${key}`, new Date(t), new Date(t - ttl), max, base, cap];
        const r = dialectOf(o.db).name === 'mysql'
          ? await inTx(o.db, async (c) => {
            await c.query(text, v);
            return (await c.query(`SELECT failures FROM auth_throttle WHERE key=$1`, [v[0]])).rows[0];
          })
          : (await o.db.query(text, v)).rows[0];
        const n = Number(r?.['failures']);
        if (!Number.isFinite(n)) return { ok: false, reason: 'unavailable', detail: 'auth_throttle 이 계수를 돌려주지 않았다' };
        if (n < max) return { ok: true };
        // 대기 초는 같은 식으로 여기서 센다 — 메모리 구현과 같은 반올림(올림, 최소 1).
        const delay = Math.min(cap, base * 2 ** (n - max));
        return { ok: true, retryAfterS: Math.max(1, Math.ceil(delay / 1_000)) };
      } catch (e) {
        return { ok: false, reason: 'unavailable', detail: why(e) };
      }
    },
    async clear(key) {
      try {
        // 행이 없으면 지울 것도 없다 — PG 는 쓰지 않는다(색인 조회 한 번).
        await o.db.query(`DELETE FROM auth_throttle WHERE key=$1`, [`${prefix}${key}`]);
        return { ok: true };
      } catch (e) {
        return { ok: false, detail: why(e) };
      }
    },
  };
}
