/**
 * 화면이 붙어 있어도 종료가 끝난다 — 검수 2026-08-24 D9
 *
 * ── `server.close()` 는 **열린 연결을 기다린다**
 *
 * 데몬의 종료 경로가 이렇다:
 *
 *   const stop = () => {
 *     server.close(() => { …정리… election.release() … process.exit(0) });
 *   };
 *
 * `close()` 의 콜백은 **모든 연결이 끝난 뒤에** 불린다. 그런데 SSE 는 끝나지 않는
 * 연결이다 — GUI 가 한 탭이라도 열어 두면 그 콜백이 안 온다. 그러면:
 *
 *   · 리더 락(`election.release()`)이 안 놓인다
 *   · durable store 락(`agentStore.release()`)이 안 놓인다
 *   · 프로세스가 안 나가고, 오케스트레이터의 `SIGKILL` 유예가 다 지나야 죽는다
 *
 * 그리고 그 뒤에 뜨는 인스턴스는 **죽은 주인의 락을 가려내는 `/proc` 폴백**에 기댄다.
 * `agentStore.release` 의 주석이 그 폴백을 이미 적어 뒀다: *"그 파일을 못 읽는
 * 플랫폼에서는 `stillHolding` 이 안전한 쪽(살아 있다)으로 틀려 기동이 막힌다."*
 * 즉 **깨끗한 종료가 안 되는 것이 다음 기동의 위험**이다.
 *
 * ── 화면에 먼저 알린다
 *
 * 소켓을 그냥 끊으면 브라우저는 재연결을 시도한다(SSE 의 기본 동작). 우리가 내려가는
 * 중이라면 그 재연결은 실패하고, 화면은 「끊겼다」가 아니라 「멎었다」로 보인다.
 * 닫기 전에 스트림을 **정상 종료**해 주는 것이 그 차이를 만든다.
 *
 * ── 이 파일이 재는 것
 *
 * 데몬 전체를 띄우지 않는다 — PG 가 필요하고, 그러면 이 판정이 도커에 매달린다.
 * 대신 **같은 기계 부품**을 그대로 쓴다: 진짜 `http.Server` · 진짜 `openEventStream` ·
 * 진짜 SSE 클라이언트. 데몬의 `stop` 이 부르는 것도 여기서 부르는 것과 같은 함수다.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { EventHub, openEventStream } from '../../src/api/events.js';

let server: Server | undefined;

afterEach(async () => {
  const s = server;
  server = undefined;
  if (s !== undefined) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

/** SSE 하나가 붙어 있는 서버. */
async function withOpenStream(): Promise<{
  srv: Server;
  hub: EventHub;
  body: ReadableStreamDefaultReader<Uint8Array> | undefined;
}> {
  const hub = new EventHub();
  server = createServer((req, res) => {
    void openEventStream({
      req, res, hub,
      snapshot: () => Promise.resolve({ ok: true }),
      heartbeatMs: 3_600_000,
    });
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  const r = await fetch(`http://127.0.0.1:${port}/events`);
  const body = r.body?.getReader();
  // 스냅샷을 한 번 읽어 **구독이 실제로 걸린 것**을 확인한다.
  await body?.read();
  return { srv: server, hub, body };
}

const closedWithin = (srv: Server, ms: number): Promise<boolean> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    srv.close(() => { clearTimeout(timer); resolve(true); });
  });

describe('종료', () => {
  it('화면이 붙어 있어도 종료가 끝난다', async () => {
    const { srv, hub } = await withOpenStream();
    expect(hub.size).toBe(1);

    // **데몬의 `stop` 이 하는 것과 같은 순서다.** 먼저 스트림을 닫고, 그다음 서버를 닫는다.
    hub.closeAll();

    expect(await closedWithin(srv, 5_000)).toBe(true);
    expect(hub.size).toBe(0);
  }, 20_000);

  it('닫힌 스트림은 정상 종료다 — 화면이 「끊겼다」를 안다', async () => {
    const { hub, body } = await withOpenStream();
    hub.closeAll();
    // 소켓을 그냥 파괴하면 여기서 던진다. 정상 종료면 `done` 이 온다.
    const next = await body?.read();
    expect(next?.done).toBe(true);
  }, 20_000);

  it('두 번 불러도 안전하다 — SIGTERM 과 SIGINT 가 겹칠 수 있다', async () => {
    const { srv, hub } = await withOpenStream();
    hub.closeAll();
    hub.closeAll();
    expect(await closedWithin(srv, 5_000)).toBe(true);
  }, 20_000);

  it('붙은 것이 없으면 그냥 끝난다 — 되는 것을 안 깬다', async () => {
    const hub = new EventHub();
    server = createServer(() => { /* 아무도 안 붙는다 */ });
    await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
    hub.closeAll();
    expect(await closedWithin(server, 5_000)).toBe(true);
  }, 20_000);
});
