/**
 * 리더 잠금의 MySQL/MariaDB 구현 — 이름 잠금 `GET_LOCK` (DESIGN.md §3.5 · docs/adr-multi-db.md 「리더 선출」)
 *
 * 선출의 계약(잠금이 정본 · 기다리지 않는다 · 끊기면 리더가 아니다)은 `src/control/leader.ts` 머리말에 있다.
 *
 * ── PG advisory lock 과 같은 뜻인가 ─────────────────────────────────────
 *
 * 같은 것: **세션 잠금**이다. 쥔 연결이 끊기면(프로세스 죽음 · 네트워크 · `KILL`) 서버가 푼다. 기다리지 않는
 * 형태(`GET_LOCK(name, 0)`)가 있다. 그래서 PG 처럼 **전용 연결 하나**를 프로세스 수명 동안 쥔다 — 풀의 연결로
 * 쥐면 반납하는 순간 다른 요청이 그 세션을 쓰고, 풀이 연결을 닫으면 잠금이 조용히 풀린다.
 *
 * 다른 것과 그 처리:
 *
 * - **이름이 서버 전체에 하나다.** advisory lock 은 DB 마다 따로다. 한 서버에 barycenter DB 가 둘이면 서로의 리더를
 *   막는다 — 이름에 DB 이름을 넣는다(`lockNameFor`).
 * - **쉬는 세션을 서버가 끊는다**(`wait_timeout`, 기본 8 시간). 리더 연결은 쉬는 동안이 길다. 세션의 `wait_timeout` 을
 *   올리고, **주기 확인**(`LEADER_CHECK_MS`)이 `IS_USED_LOCK(name) = CONNECTION_ID()` 를 묻는다. 확인이 실패하거나
 *   잠금의 주인이 이 세션이 아니면 그 순간 리더가 아니다. 이 확인은 조용히 끊긴 연결(소켓이 닫히지 않은 채 상대가
 *   사라진 것)도 상한 안에 알아낸다 — PG 쪽은 소켓 사건만 본다.
 * - **복제 · 클러스터 서버**(Galera · Group Replication 다중 기본)는 이름 잠금을 노드끼리 나누지 않는다. 모든 데몬이
 *   **같은 기본 서버 하나**에 붙어야 한다(런북 「MySQL」).
 *
 * ── 토큰 ───────────────────────────────────────────────────────────────
 *
 * **잠금을 쥔 뒤에** 같은 연결에서 카운터(`bary_sequences` 의 `leader_token_seq`)를 한 트랜잭션으로 올리고
 * `leadership` 에 적는다. 카운터 행의 `UPDATE` 는 행 잠금이라 둘이 같은 값을 받을 수 없고, 커밋한 값은 되돌아가지
 * 않는다(`innodb_flush_log_at_trx_commit=1` — 기동이 확인한다). PG 의 `nextval` 과 같은 엄격 단조다.
 */
import type { LeaderAttempt, LeaderLock, LeaderSession } from './db.js';
import { flavorOf, initSession, lockNameFor, mysqlConfigOf, mysqlModule, MyRunner, type MyConn, type MysqlConfig } from './mysql.js';

/** 잠금이 아직 이 세션의 것인지 묻는 주기. 끊김을 알아내는 상한이다. */
export const LEADER_CHECK_MS = 2_000;

/** 리더 세션의 `wait_timeout`(초) — 주기 확인이 있으니 쉬는 일은 없지만, 확인이 멈춘 동안(GC 등) 끊기지 않게. */
const LEADER_WAIT_TIMEOUT_S = 86_400;

export class MysqlLeaderLock implements LeaderLock {
  readonly #cfg: MysqlConfig;
  readonly #name: string;
  constructor(dsn: string, label = 'DSN') {
    this.#cfg = mysqlConfigOf(dsn, label);
    this.#name = lockNameFor(this.#cfg.database, 'leader');
  }

