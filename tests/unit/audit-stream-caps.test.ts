/**
 * 흘러 들어오는 것에 상한 — 검수 2026-08-24 G4
 *
 * 두 자리가 같은 모양이다. **양쪽 다 상대가 협조해야만 끝난다.**
 *
 * ── ㉠ SSE: 안 읽는 소비자
 *
 * `openEventStream` 의 살아 있음 판정이 이렇다:
 *
 *   const writable = () => !res.destroyed && !res.writableEnded;
 *
 * 소켓이 **살아는 있는데 안 읽는** 소비자(브라우저 탭이 얼었거나, 느린 망 뒤에 있거나,
 * 일부러 안 읽거나)는 이 판정을 통과한다. 그러면 `publish` 마다 쓴 바이트가 Node 의
 * 쓰기 버퍼에 쌓인다 — **끊기지 않으므로 영원히.** TCP 흐름 제어는 상대를 못 밀어내고
 * 우리 쪽 힙만 키운다.
 *
 * 그리고 `publish` 는 apply·헬스 투영 경로 안에서 불린다. 즉 이 메모리는 **트래픽이
 * 아니라 우리 자신의 제어 평면 활동**에 비례해서 자란다.
 *
 * ── ㉡ 원격 드라이버: 큰 응답
 *
 *   let text = ''; r.on('data', (c) => { text += c; });
 *
 * 에이전트 쪽 창구(`agent-server` 의 `readJson`)는 **4 MiB 상한을 갖고 있다** — 그리고
 * 그 주석이 이유를 적어 뒀다: *"다 받고 나서 거절하면 그 사이 메모리를 먹는다."*
 * 같은 판단이 **반대 방향에는 없다.** CP 는 에이전트가 주는 것을 무한히 받는다.
 *
 * 방향이 반대라고 위험이 반대인 것이 아니다 — CP 는 에이전트보다 **적고**, 하나가
 * 여럿을 본다. 이 저장소의 표현으로 *"자리가 둘이면 언젠가 갈린다"* 의 한 판이고,
 * 여기서는 이미 갈려 있었다.
 */
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { EventHub, openEventStream } from '../../src/api/events.js';
import { RemoteDataplaneDriver, RemoteDpUnreachable } from '../../src/dp/remote.js';

let server: Server | undefined;

afterEach(async () => {
  const s = server;
  server = undefined;
  if (s !== undefined) await new Promise<void>((r) => s.close(() => r()));
});

/**
 * **안 읽는 소비자**를 만든다.
 *
 * 소켓을 열어 두고 한 바이트도 안 읽는다 — `pause()` 로 흐름을 멈추면 커널 버퍼가
 * 차고, 그다음부터 서버가 쓰는 것은 전부 서버의 `writableLength` 에 쌓인다.
 * 이것이 실제 배포에서 얼어붙은 탭·느린 망이 하는 일과 같다.
 */
