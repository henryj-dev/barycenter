/**
 * 리더 잠금의 PG 구현 — advisory lock (DESIGN.md §3.5 · docs/adr-multi-db.md 「리더 선출」)
 *
 * 선출의 계약(무엇이 정본인가 · 왜 기다리지 않는가 · 끊기면 리더가 아니다)은
 * `src/control/leader.ts` 머리말에 있다. 여기는 그 계약의 PG 쪽 손발이다.
 *
 * ── 세션 하나를 통째로 쓴다 ─────────────────────────────────────────────
 *
 * advisory lock 은 **세션 스코프**다. 풀에서 커넥션을 빌려 잡으면 반납하는 순간 다른
 * 요청이 그 커넥션을 쓰고, 풀이 커넥션을 재활용하거나 끊으면 락이 조용히 풀린다.
 * 그래서 전용 `Client` 하나를 잡고 프로세스 수명 동안 들고 있는다.
 */
import pg from 'pg';

import type { LeaderAttempt, LeaderLock, LeaderSession } from './db.js';

/**
 * advisory lock 키.
 *
 * `hashtext()` 로 문자열에서 뽑고 싶어지는데, 그 함수는 **버전 간 안정성이 보장되지
 * 않는다.** PG 를 올린 뒤 키가 바뀌면 옛 리더와 새 리더가 서로 다른 락을 잡고 둘 다
 * 자기가 리더라고 믿는다 — 선출이 있는데 없는 것보다 나쁜 상태다. 상수로 박는다.
 */
const LOCK_KEY_HI = 0x62_61 as const;   // 'ba'
const LOCK_KEY_LO = 0x72_79 as const;   // 'ry'

export class PgLeaderLock implements LeaderLock {
  constructor(private readonly dsn: string) {}

  /**
   * 기다리는 형태(`pg_advisory_lock`)를 안 쓴다. 블로킹으로 잡으면 기동이 무한정 멈추고,
   * 그동안 이 프로세스는 살아 있지도 죽지도 않은 상태가 된다.
   */
  async tryAcquire(holder: string): Promise<LeaderAttempt> {
    const client = new pg.Client({ connectionString: this.dsn });
    try {
      await client.connect();
      const r = await client.query(
        'SELECT pg_try_advisory_lock($1::int, $2::int) AS got', [LOCK_KEY_HI, LOCK_KEY_LO],
      );
      if (r.rows[0]?.got !== true) {
        await client.end().catch(() => undefined);
        return { ok: false, reason: '다른 인스턴스가 리더다 (advisory lock 을 못 잡았다)' };
      }

      // **락을 잡은 뒤에 토큰을 뽑는다.** 순서가 반대면 락을 못 잡은 인스턴스도 시퀀스를
      // 소모하고, 그러면 토큰이 "리더가 몇 번 바뀌었나" 를 뜻하지 않게 된다.
      const t = await client.query(`SELECT nextval('leader_token_seq')::text AS token`);
      const token = String(t.rows[0]?.token);
      const ins = await client.query(
        `INSERT INTO leadership (token, holder) VALUES ($1,$2) RETURNING acquired_at`,
        [token, holder],
      );
      const since = new Date(String(ins.rows[0]?.acquired_at)).toISOString();
      return { ok: true, session: new PgLeaderSession(client, token, since) };
    } catch (e) {
      await client.end().catch(() => undefined);
      return { ok: false, reason: `선출 시도가 실패했다: ${String(e)}` };
    }
  }
}

class PgLeaderSession implements LeaderSession {
  readonly #client: pg.Client;
  readonly #listeners: Array<(kind: 'error' | 'end', reason: string) => void> = [];
  /** 듣는 쪽이 붙기 전에 온 사건. 붙는 순간 그대로 다시 준다 — 놓치면 끊긴 세션을 리더로 믿는다. */
  readonly #early: Array<['error' | 'end', string]> = [];

  constructor(client: pg.Client, readonly token: string, readonly since: string) {
    this.#client = client;
    // **끊기면 리더가 아니다.** advisory lock 은 세션이 죽으면 풀리므로, 커넥션이
    // 끊긴 순간부터 이 프로세스는 리더가 아니다. 그걸 안 보면 "PG 와의 연결은 끊겼는데
    // 자기는 리더라고 믿는" 프로세스가 부작용을 계속 낸다.
    client.on('error', (e) => this.#emit('error', `리더 세션이 끊겼다: ${e.message}`));
    client.on('end', () => this.#emit('end', '리더 세션이 닫혔다'));
  }

  #emit(kind: 'error' | 'end', reason: string): void {
    if (this.#listeners.length === 0) this.#early.push([kind, reason]);
    for (const fn of this.#listeners) fn(kind, reason);
  }

  onLost(fn: (kind: 'error' | 'end', reason: string) => void): void {
    this.#listeners.push(fn);
    for (const [kind, reason] of this.#early.splice(0)) fn(kind, reason);
  }

  /**
   * 락은 세션이 끝나면 어차피 풀리지만 **`released_at` 을 적는 것이 다르다** — 깨끗하게
   * 물러난 것과 죽은 것을 나중에 구분할 수 있어야 한다.
   */
  async release(): Promise<void> {
    try {
      await this.#client.query('UPDATE leadership SET released_at = now() WHERE token = $1',
        [this.token]);
    } catch {
      /* 물러나는 길에 못 적어도 락은 세션 종료로 풀린다 */
    }
    await this.#client.end().catch(() => undefined);
  }
}
