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
  writeSse(res, { event: 'snapshot', data: await snapshot() });

  const drop = hub.subscribe((ev) => writeSse(res, ev));
  const tick = setInterval(() => writeHeartbeat(res), opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  tick.unref?.();

  await new Promise<void>((resolve) => {
    opts.req.on('close', () => {
      clearInterval(tick);
      drop();
      resolve();
    });
  });
}