async function sseWithStalledConsumer(): Promise<{
  res: ServerResponse;
  streamDone: Promise<void>;
  hub: EventHub;
  stop: () => void;
}> {
  const hub = new EventHub();
  let capture!: (v: { res: ServerResponse; streamDone: Promise<void> }) => void;
  const opened = new Promise<{ res: ServerResponse; streamDone: Promise<void> }>((r) => { capture = r; });

  server = createServer((req, res) => {
    const streamDone = openEventStream({
      req, res, hub,
      snapshot: () => Promise.resolve({ hello: 'world' }),
      heartbeatMs: 3_600_000,          // 하트비트가 이 측정에 끼어들지 않게
    });
    capture({ res, streamDone });
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
  const port = (server?.address() as AddressInfo).port;

  const { connect } = await import('node:net');
  const sock = connect({ host: '127.0.0.1', port });
  await new Promise<void>((r) => sock.on('connect', () => r()));
  sock.write('GET /events HTTP/1.1\r\nhost: x\r\n\r\n');
  // **한 바이트도 안 읽는다.**
  sock.pause();

  const { res, streamDone } = await opened;
  return { res, streamDone, hub, stop: () => sock.destroy() };
}

/** 1 MiB 짜리 이벤트 하나. */
const fat = (hub: EventHub): void => {
  hub.publish('fat', { blob: 'x'.repeat(1024 * 1024) });
};

describe('안 읽는 SSE 소비자', () => {
  it('안 읽는 소비자가 버퍼를 무한히 못 키운다', async () => {
    const { res, streamDone, hub, stop } = await sseWithStalledConsumer();
    try {
      // 커널 버퍼가 찰 때까지, 그리고 그 뒤로도 계속 민다.
      for (let i = 0; i < 64 && !res.writableEnded && !res.destroyed; i += 1) {
        fat(hub);
        await new Promise((r) => setImmediate(r));
      }
      // **끊겼어야 한다.** 안 끊기면 64 MiB 가 이 프로세스의 힙에 있다.
      await Promise.race([
        streamDone,
        new Promise((_r, reject) => setTimeout(() => reject(new Error('안 끊겼다')), 5_000)),
      ]);
      expect(res.writableEnded || res.destroyed).toBe(true);
    } finally {
      stop();
    }
  }, 30_000);

  it('구독도 함께 놓는다 — 죽은 구독이 허브에 안 쌓인다', async () => {
    const { res, streamDone, hub, stop } = await sseWithStalledConsumer();
    try {
      expect(hub.size).toBe(1);
      for (let i = 0; i < 64 && !res.writableEnded && !res.destroyed; i += 1) {
        fat(hub);
        await new Promise((r) => setImmediate(r));
      }
      await Promise.race([
        streamDone,
        new Promise((_r, reject) => setTimeout(() => reject(new Error('안 끊겼다')), 5_000)),
      ]);
      expect(hub.size).toBe(0);
    } finally {
      stop();
    }
  }, 30_000);

  /** **되는 것을 못 쓰게 만들지 않는다.** 읽는 소비자는 계속 받는다. */
  it('읽는 소비자는 안 끊긴다 — 상한은 안 읽는 쪽에만 걸린다', async () => {
    const hub = new EventHub();
    const got: string[] = [];
    let streamDone!: Promise<void>;

    server = createServer((req, res) => {
      streamDone = openEventStream({
        req, res, hub,
        snapshot: () => Promise.resolve({}),
        heartbeatMs: 3_600_000,
      });
    });
    await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
    const port = (server?.address() as AddressInfo).port;

    const r = await fetch(`http://127.0.0.1:${port}/events`);
    const reader = r.body?.getReader();
    const pump = (async (): Promise<void> => {
      for (;;) {
        const chunk = await reader?.read();
        if (chunk === undefined || chunk.done) return;
        got.push(new TextDecoder().decode(chunk.value));
        if (got.length > 40) return;
      }
    })();

    for (let i = 0; i < 40; i += 1) {
      fat(hub);
      await new Promise((res2) => setTimeout(res2, 1));
    }
    await Promise.race([pump, new Promise((res2) => setTimeout(res2, 3_000))]);

    // 다 읽는 소비자에게는 상한이 안 걸린다.
    expect(got.length).toBeGreaterThan(0);
    await reader?.cancel().catch(() => undefined);
    await Promise.race([streamDone, new Promise((res2) => setTimeout(res2, 2_000))]);
  }, 30_000);
});

describe('원격 드라이버가 받는 응답', () => {
  /**
   * 에이전트 쪽 창구는 4 MiB 상한을 **갖고 있었다**. 반대 방향에는 없었다.
   *
   * 여기서는 `agent-server` 대신 **평범한 https 서버**로 에이전트를 흉내 낸다 —
   * 진짜 창구는 이만큼 큰 응답을 만들 방법이 없고, 재려는 것은 「에이전트가 이렇게
   * 답하면 CP 가 뭘 하는가」이기 때문이다. `tests/store/acme-runner` 가 가짜 CA 를
   * 쓰는 것과 같은 이유다.
   */
  it('원격 응답이 상한을 넘으면 못 물었다가 된다 — 무한히 안 받는다', async () => {
    const { execFileSync } = await import('node:child_process');
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createServer: createHttps } = await import('node:https');

    const dir = mkdtempSync(join(tmpdir(), 'bary-cap-'));
    try {
      const cnf = join(dir, 'openssl.cnf');
      execFileSync('sh', ['-c',
        `printf '%s\\n' '[req]' 'distinguished_name=dn' '[dn]' '[ext]' `
        + `'subjectAltName=DNS:localhost,IP:127.0.0.1' 'basicConstraints=CA:FALSE' > ${cnf}`]);
      const run = (args: string[]): void => { execFileSync('openssl', args, { stdio: 'ignore' }); };
      run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
        '-subj', '/CN=bary-cap-ca', '-keyout', join(dir, 'ca.key'), '-out', join(dir, 'ca.pem')]);
      for (const [name, cn] of [['server', 'localhost'], ['client', 'cp-1']] as const) {
        run(['req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${cn}`,
          '-keyout', join(dir, `${name}.key`), '-out', join(dir, `${name}.csr`), '-config', cnf]);
        run(['x509', '-req', '-in', join(dir, `${name}.csr`), '-days', '2',
          '-CA', join(dir, 'ca.pem'), '-CAkey', join(dir, 'ca.key'), '-CAcreateserial',
          '-out', join(dir, `${name}.pem`), '-extfile', cnf, '-extensions', 'ext']);
      }

      // **끝나지 않는 큰 응답.** 200 을 주고 계속 흘린다.
      const flood = createHttps({
        cert: readFileSync(join(dir, 'server.pem')),
        key: readFileSync(join(dir, 'server.key')),
        ca: readFileSync(join(dir, 'ca.pem')),
        requestCert: true, rejectUnauthorized: true,
      }, (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        const chunk = `{"pad":"${'x'.repeat(256 * 1024)}"}`;
        const pump = (): void => {
          while (!res.destroyed && res.write(chunk)) { /* 흐름이 막힐 때까지 */ }
        };
        res.on('drain', pump);
        res.on('error', () => { /* 우리가 끊으면 여기로 온다 */ });
        pump();
      });
      await new Promise<void>((r) => flood.listen(0, '127.0.0.1', r));
      const port = (flood.address() as AddressInfo).port;

      const driver = new RemoteDataplaneDriver({
        baseUrl: `https://localhost:${port}`,
        clientCertFile: join(dir, 'client.pem'),
        clientKeyFile: join(dir, 'client.key'),
        caFile: join(dir, 'ca.pem'),
        timeoutMs: 20_000,
      });
      try {
        const e = await driver.status().catch((x: unknown) => x);
        // **못 물었다**이지 판정이 아니다 — 우리가 못 읽은 것이다.
        expect(e).toBeInstanceOf(RemoteDpUnreachable);
      } finally {
        driver.close();
        await new Promise<void>((r) => flood.close(() => r()));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
