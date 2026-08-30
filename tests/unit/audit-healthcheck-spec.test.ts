/**
 * 검수 2026-08-22 · B-07 — **5xx 는 healthy 가 아니다**
 *
 * `probeHttp` 는 **본문이 비어 있지 않으면 산 것으로 판정했다.** 그래서 500·502·503 과
 * 함께 온 에러 페이지가 전부 `healthy` 다 — 죽은 백엔드가 계속 트래픽을 받는다.
 * "연결만 열린 죽은 앱" 을 막으려고 본문을 보게 했는데, **정작 앱이 죽었다고 말하는
 * 신호(상태 코드)를 안 봤다.**
 *
 * 그리고 경로·기대본문을 정할 자리가 없었다. `HttpProbeOpts` 는 있는데 `HealthProber` 가
 * 안 넘겼다 — 이 저장소가 반복해서 잡는 *"필드는 있는데 아무도 안 읽는다"* 의 한 판이다.
 *
 * ⚠️ **판정 기본값이 바뀐다.** "본문이 비어 있지 않다" → "2xx 다". 200 에 빈 본문을 주던
 * 백엔드는 이제 healthy 이고, 500 에 에러 페이지를 주던 백엔드는 이제 unhealthy 다.
 * 후자가 이 수정의 요점이고, 전자는 애초에 상태 코드로 판정했어야 하는 자리다.
 *
 * 좁히는 설정(`Pool.healthCheck`)은 `Model` 을 넓히므로 A 표면을 움직인다. 이 회차에
 * 사람이 동결 해제를 결정해 함께 들어왔다 — 결함(위)과 손잡이(아래)를 같은 파일에서 잰다.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, describe, expect, it } from 'vitest';

import { inBatches, probeBackend, probePlanOf, probeHttp } from '../../src/control/health.js';
import type { Model } from '../../src/model/provisional.js';

const servers: { close(): void }[] = [];

afterAll(() => {
  for (const s of servers) s.close();
});

/** 상태 코드와 본문을 정해 주는 서버 하나. */
async function serve(status: number, body: string): Promise<number> {
  const s = createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'text/plain' });
    res.end(body);
  });
  servers.push(s);
  await new Promise<void>((r) => { s.listen(0, '127.0.0.1', r); });
  return (s.address() as AddressInfo).port;
}

describe('HTTP 헬스 판정 (검수 B-07)', () => {
  it('5xx 는 healthy 가 아니다', async () => {
    // 에러 페이지는 본문이 있다. 전에는 그것만 보고 살았다고 했다.
    const down = await serve(503, '<h1>Service Unavailable</h1>');
    expect(await probeHttp('127.0.0.1', down, 500, { path: '/' })).toBeDefined();

    const bad = await serve(500, 'internal error');
    expect(await probeHttp('127.0.0.1', bad, 500, { path: '/' })).toBeDefined();

    // 404 도 아니다 — 헬스 경로가 없다는 뜻이지 앱이 산다는 뜻이 아니다.
    const missing = await serve(404, 'not found');
    expect(await probeHttp('127.0.0.1', missing, 500, { path: '/healthz' })).toBeDefined();
  });

  it('2xx 는 본문이 비어도 healthy 다', async () => {
    // 204 는 정상 응답이다. 본문 유무로 재던 것이 틀렸다.
    const empty = await serve(204, '');
    expect(await probeHttp('127.0.0.1', empty, 500, { path: '/' })).toBeUndefined();
    const ok = await serve(200, 'ok');
    expect(await probeHttp('127.0.0.1', ok, 500, { path: '/' })).toBeUndefined();
  });

  it('기대 상태와 본문을 정할 수 있다', async () => {
    const teapot = await serve(418, 'brewing');
    // 기본으로는 죽었다.
    const http = (o: Record<string, unknown>) =>
      ({ mode: 'active', protocol: 'http', http: { path: '/', ...o } }) as const;
    expect(await probeBackend(http({}) as never, '127.0.0.1', teapot, 500)).toBeDefined();
    // 정해 주면 산다.
    expect(await probeBackend(http({ expectStatus: [418] }) as never,
      '127.0.0.1', teapot, 500)).toBeUndefined();
    // 본문까지 정하면 둘 다 맞아야 한다.
    expect(await probeBackend(http({ expectStatus: [418], expectBody: 'brewing' }) as never,
      '127.0.0.1', teapot, 500)).toBeUndefined();
    expect(await probeBackend(http({ expectStatus: [418], expectBody: 'other' }) as never,
      '127.0.0.1', teapot, 500)).toBeDefined();
  });

  it('풀의 healthCheck 가 프로버까지 내려간다', async () => {
    // **여기가 B-07 의 핵심이다.** 옵션 타입은 있었는데 프로버가 안 넘겼다.
    const model: Model = {
      listeners: [], httpRoutes: [], passthroughRoutes: [],
      pools: [
        {
          key: 'app', protocolClass: 'http', algorithm: 'round_robin',
          healthCheck: { path: '/healthz', expectStatus: [200, 204], expectBody: 'up' },
        },
        { key: 'plain', protocolClass: 'http', algorithm: 'round_robin' },
        { key: 'l4', protocolClass: 'tcp', algorithm: 'round_robin' },
      ],
      backends: [], certificates: [], tlsPolicies: [], sniBindings: [],
    };

    expect(probePlanOf(model, 'app').http).toEqual({
      path: '/healthz', expectStatus: [200, 204], expectBody: 'up',
    });
    // 안 정하면 기본값 — 경로 `/`, 2xx.
    expect(probePlanOf(model, 'plain').http).toEqual({ path: '/' });
    // **옛 거동을 그대로 못 박는다** (§4.3.1 로 넓힌 뒤에도): 안 적으면 stream 풀은
    // TCP connect 이고 HTTP 프로브가 없다. 넓힌 것이 기본값을 안 흔든다.
    expect(probePlanOf(model, 'l4').protocol).toBe('tcp_connect');
    expect(probePlanOf(model, 'l4').http).toBeUndefined();
    // 모르는 풀도 안 죽고 기본 계획을 낸다.
    expect(probePlanOf(model, 'nope').protocol).toBe('tcp_connect');
  });

  it('한 번에 찌르는 수에 상한이 있다', async () => {
    /**
     * 전에는 `Promise.all` 로 **전부 동시에** 찔렀다. 백엔드가 수백 개면 매 틱마다
     * 그만큼의 연결이 한꺼번에 나가고, 그건 헬스체크가 만드는 부하가 트래픽보다
     * 커지는 자리다.
     */
    let live = 0;
    let peak = 0;
    const out = await inBatches([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live -= 1;
      return n * 2;
    });
    expect(peak).toBeLessThanOrEqual(3);
    // 순서는 보존된다 — 각 결과가 자기 자리에 남아야 `seq` 짝이 안 어긋난다.
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
  });
});
