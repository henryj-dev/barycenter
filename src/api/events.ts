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
  readonly #closers = new Set<() => void>();

  subscribe(fn: (e: SseEvent) => void): () => void {
    this.#subs.add(fn);
    return () => {
      this.#subs.delete(fn);
    };
  }

  /**
   * 스트림이 **자기 닫는 법**을 맡긴다 (검수 D9).
   *
   * 구독(`subscribe`)과 갈라 둔 이유: 구독은 「이벤트를 받겠다」이고 이건 「내려갈 때
   * 나를 닫아라」다. 하나로 묶으면 이벤트에 `__close__` 같은 특수값이 생기고, 그
   * 특수값은 언젠가 데이터로 새어 나간다.
   */
  onShutdown(fn: () => void): () => void {
    this.#closers.add(fn);
    return () => {
      this.#closers.delete(fn);
    };
  }

  get size(): number {
    return this.#subs.size;
  }

  /**
   * **열린 스트림을 전부 닫는다** (검수 D9).
   *
   * `server.close()` 의 콜백은 모든 연결이 끝난 뒤에 온다. SSE 는 끝나지 않는 연결이라,
   * GUI 가 한 탭이라도 열어 두면 **종료 정리가 통째로 안 돈다** — 리더 락도 durable
   * store 락도 안 놓이고, 프로세스는 오케스트레이터의 `SIGKILL` 유예가 다 지나야 죽는다.
   * 그리고 그 뒤에 뜨는 인스턴스는 죽은 주인을 가려내는 `/proc` 폴백에 기댄다.
   * **깨끗한 종료가 안 되는 것이 다음 기동의 위험이다.**
   *
   * 사본을 떠서 돈다 — 닫는 쪽이 `onShutdown` 의 해제를 부르므로 순회 중에 집합이 준다.
   */
  closeAll(): void {
    for (const fn of [...this.#closers]) fn();
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
  let dropCloser: (() => void) | undefined;
  let tick: NodeJS.Timeout | undefined;
  let closed = false;
  let finish = (_graceful?: boolean): void => {};
  const done = new Promise<void>((resolve) => {
    /**
     * `graceful` 이 참이면 **정상 종료**한다 (검수 D9).
     *
     * 우리가 내려가는 중일 때는 소켓을 그냥 끊으면 안 된다 — 브라우저가 재연결을
     * 시도하고, 그 재연결은 실패하며, 화면은 「끊겼다」가 아니라 **「멎었다」**로
     * 보인다. 스트림을 끝내 주면 그 차이가 생긴다.
     *
     * 나머지 경우(클라이언트가 끊었다 · 쓰기가 실패했다 · 버퍼가 상한을 넘었다)는
     * 파괴가 맞다 — 앞엣것은 이미 파괴돼 있고, 뒤 둘은 **우리가 그만두기로 한**
     * 경우라 물고 있는 바이트도 놓아야 한다 (검수 G4).
     */
    finish = (graceful = false) => {
      if (closed) return;
      closed = true;
      if (tick !== undefined) clearInterval(tick);
      drop?.();
      dropCloser?.();
      if (graceful && !res.destroyed && !res.writableEnded) res.end();
      else res.destroy();
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
  opts.req.on('close', () => finish());
  /**
   * **종료 등록도 스냅샷보다 먼저다** (검수 D9 · B-06 과 같은 이유).
   *
   * `server.close()` 는 열린 연결을 기다리고 SSE 는 끝나지 않는 연결이라, 이 등록이
   * 없으면 종료 정리가 통째로 안 돈다. 스냅샷은 DB 를 두 번 치므로 그 사이에 종료가
   * 시작될 수 있고, 그때 등록이 아직 없으면 **이 스트림만 종료에서 빠진다.**
   */
  dropCloser = hub.onShutdown(() => finish(true));

  const data = await snapshot();
  // 스냅샷을 만드는 동안 끊겼으면 쓸 곳이 없다. `finish` 는 이미 돌았다.
  if (closed) return done;
  writeSse(res, { event: 'snapshot', data });

  /**
   * 이 구독자에게 아직 써도 되는가.
   *
   * **쓰기 실패는 그 구독자만의 일이다.** `publish` 는 apply·헬스 투영 같은 경로 안에서
   * 불린다. 여기서 던지면 SSE 구독자 하나 때문에 그 경로가 실패한다. 그리고 파괴된
   * 소켓에 `res.write` 하는 것은 Node 에서 던지지 않고 **비동기 'error' 이벤트**로
   * 오므로, 상태를 먼저 본다.
   *
   * **그리고 안 읽는 소비자를 살아 있다고 안 본다** (검수 G4).
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
