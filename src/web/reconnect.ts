/**
 * SSE 재연결 정책 — 검수 2026-08-24 G1
 *
 * ── 지금은 재연결이 **아예 없다**
 *
 * `desk.svelte.ts` 의 `connect()` 는 스트림이 끝나거나(`chunk.done`) 던지면
 * `live = false` 만 하고 끝난다. 망이 잠깐 끊기거나 데몬이 재기동하면 **화면이 그
 * 자리에서 멈추고 다시는 안 살아난다.** 운영자는 그것이 「아무 일도 안 일어나는 중」
 * 인지 「연결이 죽은 것」인지 알 수 없다.
 *
 * ── `Last-Event-ID` 를 안 쓴다
 *
 * `EventHub` 가 이미 `id` 를 붙이므로 서버 쪽 절반은 있다. 그런데 **허브가 과거
 * 이벤트를 안 들고 있다** — 재개하려면 버퍼가 필요하고 그건 새 상태다. 그리고 버퍼는
 * 반드시 유한하므로 **간격이 버퍼보다 크면 스냅샷으로 돌아가야 한다.** 즉 그 길을
 * 고르면 **두 경로를 다 구현**해야 한다.
 *
 * 스트림은 열릴 때 **언제나 전체 스냅샷**을 먼저 준다. 그러니 재연결 = 새 스냅샷 =
 * 일관된 상태이고, 이건 **구성상 옳다** — 빠뜨릴 이벤트라는 개념이 없다. 대가는
 * 재연결마다 DB 한 번인데, 재연결은 드물다(하트비트가 15 초이고 정상 연결은 안 끊긴다).
 *
 * **덜 구현하면서 절대 안 틀리는 쪽**을 고른다. 버퍼는 「자라는 것에 상한이 없다」와
 * 「조용히 빠뜨린다」를 동시에 들여오는데, 이 저장소는 그 둘로 이미 여러 번 물렸다.
 *
 * ── 백오프
 *
 * 즉시 다시 붙으면 데몬이 재기동하는 동안 그 재기동을 방해한다. 지수로 늘리되
 * 상한을 둔다 — 상한이 없으면 오래 끊긴 뒤 화면이 영영 안 돌아온다.
 *
 * **지터를 넣는다.** 화면이 여럿이면 전부 같은 순간에 다시 붙고, 그게 재기동 직후의
 * 데몬에 제일 나쁜 순간이다.
 */

export type BackoffOptions = {
  /** 첫 대기. 기본 500ms. */
  baseMs?: number;
  /** 상한. 기본 30초 — 이보다 길면 사람이 새로고침한다. */
  maxMs?: number;
  /** 지터 비율. 기본 0.25 — 대기의 ±25%. */
  jitter?: number;
  /** 0..1. 테스트가 결정적으로 만들려고 갈아 끼운다. */
  random?: () => number;
};

/**
 * `attempt` 번째 재시도의 대기 시간 (0부터).
 *
 * **`attempt` 는 지금까지 실패한 횟수**다. 성공하면 부르는 쪽이 0 으로 되돌린다 —
 * 그 상태를 여기 두지 않는 이유는 이 함수가 순수해야 테스트가 시간을 안 쓰기 때문이다.
 */
export function backoffMs(attempt: number, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? 500;
  const max = opts.maxMs ?? 30_000;
  const jitter = opts.jitter ?? 0.25;
  const rand = opts.random ?? Math.random;

  // 지수. `attempt` 가 크면 `2 ** attempt` 가 폭발하므로 상한을 먼저 건다.
  const raw = Math.min(max, base * 2 ** Math.min(attempt, 30));
  // 지터는 **양쪽으로** 준다. 한쪽으로만 주면 평균이 밀린다.
  const spread = raw * jitter;
  const ms = raw - spread + rand() * spread * 2;
  // 음수·NaN 이 `setTimeout` 으로 가면 즉시 재시도가 된다 — 상한 아래로 접는다.
  return Math.max(0, Math.min(max, Math.round(ms)));
}
