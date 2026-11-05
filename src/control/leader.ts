/**
 * 리더 선출 — PG advisory lock (DESIGN.md §3.5)
 *
 * v0.1 까지 `leader_token` 은 **환경변수**였다. DP Agent 가 50 회차 동안 그 토큰을 두고
 * 펜싱·승계·`superseded` 를 지었는데 **아무도 발급하지 않았다** — 방어는 있고 무대가 없는
 * 상태였다. 여기서 그 무대를 만든다.
 *
 * ── 무엇이 정본인가 ─────────────────────────────────────────────────────
 *
 * **advisory lock 이 정본이다.** `leadership` 표도 `#token` 필드도 관측용 사본이고,
 * 사본을 정본으로 삼는 순간 "표는 A 인데 락은 B" 인 창이 생긴다.
 *
 * 그리고 §3.5 가 말하는 대로 **최종 심판은 컨트롤 플레인이 아니라 DP Agent 다.** 여기서
 * 하는 일은 두 가지뿐이다.
 *
 *   1. **엄격 단조** 토큰을 발급한다 (PG 시퀀스).
 *   2. 락을 못 쥐었으면 **부작용을 내지 않는다.**
 *
 * 락을 쥐었다고 믿는 순간과 실제로 부작용이 나가는 순간 사이에는 언제나 창이 있고, 그
 * 창은 여기서 못 닫는다. 닫는 것은 DP Agent 의 토큰 비교다 — 옛 리더가 그 창에서 낸
 * 요청은 신임이 fence 를 지난 뒤 전부 거부된다. **막는 것이 아니라 무해하게 만드는 것**이
 * 설계의 답이었다(§3.5 · 8차 검수).
 *
 * ── 잠금은 저장소 경계 뒤에 있다 ───────────────────────────────────────
 *
 * 잠금을 잡고 토큰을 발급하는 손발은 `LeaderLock`(`src/store/db.ts`)이다. PG 구현은
 * advisory lock 과 `leader_token_seq` 다(`src/store/pg-leader.ts`). 여기 남는 것은 방언과
 * 무관한 판단 — 지금 리더인가, 끊기면 왜 아닌가, 물러나면 무엇을 적는가 — 이다
 * (docs/adr-multi-db.md 「리더 선출」).
 */
import type { LeaderLock, LeaderSession } from '../store/db.js';
import { openLeaderLock } from '../store/open.js';

export type Leadership = {
  isLeader: boolean;
  /** 리더일 때만 있다. 엄격 단조 decimal string. */
  token: string | undefined;
  since: string | undefined;
  holder: string;
  /** 리더가 아니라면 왜. */
  reason: string | undefined;
};

export class LeaderElection {
  readonly #lock: LeaderLock;
  #session: LeaderSession | undefined;
  #token: string | undefined;
  #since: string | undefined;
  #reason: string | undefined = '아직 선출을 시도하지 않았다';
  #lost = false;

  /** `source` 가 문자열이면 DSN 이다 — 그 스킴의 잠금 구현을 고른다. */
  constructor(
    source: string | LeaderLock,
    readonly holder: string,
  ) {
    this.#lock = typeof source === 'string' ? openLeaderLock(source) : source;
  }

  /**
   * 리더가 되기를 **한 번** 시도한다. 못 되면 조용히 false.
   *
   * 기다리는 형태를 안 쓴다. 블로킹으로 잡으면 기동이 무한정 멈추고,
   * 그동안 이 프로세스는 살아 있지도 죽지도 않은 상태가 된다 — 스탠바이는 **읽기로
   * 서비스하면서** 대기해야 한다.
   */
  async tryAcquire(): Promise<boolean> {
    if (this.#session !== undefined && !this.#lost) return true;
    const r = await this.#lock.tryAcquire(this.holder);
    if (!r.ok) {
      this.#reason = r.reason;
      return false;
    }
    const session = r.session;
    // **끊기면 리더가 아니다.** 잠금은 세션이 죽으면 풀리므로, 세션이 끊긴 순간부터 이
    // 프로세스는 리더가 아니다. 오류의 사유가 닫힘의 사유보다 앞선다(닫힘은 덮지 않는다).
    session.onLost((kind, reason) => {
      this.#lost = true;
      if (kind === 'error') this.#reason = reason;
      else this.#reason ??= reason;
    });

    this.#session = session;
    this.#token = session.token;
    this.#since = session.since;
    this.#reason = undefined;
    this.#lost = false;
    return true;
  }

  /**
   * 지금 리더인가.
   *
   * **`tryAcquire()` 가 참이었다는 기억이 아니라 지금 상태를 답한다.** 세션이 끊기면
   * 락은 이미 풀렸고 다른 인스턴스가 신임 토큰으로 fence 를 지났을 수 있다.
   */
  get state(): Leadership {
    const ok = this.#session !== undefined && !this.#lost;
    return {
      isLeader: ok,
      token: ok ? this.#token : undefined,
      since: ok ? this.#since : undefined,
      holder: this.holder,
      reason: ok ? undefined : (this.#reason ?? '리더가 아니다'),
    };
  }

  /** 부작용을 내기 직전에 부른다. 리더가 아니면 던진다. */
  assertLeader(): string {
    const s = this.state;
    if (!s.isLeader || s.token === undefined) {
      throw new NotLeader(s.reason ?? '리더가 아니다');
    }
    return s.token;
  }

  /**
   * 자발적으로 물러난다.
   *
   * 락은 세션이 끝나면 어차피 풀리지만 **`released_at` 을 적는 것이 다르다** — 깨끗하게
   * 물러난 것과 죽은 것을 나중에 구분할 수 있어야 한다.
   */
  async release(): Promise<void> {
    const session = this.#session;
    this.#session = undefined;
    if (session === undefined) return;
    await session.release();
    this.#token = undefined;
    this.#reason = '스스로 물러났다';
  }
}

/** 리더가 아닌데 부작용을 내려 했다. **503 이다** — 다른 곳에서는 성공할 수 있다. */
export class NotLeader extends Error {
  readonly status = 503;
  readonly code = 'not_leader';
  constructor(reason: string) {
    super(`이 인스턴스는 리더가 아니다 — ${reason}`);
    this.name = 'NotLeader';
  }
}
