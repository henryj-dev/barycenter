/**
 * 리더 잠금의 SQLite 구현 — 잠금 파일 위의 SQLite 배타 잠금 (DESIGN.md §3.5 · docs/adr-multi-db.md 「리더 선출」)
 *
 * 선출의 계약(잠금이 정본 · 기다리지 않는다 · 끊기면 리더가 아니다)은 `src/control/leader.ts` 머리말에 있다.
 *
 * ── 왜 이 모양인가 ─────────────────────────────────────────────────────
 *
 * SQLite 에는 PG 의 advisory lock 같은 **세션 잠금**이 없다. ADR 이 둔 후보는 둘이었다.
 *
 * - DB 안 임대(lease) + 주기 갱신: 잠금의 정본이 **시계**가 된다. 갱신이 늦으면(GC 멈춤 · 디스크 지연)
 *   임대가 만료되고 다른 프로세스가 리더가 된 뒤에도 옛 리더는 다음 갱신 때까지 자기가 리더라고 믿는다.
 *   그 창의 상한이 만료 시간이다.
 * - **잠금 파일(이것).** `<db>-leader.lock` 이라는 작은 SQLite 파일을 따로 열고 `BEGIN EXCLUSIVE` 를
 *   프로세스 수명 동안 쥔다. SQLite 의 파일 잠금은 POSIX `fcntl` 잠금이라 **프로세스가 죽으면 커널이
 *   푼다** — advisory lock 이 세션 종료로 풀리는 것과 같은 뜻이다. 시계에 기대지 않는다. 같은 프로세스
 *   안의 두 연결도 SQLite 가 inode 단위로 가른다(시험이 잰다). `O_EXCL` + PID 파일과 달리 낡은 파일을
 *   치우는 경쟁(두 프로세스가 같은 낡은 PID 를 보고 둘 다 지운다)과 PID 재사용이 없다.
 *
 * 남는 구멍 하나: 누가 잠금 파일을 **지우면** 다음 프로세스는 새 파일(새 inode)을 잠그고 리더가 된다.
 * 그래서 세션이 1 초마다 그 경로의 inode 를 본다 — 바뀌었거나 없으면 그 순간 리더가 아니다(`onLost`).
 * 그 1 초 창은 §3.5 의 답(DP Agent 가 토큰을 비교해 낡은 리더의 쓰기를 거절한다)이 무해하게 만든다.
 *
 * **한 호스트 안에서만 뜻이 있다.** 네트워크 파일시스템 위의 `fcntl` 잠금은 믿을 수 없다 — 그래서
 * SQLite 는 클러스터 모드(여러 호스트)를 기동에서 거부한다(`./sqlite-checks.ts`).
 *
 * ── 토큰 ───────────────────────────────────────────────────────────────
 *
 * **잠금을 쥔 뒤에** 설정 DB 의 카운터(`bary_sequences` 의 `leader_token_seq`)를 한 쓰기 트랜잭션에서
 * 올리고 `leadership` 에 적는다. PG 의 `nextval` 과 같은 엄격 단조다 — 카운터는 롤백되지 않는 한 되돌아가지
 * 않고, 쓰기는 한 줄이라 둘이 같은 값을 받을 수 없다.
 */
import { statSync } from 'node:fs';

import type { LeaderAttempt, LeaderLock, LeaderSession } from './db.js';
import { openConn, sqliteModule, sqlitePathOf, type SqliteConn } from './sqlite.js';

/** 잠금 파일의 경로. 설정 DB 와 같은 디렉터리 — 같은 파일시스템이다. */
export const leaderLockPathOf = (dbPath: string): string => `${dbPath}-leader.lock`;

/** 잠금 파일의 inode 를 보는 주기. */
export const LEADER_WATCH_MS = 1_000;

const inodeOf = (path: string): string | undefined => {
  try {
    const s = statSync(path, { bigint: true });
    return `${s.dev}:${s.ino}`;
  } catch {
    return undefined;
  }
};

const isBusy = (e: unknown): boolean => /database is locked|SQLITE_BUSY/i.test(String((e as { message?: unknown })?.message ?? e));

/**
 * 쓰기 트랜잭션 하나를 **비동기로 기다려** 돈다. 이 연결은 `busy_timeout` 을 0 으로 두고, 바쁘면 이벤트
 * 루프를 놓았다가 다시 시도한다 — 같은 프로세스의 `SqliteDb` 가 쓰기 트랜잭션을 쥐고 `await` 중일 때
 * 동기로 기다리면 그쪽이 영영 못 끝난다.
 */
