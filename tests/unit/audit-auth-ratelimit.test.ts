import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TokenAuth, hashToken } from '../../src/api/auth.js';
import { createApi } from '../../src/api/server.js';
import { AuthFailureLimiter } from '../../src/api/auth-rate-limit.js';
import { counterSnapshot, resetCounters } from '../../src/obs/metrics.js';
import type { ConfigStore } from '../../src/store/config-store.js';
import type { ControlPlane } from '../../src/control/plane.js';
import type { Db } from '../../src/store/pg.js';
import type { LeaderElection } from '../../src/control/leader.js';

let server: Server | undefined;
const TOKEN = 'known-token';

beforeEach(() => resetCounters());
afterEach(async () => {
  server?.closeAllConnections?.();
  if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

async function listen(): Promise<string> {
  server = createApi({
    db: {} as Db,
    store: { head: async () => ({ revision: '1', etag: 'e1' }) } as unknown as ConfigStore,
    control: {} as ControlPlane,
    auth: new TokenAuth([{ name: 'reader', hash: hashToken(TOKEN), scopes: ['read'] }]),
    election: { state: { isLeader: true, token: '1', holder: 'test', since: '' } } as LeaderElection,
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('인증 실패 관측', () => {
  it('인증 실패가 세어진다', async () => {
    const url = await listen();
    expect((await fetch(`${url}/api/v1/config/head`)).status).toBe(401);
    expect(counterSnapshot().get('bary_auth_failures_total')).toBe(1);
  });
});

describe('인증 실패 제한', () => {
  it('정해진 횟수를 넘으면 429 다', async () => {
    const url = await listen();
    const statuses: number[] = [];
    let limited: Response | undefined;
    for (let i = 0; i < 5; i += 1) {
      const r = await fetch(`${url}/api/v1/config/head`);
      statuses.push(r.status);
      limited = r;
    }
    expect(statuses).toEqual([401, 401, 401, 401, 429]);
    expect(limited?.headers.get('retry-after')).toBeTruthy();
  });

  it('성공한 인증은 같은 출처에서 막히지 않는다', async () => {
    const url = await listen();
    for (let i = 0; i < 5; i += 1) await fetch(`${url}/api/v1/config/head`);
    const r = await fetch(`${url}/api/v1/config/head`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(200);
  });

  it('시간이 지나면 실패 상태가 풀린다', () => {
    const limiter = new AuthFailureLimiter({ maxFailures: 2, baseDelayMs: 1000, ttlMs: 100 });
    expect(limiter.record('ip', 0)).toBeUndefined();
    expect(limiter.record('ip', 1)).toBe(1);
    expect(limiter.record('ip', 200)).toBeUndefined();
  });
});
