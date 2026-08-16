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
 * ── 세션 하나를 통째로 쓴다 ─────────────────────────────────────────────
 *
 * advisory lock 은 **세션 스코프**다. 풀에서 커넥션을 빌려 잡으면 반납하는 순간 다른
 * 요청이 그 커넥션을 쓰고, 풀이 커넥션을 재활용하거나 끊으면 락이 조용히 풀린다.
 * 그래서 전용 `Client` 하나를 잡고 프로세스 수명 동안 들고 있는다.
 */
import pg from 'pg';

export type Leadership = {
  isLeader: boolean;
  /** 리더일 때만 있다. 엄격 단조 decimal string. */
  token: string | undefined;
  since: string | undefined;
  holder: string;
  /** 리더가 아니라면 왜. */
  reason: string | undefined;
};

/**
 * advisory lock 키.
 *
 * `hashtext()` 로 문자열에서 뽑고 싶어지는데, 그 함수는 **버전 간 안정성이 보장되지
 * 않는다.** PG 를 올린 뒤 키가 바뀌면 옛 리더와 새 리더가 서로 다른 락을 잡고 둘 다
 * 자기가 리더라고 믿는다 — 선출이 있는데 없는 것보다 나쁜 상태다. 상수로 박는다.
 */
const LOCK_KEY_HI = 0x62_61 as const;   // 'ba'
const LOCK_KEY_LO = 0x72_79 as const;   // 'ry'

export class LeaderElection {
  #client: pg.Client | undefined;
  #token: string | undefined;
  #since: string | undefined;
  #reason: string | undefined = '아직 선출을 시도하지 않았다';
  #lost = false;

  constructor(
    private readonly dsn: string,
    readonly holder: string,
  ) {}

  /**
   * 리더가 되기를 **한 번** 시도한다. 못 되면 조용히 false.
   *
   * 기다리는 형태(`pg_advisory_lock`)를 안 쓴다. 블로킹으로 잡으면 기동이 무한정 멈추고,
   * 그동안 이 프로세스는 살아 있지도 죽지도 않은 상태가 된다 — 스탠바이는 **읽기로
   * 서비스하면서** 대기해야 한다.
   */
  async tryAcquire(): Promise<boolean> {
    if (this.#client !== undefined && !this.#lost) return true;
    const client = new pg.Client({ connectionString: this.dsn });
    try {
      await client.connect();
      const r = await client.query(
        'SELECT pg_try_advisory_lock($1::int, $2::int) AS got', [LOCK_KEY_HI, LOCK_KEY_LO],
      );
      if (r.rows[0]?.got !== true) {
        await client.end().catch(() => undefined);
        this.#reason = '다른 인스턴스가 리더다 (advisory lock 을 못 잡았다)';
        return false;
      }

      // **락을 잡은 뒤에 토큰을 뽑는다.** 순서가 반대면 락을 못 잡은 인스턴스도 시퀀스를
      // 소모하고, 그러면 토큰이 "리더가 몇 번 바뀌었나" 를 뜻하지 않게 된다.
      const t = await client.query(`SELECT nextval('leader_token_seq')::text AS token`);
      const token = String(t.rows[0]?.token);
      const ins = await client.query(
        `INSERT INTO leadership (token, holder) VALUES ($1,$2) RETURNING acquired_at`,
        [token, this.holder],
      );

      // **끊기면 리더가 아니다.** advisory lock 은 세션이 죽으면 풀리므로, 커넥션이
      // 끊긴 순간부터 이 프로세스는 리더가 아니다. 그걸 안 보면 "PG 와의 연결은 끊겼는데
      // 자기는 리더라고 믿는" 프로세스가 부작용을 계속 낸다.
      client.on('error', (e) => {
        this.#lost = true;
        this.#reason = `리더 세션이 끊겼다: ${e.message}`;
      });
      client.on('end', () => {
        this.#lost = true;
        this.#reason ??= '리더 세션이 닫혔다';
      });

      this.#client = client;
      this.#token = token;
      this.#since = new Date(String(ins.rows[0]?.acquired_at)).toISOString();
      this.#reason = undefined;
      this.#lost = false;
      return true;
    } catch (e) {
      await client.end().catch(() => undefined);
      this.#reason = `선출 시도가 실패했다: ${String(e)}`;
      return false;
    }
  }

  /**
   * 지금 리더인가.
   *
   * **`tryAcquire()` 가 참이었다는 기억이 아니라 지금 상태를 답한다.** 세션이 끊기면
   * 락은 이미 풀렸고 다른 인스턴스가 신임 토큰으로 fence 를 지났을 수 있다.
   */
  get state(): Leadership {
    const ok = this.#client !== undefined && !this.#lost;
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
    const client = this.#client;
    this.#client = undefined;
    if (client === undefined) return;
    try {
      if (this.#token !== undefined) {
        await client.query('UPDATE leadership SET released_at = now() WHERE token = $1',
          [this.#token]);
      }
    } catch {
      /* 물러나는 길에 못 적어도 락은 세션 종료로 풀린다 */
    }
    await client.end().catch(() => undefined);
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