async function writeTx<T>(path: string, fn: (c: SqliteConn) => T, deadlineMs = 10_000): Promise<T> {
  const c = openConn(path);
  try {
    c.exec('PRAGMA busy_timeout = 0');
    const until = Date.now() + deadlineMs;
    for (;;) {
      try {
        c.exec('BEGIN IMMEDIATE');
        break;
      } catch (e) {
        if (!isBusy(e) || Date.now() > until) throw e;
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    try {
      const out = fn(c);
      c.exec('COMMIT');
      return out;
    } catch (e) {
      try { c.exec('ROLLBACK'); } catch { /* 이미 끝났다 */ }
      throw e;
    }
  } finally {
    c.close();
  }
}

export class SqliteLeaderLock implements LeaderLock {
  readonly #dbPath: string;
  constructor(dsn: string, label = 'DSN') {
    this.#dbPath = sqlitePathOf(dsn, label);
  }

  async tryAcquire(holder: string): Promise<LeaderAttempt> {
    const lockPath = leaderLockPathOf(this.#dbPath);
    let lock: SqliteConn | undefined;
    try {
      const { DatabaseSync } = sqliteModule();
      // **기다리지 않는다**(timeout 0). 기다리는 형태로 잡으면 기동이 무한정 멈춘다.
      lock = new DatabaseSync(lockPath, { timeout: 0 });
      try {
        // 쥔 쪽이 있으면 PRAGMA 부터 `database is locked` 다 — 같은 「못 잡았다」 로 본다.
        lock.exec('PRAGMA journal_mode = DELETE');
        lock.exec('BEGIN EXCLUSIVE');
      } catch (e) {
        lock.close();
        if (isBusy(e)) return { ok: false, reason: '다른 인스턴스가 리더다 (잠금 파일을 못 잡았다)' };
        return { ok: false, reason: `선출 시도가 실패했다: ${String(e)}` };
      }
      const inode = inodeOf(lockPath);
      if (inode === undefined) throw new Error('잠금 파일이 쥔 직후에 없다');

      // **잠금을 쥔 뒤에 토큰을 뽑는다.** 순서가 반대면 못 잡은 쪽도 카운터를 소모한다.
      const { token, since } = await writeTx(this.#dbPath, (c) => {
        const t = c.prepare(`UPDATE bary_sequences SET last_value = last_value + 1
                              WHERE name = 'leader_token_seq' RETURNING CAST(last_value AS TEXT) AS token`).all()[0];
        if (t === undefined) throw new Error('leader_token_seq 카운터가 없다 — 마이그레이션이 덜 됐다');
        const tok = String(t['token']);
        const r = c.prepare(`INSERT INTO leadership (token, holder) VALUES (?1, ?2) RETURNING acquired_at`).all(tok, holder)[0];
        return { token: tok, since: new Date(String(r?.['acquired_at'])).toISOString() };
      });
      const session = new SqliteLeaderSession(lock, lockPath, inode, this.#dbPath, token, since);
      lock = undefined;
      return { ok: true, session };
    } catch (e) {
      if (lock !== undefined) {
        try { lock.exec('ROLLBACK'); } catch { /* 없다 */ }
        try { lock.close(); } catch { /* 이미 닫혔다 */ }
      }
      return { ok: false, reason: `선출 시도가 실패했다: ${String(e)}` };
    }
  }
}

class SqliteLeaderSession implements LeaderSession {
  #lock: SqliteConn | undefined;
  readonly #listeners: Array<(kind: 'error' | 'end', reason: string) => void> = [];
  /** 듣는 쪽이 붙기 전에 온 사건. 붙는 순간 그대로 다시 준다 — 놓치면 끊긴 세션을 리더로 믿는다. */
  readonly #early: Array<['error' | 'end', string]> = [];
  readonly #timer: NodeJS.Timeout;

  constructor(
    lock: SqliteConn,
    private readonly lockPath: string,
    private readonly inode: string,
    private readonly dbPath: string,
    readonly token: string,
    readonly since: string,
  ) {
    this.#lock = lock;
    // **끊기면 리더가 아니다.** 잠금 파일이 지워지거나 바뀌면 다른 프로세스가 새 파일을 잠글 수 있다.
    this.#timer = setInterval(() => {
      if (this.#lock === undefined) return;
      const now = inodeOf(this.lockPath);
      if (now !== this.inode) {
        this.#drop();
        this.#emit('error', now === undefined
          ? `리더 잠금 파일이 없어졌다: ${this.lockPath}`
          : `리더 잠금 파일이 바뀌었다: ${this.lockPath}`);
      }
    }, LEADER_WATCH_MS);
    this.#timer.unref();
  }

  #drop(): void {
    clearInterval(this.#timer);
    const l = this.#lock;
    this.#lock = undefined;
    if (l === undefined) return;
    try { l.exec('ROLLBACK'); } catch { /* 없다 */ }
    try { l.close(); } catch { /* 이미 닫혔다 */ }
  }

  #emit(kind: 'error' | 'end', reason: string): void {
    if (this.#listeners.length === 0) this.#early.push([kind, reason]);
    for (const fn of this.#listeners) fn(kind, reason);
  }

  onLost(fn: (kind: 'error' | 'end', reason: string) => void): void {
    this.#listeners.push(fn);
    for (const [kind, reason] of this.#early.splice(0)) fn(kind, reason);
  }

  /** `released_at` 을 적고 잠금을 놓는다 — 깨끗하게 물러난 것과 죽은 것을 나중에 가른다. 던지지 않는다. */
  async release(): Promise<void> {
    if (this.#lock === undefined) return;
    try {
      await writeTx(this.dbPath, (c) => {
        c.prepare('UPDATE leadership SET released_at = now() WHERE token = ?1').run(this.token);
      }, 2_000);
    } catch {
      /* 물러나는 길에 못 적어도 잠금은 아래에서 놓는다 */
    }
    this.#drop();
    this.#emit('end', '리더 세션이 닫혔다');
  }
}
