/**
 * `/readyz` — 엔진 생사를 나타내는 창구 (검수 2026-08-24 D12)
 *
 * ── 왜 `/healthz` 를 안 바꿨나
 *
 * `/healthz` 는 `{ok:true}` 만 답한다. **순수 liveness** 이고, 오케스트레이터는 그걸
 * 보고 **프로세스를 죽인다.** 거기에 엔진 상태를 넣으면 의존성 장애가 곧 재시작이 되고,
 * 재시작해도 엔진은 그대로라 **재시작 루프**가 된다. 뜻이 다른 두 질문이라 창구도 둘이다.
 *
 * 대가로 「API 표면이 하나 는다」를 예상했는데, **안 늘었다** — 프로브는 스코프 표
 * 밖에 사는 것이 맞는 자리이고(`/healthz` 가 그렇다), B 동결 게이트는 `route()` 표를
 * 읽으므로 움직이지 않는다. 예상한 대가가 안 생긴 것이지 숨긴 것이 아니다.
 *
 * ── 이 창구가 주장하는 것
 *
 *   `dataplane`  드라이버가 답하는가
 *   `engine`     admin 소켓이 답하는가 — **엔진이 실제로 살아 있는가**
 *
 * ⚠️ **「못 물었다」와 「죽었다」를 가르는 것이 전부다.** 원격 드라이버 배포에는 이
 * 인스턴스 옆에 엔진이 없어서 admin 소켓에 못 붙는 것이 정상이고, 로컬 배포에서 못
 * 붙는 것은 엔진이 죽은 것이다. 둘을 접으면 창구가 아무 말도 안 한다.
 *
 * 여기서는 **엔드포인트의 계약**을 잰다 — 상태 코드와 본문. 실물 nginx 를 죽여서
 * 빨개지는지는 `tests/e2e/v02-capability.test.ts` 가 잰다.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { TokenAuth, hashToken } from '../../src/api/auth.js';
import { createApi } from '../../src/api/server.js';
import type { ControlPlane } from '../../src/control/plane.js';
import type { LeaderElection } from '../../src/control/leader.js';
import type { ConfigStore } from '../../src/store/config-store.js';
import type { Db } from '../../src/store/pg.js';

let server: Server | undefined;

afterEach(async () => {
  const s = server;
  server = undefined;
  if (s !== undefined) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

type Readiness = { ok: boolean; dataplane: boolean; engine?: boolean };

async function listen(readiness: Readiness): Promise<string> {
  const auth = new TokenAuth([{ name: 'r', hash: hashToken('t'), scopes: ['read'] }]);
  const election = { state: { isLeader: true, token: '1', holder: 't', since: '' } };
  const control = { readiness: async (): Promise<Readiness> => readiness };
  server = createApi({
    db: { query: async () => ({ rows: [] }) } as unknown as Db,
    store: {} as ConfigStore,
    control: control as unknown as ControlPlane,
    auth,
    election: election as unknown as LeaderElection,
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('`/readyz`', () => {
  it('엔진이 죽으면 503 이다 — 트래픽만 빠지고 프로세스는 안 죽는다', async () => {
    const url = await listen({ ok: false, dataplane: true, engine: false });
    const r = await fetch(`${url}/readyz`);
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ ok: false, engine: false });
  });

  it('다 멀쩡하면 200 이다', async () => {
    const url = await listen({ ok: true, dataplane: true, engine: true });
    const r = await fetch(`${url}/readyz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, dataplane: true, engine: true });
  });

  /**
   * **원격 배포에서는 `engine` 을 안 싣는다.** 옆에 엔진이 없는 것이 정상이라,
   * `false` 를 내면 우리가 모르는 것에 대한 주장이 된다.
   */
  it('원격이면 `engine` 을 안 말한다 — 모르는 것을 주장하지 않는다', async () => {
    const url = await listen({ ok: true, dataplane: true });
    const r = await fetch(`${url}/readyz`);
    expect(r.status).toBe(200);
    const body = await r.json() as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, dataplane: true });
    expect(Object.keys(body), '`engine` 이 실렸다').not.toContain('engine');
  });

  it('드라이버가 답을 안 하면 503 이다', async () => {
    const url = await listen({ ok: false, dataplane: false });
    expect((await fetch(`${url}/readyz`)).status).toBe(503);
  });

  /**
   * **인증이 없다.** 프로브는 대개 자격증명을 못 들고 다니고, 여기서 나가는 것은
   * 불리언 둘이라 배포 구조를 말하지 않는다 (`/metrics` 와 다르다).
   */
  it('토큰 없이 답한다 — 프로브는 자격증명을 못 들고 다닌다', async () => {
    const url = await listen({ ok: true, dataplane: true, engine: true });
    const r = await fetch(`${url}/readyz`, { headers: {} });
    expect(r.status).toBe(200);
  });

  /** **`/healthz` 는 안 바뀌었다.** 그것이 이 항목의 결정이다. */
  it('`/healthz` 는 엔진과 무관하게 200 이다 — 재시작 루프를 안 만든다', async () => {
    const url = await listen({ ok: false, dataplane: false, engine: false });
    const r = await fetch(`${url}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });
});
