/**
 * 판정에 안 쓰는 본문을 안 모은다 — 검수 2026-08-24 D10
 *
 * ── `probeHttp` 는 본문을 **언제나** 통째로 모았다
 *
 *   const chunks: Buffer[] = [];
 *   res.on('data', (c) => { chunks.push(c); });
 *   res.on('end', () => { …상태 코드를 여기서 본다… });
 *
 * `expectBody` 가 없으면 그 `chunks` 는 **한 번도 안 읽힌다.** 그리고 `expectBody` 는
 * 옵트인이라 **안 적은 배포가 기본**이다 (`configuredHttpProbe` 의 주석: *"안 적으면
 * `GET /` + 2xx 다"*). 즉 기본 배포에서 프로버는 백엔드가 주는 것을 전부 메모리로
 * 받고 나서 버린다 — 백엔드마다, `BARY_PROBE_INTERVAL_MS`(기본 2 초)마다.
 *
 * ── 메모리보다 먼저 드러나는 것은 **판정이 틀리는 것**이다
 *
 * 상태 코드 판정이 `'end'` 안에 있다. 그래서 **본문을 안 끝내는 백엔드**(SSE·긴
 * 스트리밍·청크를 흘리다 멈춘 앱)는 헤더에 `200` 을 주고도 타임아웃으로 `unhealthy`
 * 가 된다. 프로브 경로가 `/` 기본값이면 그런 응답은 드물지 않다.
 *
 * 이 저장소가 여러 번 잡은 *"필드는 있는데 아무도 안 읽는다"* 의 한 판이고,
 * 여기서는 그 안 읽는 필드를 **모으는 값이 판정을 밀어낸다.**
 *
 * ── 무엇이 옳은가
 *
 *   `expectBody` 없음  헤더로 판정하고 **끊는다.** 본문은 판정에 안 쓴다
 *   `expectBody` 있음  기대 길이를 넘는 순간 **불일치다.** 더 읽을 이유가 없다
 *   상태 코드 불일치    본문을 기다리지 않는다. 이미 답이 나왔다
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { probeHttp } from '../../src/control/health.js';

let server: Server | undefined;

afterEach(async () => {
  const s = server;
  server = undefined;
  if (s !== undefined) await new Promise<void>((r) => s.close(() => r()));
});

/** 서버가 무엇을 겪었는지. **끊겼는지**가 이 파일의 관측점이다. */
type Seen = {
  /** 응답을 끝까지 쓴 적이 있는가 (`finish`). */
  finished: boolean;
  /** 소켓이 닫힌 적이 있는가 (`close`). */
  closed: boolean;
  /** 클라이언트에 실제로 흘러간 바이트. */
  wrote: number;
};

/**
 * 백엔드 하나를 띄운다.
 *
 * `handler` 가 `res` 를 받아 마음대로 한다 — **끝내지 않아도 된다.** 안 끝내는
 * 응답이 이 파일에서 제일 중요한 무대다.
 */
async function backend(
  handler: (res: import('node:http').ServerResponse, seen: Seen) => void,
): Promise<{ port: number; seen: Seen }> {
  const seen: Seen = { finished: false, closed: false, wrote: 0 };
  server = createServer((_req, res) => {
    res.on('finish', () => { seen.finished = true; });
    res.on('close', () => { seen.closed = true; });
    handler(res, seen);
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
  return { port: (server?.address() as AddressInfo).port, seen };
}

/** 끝나지 않는 200 응답. 헤더와 첫 청크만 주고 멈춘다. */
const neverEnds = (status = 200) =>
  (res: import('node:http').ServerResponse, seen: Seen): void => {
    res.writeHead(status, { 'content-type': 'text/plain' });
    res.write('첫 청크\n');
    seen.wrote += 8;
    // 일부러 `end()` 를 안 부른다.
  };

describe('판정에 안 쓰는 본문', () => {
  /**
   * **이것이 이 항목의 진짜 증상이다.** 메모리는 그 다음이다 — 상태 코드 판정이
   * `'end'` 안에 있어서, 헤더에 200 을 준 백엔드가 타임아웃으로 죽은 것이 된다.
   */
  it('판정에 안 쓰는 본문을 안 모은다 — 안 끝나는 200 도 산 것이다', async () => {
    const { port, seen } = await backend(neverEnds());
    const reason = await probeHttp('127.0.0.1', port, 1_000, { path: '/' });
    expect(reason).toBeUndefined();
    // 그리고 **우리가 끊었다** — 서버는 응답을 끝낸 적이 없다.
    expect(seen.finished).toBe(false);
  }, 20_000);

  it('상태 코드가 틀리면 본문을 안 기다린다 — 이미 답이 나왔다', async () => {
    const { port } = await backend(neverEnds(503));
    const reason = await probeHttp('127.0.0.1', port, 1_000, { path: '/' });
    // 타임아웃 메시지가 아니라 **상태 코드 메시지**여야 한다.
    expect(reason).toContain('503');
    expect(reason).not.toContain('안에 응답이 없다');
  }, 20_000);

  it('`expectStatus` 를 좁혀도 마찬가지다', async () => {
    const { port } = await backend(neverEnds(200));
    const reason = await probeHttp('127.0.0.1', port, 1_000,
      { path: '/', expectStatus: [204] });
    expect(reason).toContain('200');
    expect(reason).not.toContain('안에 응답이 없다');
  }, 20_000);
});

describe('판정에 쓰는 본문', () => {
  it('기대와 같으면 산 것이다 — 되는 것을 안 깬다', async () => {
    const { port } = await backend((res) => { res.writeHead(200); res.end('OK'); });
    expect(await probeHttp('127.0.0.1', port, 1_000,
      { path: '/', expectBody: 'OK' })).toBeUndefined();
  }, 20_000);

  it('기대와 다르면 불일치다', async () => {
    const { port } = await backend((res) => { res.writeHead(200); res.end('NO'); });
    expect(await probeHttp('127.0.0.1', port, 1_000,
      { path: '/', expectBody: 'OK' })).toContain('기대와 다르다');
  }, 20_000);

  it('비어 있으면 그렇다고 말한다 — 다른 것과 안 섞는다', async () => {
    const { port } = await backend((res) => { res.writeHead(200); res.end(''); });
    expect(await probeHttp('127.0.0.1', port, 1_000,
      { path: '/', expectBody: 'OK' })).toContain('비어 있다');
  }, 20_000);

  /**
   * **기대보다 긴 본문은 더 읽을 이유가 없다.** 한 바이트만 넘어도 정확일치는
   * 이미 불가능하다. 안 끊으면 안 끝나는 본문이 여기서도 타임아웃이 된다.
   */
  it('기대보다 길면 그 순간 불일치다 — 끝까지 안 기다린다', async () => {
    const { port, seen } = await backend((res, s) => {
      res.writeHead(200);
      res.write('OK');
      s.wrote += 2;
      // 기대(`OK`)를 넘겼다. 그리고 끝내지 않는다.
      res.write('더 있다');
      s.wrote += 9;
    });
    const reason = await probeHttp('127.0.0.1', port, 1_000,
      { path: '/', expectBody: 'OK' });
    expect(reason).toContain('기대와 다르다');
    expect(reason).not.toContain('안에 응답이 없다');
    expect(seen.finished).toBe(false);
  }, 20_000);
});
