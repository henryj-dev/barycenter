/**
 * 검수 2026-08-22 · B-06 — **스냅샷 도중 끊겨도 구독이 남지 않는다**
 *
 * `openEventStream` 은 `await snapshot()` **다음에** `req.on('close')` 를 걸었다.
 * 스냅샷은 `control.status()` 와 `healthRows()` 로 DB 를 두 번 친다 — 그 사이에
 * 클라이언트가 끊으면 `close` 는 이미 발생한 뒤이고, **나중에 건 리스너는 영영 안 불린다.**
 *
 * 그러면 Promise 가 resolve 되지 않아 핸들러가 안 끝나고, `drop()` 도 안 불려
 * **죽은 구독이 `EventHub` 에 영구히 쌓인다.** 이후 모든 `publish` 가 파괴된 응답에
 * 쓴다. 새로고침을 반복하는 GUI 나 재연결하는 스크레이퍼가 이걸 계속 만든다.
 */
import type { ServerResponse } from 'node:http';

import { describe, expect, it } from 'vitest';

import { EventHub, openEventStream } from '../../src/api/events.js';

/**
 * 진짜 `IncomingMessage` 처럼 **한 번만** 'close' 를 낸다.
 *
 * 이미 지나간 이벤트에 나중에 리스너를 걸면 안 불리는 것 — 그게 이 버그의 전부다.
 * `EventEmitter` 를 그대로 쓰면 같은 성질이지만, 여기서는 "언제 걸었는가" 가 요점이라
 * 손으로 만들어 그 순간을 드러낸다.
 */
function fakeReq(): { on(e: 'close', fn: () => void): void; close(): void } {
  const handlers: (() => void)[] = [];
  let fired = false;
  return {
    on(_e, fn) {
      // 이미 끝난 뒤에 걸면 영영 안 불린다. **관대하게 봐주지 않는다** —
      // 그러면 이 테스트가 진짜 IncomingMessage 와 다른 것을 재게 된다.
      if (!fired) handlers.push(fn);
    },
    close() {
      fired = true;
      for (const fn of handlers) fn();
    },
  };
}

function fakeRes(): ServerResponse & { chunks: string[]; destroyed: boolean } {
  const res = {
    chunks: [] as string[],
    destroyed: false,
    writableEnded: false,
    writeHead() { return res; },
    write(chunk: string) {
      if (res.destroyed) throw new Error('write after destroy');
      res.chunks.push(chunk);
      return true;
    },
    end() { res.writableEnded = true; return res; },
  };
  return res as unknown as ServerResponse & { chunks: string[]; destroyed: boolean };
}

const raceWith = <T>(p: Promise<T>, ms: number): Promise<T | 'hung'> =>
  Promise.race([p, new Promise<'hung'>((r) => { setTimeout(() => r('hung'), ms); })]);

describe('SSE 조기 종료 (검수 B-06)', () => {
  it('스냅샷 도중 끊겨도 구독이 남지 않는다', async () => {
    const hub = new EventHub();
    const req = fakeReq();
    const res = fakeRes();

    const stream = openEventStream({
      req,
      res,
      hub,
      // 스냅샷이 DB 를 치는 동안 클라이언트가 끊는다 — 실제로 있는 창이다.
      snapshot: async () => {
        req.close();
        res.destroyed = true;
        return { head: '1' };
      },
      heartbeatMs: 20,
    });

    expect(await raceWith(stream.then(() => 'closed' as const), 250)).toBe('closed');
    expect(hub.size).toBe(0);
  });

  it('정상 흐름은 그대로다 — 스냅샷을 주고 델타를 흘리고 끊을 때 푼다', async () => {
    const hub = new EventHub();
    const req = fakeReq();
    const res = fakeRes();

    const stream = openEventStream({
      req, res, hub, snapshot: async () => ({ head: '7' }), heartbeatMs: 20,
    });
    // 스냅샷이 나갈 때까지 한 틱 기다린다.
    await new Promise((r) => { setTimeout(r, 10); });

    expect(hub.size).toBe(1);
    expect(res.chunks.join('')).toContain('event: snapshot');

    hub.publish('revision', { revision: '8' });
    expect(res.chunks.join('')).toContain('event: revision');

    req.close();
    expect(await raceWith(stream.then(() => 'closed' as const), 250)).toBe('closed');
    expect(hub.size).toBe(0);
  });

  it('쓰기가 실패한 구독자는 스스로 빠진다', async () => {
    const hub = new EventHub();
    const req = fakeReq();
    const res = fakeRes();

    const stream = openEventStream({
      req, res, hub, snapshot: async () => ({}), heartbeatMs: 20,
    });
    await new Promise((r) => { setTimeout(r, 10); });
    expect(hub.size).toBe(1);

    // 소켓이 죽었는데 'close' 를 못 받은 경우. **publish 가 던지면 안 된다** —
    // 그러면 apply 나 헬스 투영이 SSE 하나 때문에 실패한다.
    res.destroyed = true;
    expect(() => hub.publish('apply', { phase: 'activated' })).not.toThrow();
    expect(hub.size).toBe(0);
    expect(await raceWith(stream.then(() => 'closed' as const), 250)).toBe('closed');
  });
});
