/**
 * SSE — DESIGN.md §5.2 `/api/v1/events` · §10
 *
 * GUI 는 폴링하지 않는다. 연결이 열리면 **지금 상태 스냅샷**을 먼저 주고, 그 다음
 * 델타와 하트비트를 흘린다. 스냅샷에 `health` 가 있다 — 연결 직후
 * `/health/backends` 를 다시 치지 않기 위해. 판정 변경은 `health` 델타다.
 * 하트비트는 주석이다 — 클라이언트가 이벤트로 오해하면 안 되는 신호다.
 *
 * 이 모듈은 브로드캐스트만 한다. 무엇을 내보낼지는 핸들러가 정한다.
 */
import type { ServerResponse } from 'node:http';

export type SseEvent = {
  event: string;
  data: unknown;
  id?: string;
};

export class EventHub {
  #n = 0;
  readonly #subs = new Set<(e: SseEvent) => void>();

  subscribe(fn: (e: SseEvent) => void): () => void {
    this.#subs.add(fn);
    return () => {
      this.#subs.delete(fn);
    };
  }

  get size(): number {
    return this.#subs.size;
  }

  publish(event: string, data: unknown): SseEvent {
    this.#n += 1;
    const framed: SseEvent = { event, data, id: String(this.#n) };
    for (const fn of this.#subs) fn(framed);
    return framed;
  }
}

export function writeSse(res: ServerResponse, ev: SseEvent): void {
  let out = '';
  if (ev.id !== undefined) out += `id: ${ev.id}\n`;
  out += `event: ${ev.event}\n`;
  for (const line of JSON.stringify(ev.data).split('\n')) out += `data: ${line}\n`;
  out += '\n';
  res.write(out);
}

export function writeHeartbeat(res: ServerResponse): void {
  res.write(': hb\n\n');
}

export const DEFAULT_HEARTBEAT_MS = 15_000;

/**
 * 구독자 하나가 못 읽고 쌓아 둘 수 있는 최대치 (검수 G4).
 *
 * `agent-server` 의 요청 본문 상한(4 MiB)과 **같은 값**이다. 둘 다 「상대가 협조하지
 * 않을 때 우리가 대신 물고 있는 바이트」이고, 다른 값을 쓸 이유가 없다.
 */
export const MAX_SSE_BUFFER_BYTES = 4 * 1024 * 1024;

/**
 * 스트림을 연다. Promise 는 클라이언트가 끊을 때 resolve 한다.
 * 핸들러가 이걸 await 해야 연결이 유지된다.
 */
export async function openEventStream(opts: {
  req: { on(event: 'close', fn: () => void): void };
  res: ServerResponse;
  hub: EventHub;
  snapshot: () => Promise<unknown>;
  heartbeatMs?: number;
}): Promise<void> {
  const { res, hub, snapshot } = opts;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  let drop: (() => void) | undefined;
  let tick: NodeJS.Timeout | undefined;
  let closed = false;
  let finish = (): void => {};
  const done = new Promise<void>((resolve) => {
    finish = () => {
      if (closed) return;
      closed = true;
      if (tick !== undefined) clearInterval(tick);
      drop?.();
      /**
       * **소켓도 놓는다** (검수 G4).
       *
       * 전에는 구독만 놓고 소켓은 그대로 뒀다. 클라이언트가 끊어서 온 경우에는 그게
       * 맞다(이미 파괴돼 있다). 그런데 **우리가 먼저 그만두기로 한 경우** — 쓰기가
       * 실패했거나 버퍼가 상한을 넘었거나 — 소켓을 안 놓으면 그 안에 쌓인 바이트가
       * 그대로 남는다. 놓기로 했으면 물고 있는 것도 놓아야 한다.
       */
      res.destroy();
      resolve();
    };
  });

  /**
   * **끊김을 스냅샷보다 먼저 잡는다** (검수 B-06).
   *
   * 전에는 `await snapshot()` 뒤에 리스너를 걸었다. 스냅샷은 `status()` 와
   * `healthRows()` 로 DB 를 두 번 치는데, 그 사이에 끊기면 `close` 는 이미 지나간
   * 뒤다 — **나중에 건 리스너는 영영 안 불린다.** 그러면 이 Promise 가 resolve 되지
   * 않아 핸들러가 안 끝나고, `drop()` 도 안 불려 죽은 구독이 허브에 영구히 쌓인다.
   */
  opts.req.on('close', finish);

  const data = await snapshot();
  // 스냅샷을 만드는 동안 끊겼으면 쓸 곳이 없다. `finish` 는 이미 돌았다.
  if (closed) return done;
  writeSse(res, { event: 'snapshot', data });

  /**
   * **쓰기 실패는 그 구독자만의 일이다.**
   *
   * `publish` 는 apply·헬스 투영 같은 경로 안에서 불린다. 여기서 던지면 SSE 구독자
   * 하나 때문에 그 경로가 실패한다. 그리고 파괴된 소켓에 `res.write` 하는 것은 Node 에서
   * 던지지 않고 **비동기 'error' 이벤트**로 오므로, 상태를 먼저 본다.
   */
  /**
   * **안 읽는 소비자를 살아 있다고 안 본다** (검수 G4).
   *
   * 전에는 `!res.destroyed && !res.writableEnded` 뿐이었다. 소켓이 **살아는 있는데
   * 안 읽는** 소비자(얼어붙은 탭, 느린 망 뒤, 일부러 안 읽는 클라이언트)는 그 판정을
   * 통과한다. 그러면 `publish` 마다 쓴 바이트가 Node 의 쓰기 버퍼에 쌓이고,
   * **끊기지 않으므로 영원히 쌓인다.** TCP 흐름 제어는 상대를 못 밀어내고 우리 쪽
   * 힙만 키운다.
   *
   * 그리고 `publish` 는 apply·헬스 투영 경로 안에서 불린다 — 이 메모리는 트래픽이
   * 아니라 **우리 자신의 제어 평면 활동**에 비례해서 자란다.
   *
   * 상한을 넘으면 그 구독자를 놓는다. **SSE 는 재연결이 프로토콜에 있다**
   * (`Last-Event-ID`) — 끊는 것이 그 소비자에게도 최선이고, 안 끊으면 그 소비자
   * 하나가 전체 프로세스를 위험에 빠뜨린다.
   */
  const writable = (): boolean =>
    !res.destroyed && !res.writableEnded && res.writableLength <= MAX_SSE_BUFFER_BYTES;
  drop = hub.subscribe((ev) => {
    if (!writable()) { finish(); return; }
    try {
      writeSse(res, ev);
    } catch {
      finish();
    }
  });
  tick = setInterval(() => {
    if (!writable()) { finish(); return; }
    try {
      writeHeartbeat(res);
    } catch {
      finish();
    }
  }, opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  tick.unref?.();

  return done;
}