  /** 잠금 이름 — 시험이 다른 연결에서 주인을 묻는다. */
  get lockName(): string { return this.#name; }

  /** 기다리지 않는다(`GET_LOCK(name, 0)`). 기다리는 형태로 잡으면 기동이 무한정 멈춘다. */
  async tryAcquire(holder: string): Promise<LeaderAttempt> {
    let c: MyConn | undefined;
    try {
      const m = await mysqlModule();
      c = await m.createConnection({ ...this.#cfg.options });
      await initSession(c);
      await c.query(`SET SESSION wait_timeout = ${LEADER_WAIT_TIMEOUT_S}`);
      const [vrows] = await c.query('SELECT VERSION() AS v');
      const r = new MyRunner(c, flavorOf(String((vrows as Array<Record<string, unknown>>)[0]?.['v'] ?? '')), false);
      const got = await r.run('SELECT GET_LOCK($1, 0) AS got', [this.lockName]);
      if (String(got.rows[0]?.['got']) !== '1') {
        await c.end().catch(() => undefined);
        return { ok: false, reason: '다른 인스턴스가 리더다 (GET_LOCK 을 못 잡았다)' };
      }

      // **잠금을 쥔 뒤에 토큰을 뽑는다.** 순서가 반대면 못 잡은 쪽도 카운터를 소모한다.
      await c.query('START TRANSACTION');
      let token: string;
      let since: string;
      try {
        const up = await r.run(`UPDATE bary_sequences SET \`last_value\` = LAST_INSERT_ID(\`last_value\` + 1) WHERE name = 'leader_token_seq'`);
        if (up.rowCount !== 1) throw new Error('leader_token_seq 카운터가 없다 — 마이그레이션이 덜 됐다');
        token = String((await r.run('SELECT CAST(LAST_INSERT_ID() AS CHAR) AS token')).rows[0]?.['token']);
        await r.run('INSERT INTO leadership (token, holder) VALUES ($1,$2)', [token, holder]);
        const at = (await r.run('SELECT acquired_at FROM leadership WHERE token = $1', [token])).rows[0]?.['acquired_at'];
        since = new Date(at as Date).toISOString();
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw e;
      }
      const session = new MysqlLeaderSession(c, r, this.#name, token, since);
      c = undefined;
      return { ok: true, session };
    } catch (e) {
      if (c !== undefined) c.destroy();
      return { ok: false, reason: `선출 시도가 실패했다: ${String(e)}` };
    }
  }
}

class MysqlLeaderSession implements LeaderSession {
  readonly #c: MyConn;
  readonly #r: MyRunner;
  readonly #listeners: Array<(kind: 'error' | 'end', reason: string) => void> = [];
  /** 듣는 쪽이 붙기 전에 온 사건. 붙는 순간 그대로 다시 준다 — 놓치면 끊긴 세션을 리더로 믿는다. */
  readonly #early: Array<['error' | 'end', string]> = [];
  readonly #timer: NodeJS.Timeout;
  #lost = false;
  #checking = false;

  constructor(c: MyConn, r: MyRunner, private readonly name: string, readonly token: string, readonly since: string) {
    this.#c = c;
    this.#r = r;
    // **끊기면 리더가 아니다.** 이름 잠금은 세션이 죽으면 풀린다.
    c.on('error', (e) => this.#lose('error', `리더 세션이 끊겼다: ${e?.message ?? String(e)}`));
    c.on('end', () => this.#lose('end', '리더 세션이 닫혔다'));
    this.#timer = setInterval(() => { void this.#check(); }, LEADER_CHECK_MS);
    this.#timer.unref();
  }

  /** 잠금의 주인이 아직 이 세션인가. 묻지 못하면(연결이 죽었다) 그것도 잃은 것이다. */
  async #check(): Promise<void> {
    if (this.#lost || this.#checking) return;
    this.#checking = true;
    try {
      const r = await this.#r.run('SELECT IS_USED_LOCK($1) = CONNECTION_ID() AS mine', [this.name]);
      const mine = r.rows[0]?.['mine'];
      if (mine === null || String(mine) !== '1') this.#lose('error', '리더 잠금의 주인이 이 세션이 아니다 (IS_USED_LOCK)');
    } catch (e) {
      this.#lose('error', `리더 세션 확인이 실패했다: ${String(e)}`);
    } finally {
      this.#checking = false;
    }
  }

  #lose(kind: 'error' | 'end', reason: string): void {
    const first = !this.#lost;
    this.#lost = true;
    clearInterval(this.#timer);
    if (first && kind === 'error') this.#c.destroy();
    this.#emit(kind, reason);
  }

  #emit(kind: 'error' | 'end', reason: string): void {
    if (this.#listeners.length === 0) this.#early.push([kind, reason]);
    for (const fn of this.#listeners) fn(kind, reason);
  }

  onLost(fn: (kind: 'error' | 'end', reason: string) => void): void {
    this.#listeners.push(fn);
    for (const [kind, reason] of this.#early.splice(0)) fn(kind, reason);
  }

  /** `released_at` 을 적고 세션을 닫는다 — 깨끗하게 물러난 것과 죽은 것을 나중에 가른다. 던지지 않는다. */
  async release(): Promise<void> {
    clearInterval(this.#timer);
    if (!this.#lost) {
      try {
        await this.#r.run('UPDATE leadership SET released_at = now() WHERE token = $1', [this.token]);
      } catch {
        /* 물러나는 길에 못 적어도 잠금은 세션 종료로 풀린다 */
      }
    }
    this.#lost = true;
    await this.#c.end().catch(() => this.#c.destroy());
  }
}
