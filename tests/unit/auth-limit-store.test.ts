/**
 * 인증 실패 제한 저장소 — 등록부 · 메모리(지금 그대로) · 저장소 장애 때의 서버 정책.
 *
 * 두 인스턴스가 같은 PG 로 함께 세는 것은 `tests/store/auth-limit-pg.test.ts` 가 실물 PG 로 잰다.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TokenAuth, hashToken } from '../../src/api/auth.js';
import { memoryRateLimit } from '../../src/api/auth-limit/memory.js';
import { pgRateLimit } from '../../src/api/auth-limit/pg.js';
import { rateLimitKinds, rateLimitStore } from '../../src/api/auth-limit/registry.js';
import type { RateLimitStore } from '../../src/api/auth-limit/store.js';
import { createApi } from '../../src/api/server.js';
import { counterSnapshot, resetCounters } from '../../src/obs/metrics.js';
import type { ConfigStore } from '../../src/store/config-store.js';
import type { ControlPlane } from '../../src/control/plane.js';
import type { Db, Queryable } from '../../src/store/pg.js';
import type { LeaderElection } from '../../src/control/leader.js';

let server: Server | undefined;
const TOKEN = ['known', 'token'].join('-');
const WRONG = { authorization: `Bearer ${['wrong', 'token'].join('-')}` };

beforeEach(() => resetCounters());
afterEach(async () => {
  server?.closeAllConnections?.();
  if (server !== undefined) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

async function listen(authLimit?: RateLimitStore): Promise<string> {
  server = createApi({
    db: {} as Db,
    store: { head: async () => ({ revision: '1', etag: 'e1' }) } as unknown as ConfigStore,
    control: {} as ControlPlane,
    auth: new TokenAuth([{ name: 'reader', hash: hashToken(TOKEN), scopes: ['read'] }]),
    election: { state: { isLeader: true, token: '1', holder: 'test', since: '' } } as LeaderElection,
    ...(authLimit === undefined ? {} : { authLimit }),
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const down: Queryable = { query: async () => { throw new Error('connect ECONNREFUSED 10.0.0.9:5432'); } };

describe('등록부', () => {
  it('memory 가 기본 이름이고, 모르는 이름은 던진다', () => {
    expect(rateLimitKinds()).toEqual(['memory', 'pg']);
    expect(rateLimitStore('memory').kind).toBe('memory');
    expect(() => rateLimitStore('redis')).toThrow(/모른다/);
  });

  it('**pg 는 계정 PG 없이 만들지 않는다** — 조용히 메모리로 떨어지지 않는다', () => {
    expect(() => rateLimitStore('pg')).toThrow(/BARY_ACCOUNTS_DSN/);
    expect(rateLimitStore('pg', { accountsDb: down }).kind).toBe('pg');
  });
});

describe('memory — 지금 그대로', () => {
  it('다섯 번째 실패부터 막고, 성공이 지운다', async () => {
    const m = memoryRateLimit();
    const got: (number | undefined)[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await m.record('ip');
      got.push(r.ok ? r.retryAfterS : -1);
    }
    expect(got).toEqual([undefined, undefined, undefined, undefined, 1, 2]);
    await m.clear('ip');
    expect(await m.record('ip')).toEqual({ ok: true });
  });

  it('서버 기본값(authLimit 없음)은 지금과 같다 — 401 넷 뒤 429', async () => {
    const url = await listen();
    const s: number[] = [];
    for (let i = 0; i < 5; i++) s.push((await fetch(`${url}/api/v1/config/head`, { headers: WRONG })).status);
    expect(s).toEqual([401, 401, 401, 401, 429]);
  });
});

describe('pg 저장소에 닿지 못할 때', () => {
  it('record · clear 는 던지지 않고 결과로 실패한다 — 원인을 말한다', async () => {
    const p = pgRateLimit({ db: down });
    expect(await p.record('ip')).toMatchObject({ ok: false, reason: 'unavailable', detail: expect.stringContaining('ECONNREFUSED') });
    expect(await p.clear('ip')).toMatchObject({ ok: false });
  });

  it('**실패한 인증은 503 이다** (세지 못했다를 드러낸다 — 401 로 열지 않는다)', async () => {
    const url = await listen(pgRateLimit({ db: down }));
    const r = await fetch(`${url}/api/v1/config/head`, { headers: WRONG });
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ code: 'auth_limit_unavailable' });
    expect(r.headers.get('retry-after')).toBe('5');
    expect(counterSnapshot().get('bary_auth_limit_store_errors_total')).toBe(1);
  });

  it('**맞는 토큰은 그대로 들어간다** — 계정 PG 장애가 API 토큰까지 막지 않는다', async () => {
    const url = await listen(pgRateLimit({ db: down }));
    const r = await fetch(`${url}/api/v1/config/head`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(r.status).toBe(200);
  });

  it('성공의 clear 는 기다리지 않는다 — 느린 저장소가 맞는 요청을 붙잡지 않는다', async () => {
    let release!: () => void;
    const hang: Queryable = { query: () => new Promise((_, rej) => { release = () => rej(new Error('late')); }) };
    const url = await listen(pgRateLimit({ db: hang }));
    const r = await fetch(`${url}/api/v1/config/head`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(r.status).toBe(200);
    release();
  });
});
