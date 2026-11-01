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
/** 틀린 토큰 — 맞혀 보려는 요청이다. 자격을 아예 안 보낸 요청은 세지 않는다(아래). */
const WRONG = { authorization: 'Bearer wrong-token' };

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
    expect((await fetch(`${url}/api/v1/config/head`, { headers: WRONG })).status).toBe(401);
    expect(counterSnapshot().get('bary_auth_failures_total')).toBe(1);
  });
});

describe('인증 실패 제한', () => {
  it('정해진 횟수를 넘으면 429 다', async () => {
    const url = await listen();
    const statuses: number[] = [];
    let limited: Response | undefined;
    for (let i = 0; i < 5; i += 1) {
      const r = await fetch(`${url}/api/v1/config/head`, { headers: WRONG });
      statuses.push(r.status);
      limited = r;
    }
    expect(statuses).toEqual([401, 401, 401, 401, 429]);
    expect(limited?.headers.get('retry-after')).toBeTruthy();
  });

  it('성공한 인증은 같은 출처에서 막히지 않는다', async () => {
    const url = await listen();
    for (let i = 0; i < 5; i += 1) await fetch(`${url}/api/v1/config/head`, { headers: WRONG });
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

/**
 * 로그아웃 상태의 GUI 가 잠기던 문제 (2026-11-01, web-01). 로그인 화면은 `/api/v1/me` 를 부른다.
 * 자격을 안 보낸 요청까지 세면 새로고침 몇 번에 429 였다.
 */
describe('자격을 안 보낸 요청', () => {
  it('**세지 않는다** — 열 번 불러도 401 이고 잠기지 않는다', async () => {
    const url = await listen();
    const statuses: number[] = [];
    for (let i = 0; i < 10; i += 1) statuses.push((await fetch(`${url}/api/v1/me`)).status);
    expect(statuses).toEqual(Array(10).fill(401));
    expect(counterSnapshot().get('bary_auth_failures_total') ?? 0).toBe(0);
  });

  it('빈 Authorization 헤더 · 빈 쿠키도 자격이 아니다', async () => {
    const url = await listen();
    for (let i = 0; i < 6; i += 1) {
      expect((await fetch(`${url}/api/v1/me`, { headers: { authorization: '', cookie: 'bary_sid=; other=1' } })).status)
        .toBe(401);
    }
  });

  it('틀린 토큰으로 잠긴 출처는 자격 없는 요청에도 401 이다 — 잠금이 풀리지는 않는다', async () => {
    const url = await listen();
    for (let i = 0; i < 5; i += 1) await fetch(`${url}/api/v1/config/head`, { headers: WRONG });
    expect((await fetch(`${url}/api/v1/me`)).status).toBe(401);
    expect((await fetch(`${url}/api/v1/config/head`, { headers: WRONG })).status).toBe(429);
  });
});

describe('낡은 세션 쿠키', () => {
  it('**세고, 쿠키를 지운다** — 다음 새로고침은 자격 없는 요청이 된다', async () => {
    const url = await listen();
    const r = await fetch(`${url}/api/v1/me`, { headers: { cookie: 'bary_session=stale-id' } });
    expect(r.status).toBe(401);
    expect(counterSnapshot().get('bary_auth_failures_total')).toBe(1);
    expect(r.headers.getSetCookie().some((c) => c.startsWith('bary_session=;') && /Max-Age=0/i.test(c))).toBe(true);
  });

  it('틀린 토큰에는 쿠키를 건드리지 않는다', async () => {
    const url = await listen();
    const r = await fetch(`${url}/api/v1/me`, { headers: WRONG });
    expect(r.headers.getSetCookie()).toEqual([]);
  });
});
