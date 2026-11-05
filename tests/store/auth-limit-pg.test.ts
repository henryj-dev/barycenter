/**
 * 공유 인증 실패 제한 (`BARY_AUTH_LIMIT_STORE=pg`) — 실물 계정 PG 의 `auth_throttle`.
 *
 * 메모리 구현은 인스턴스마다 따로 센다. 같은 PG 를 보는 두 인스턴스가 **실패를 합쳐 세는지**, 수치(5번째부터,
 * 1초에서 두 배씩, 60초 상한, 10분 뒤 처음부터)가 메모리와 같은지, 사람 로그인의 계수(`login:`)와 섞이지 않는지 잰다.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hashToken, TokenAuth } from '../../src/api/auth.js';
import { pgRateLimit } from '../../src/api/auth-limit/pg.js';
import { createApi } from '../../src/api/server.js';
import { ACCOUNT_MIGRATIONS } from '../../src/accounts/migrations.js';
import { AuthFailureLimiter } from '../../src/api/auth-rate-limit.js';
import type { ConfigStore } from '../../src/store/config-store.js';
import type { ControlPlane } from '../../src/control/plane.js';
import type { LeaderElection } from '../../src/control/leader.js';
import { Db, dockerAvailable, pgFor, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('auth-limit-pg');
let db: Db;
const servers: Server[] = [];
const TOKEN = ['machine', 'token', 'plain'].join('-');
const WRONG = { authorization: `Bearer ${['wrong', 'token'].join('-')}` };

async function serve(): Promise<string> {
  const s = createApi({
    db: {} as Db,
    store: { head: async () => ({ revision: '1', etag: 'e1' }) } as unknown as ConfigStore,
    control: {} as ControlPlane,
    auth: new TokenAuth([{ name: 'ci', role: 'admin', hash: hashToken(TOKEN) }]),
    election: { state: { isLeader: true, reason: '' } } as unknown as LeaderElection,
    authLimit: pgRateLimit({ db }),
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 이 스위트는 실물 PG 를 쓴다');
  startPg(PG);
  db = new Db(PG.dsn);
}, 180_000);

afterAll(async () => { await db?.close(); stopPg(PG); });

beforeEach(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await db.migrate(ACCOUNT_MIGRATIONS);
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

describe('공유 인증 실패 제한 — 두 인스턴스, 같은 PG', () => {
  it('**두 인스턴스가 실패를 합쳐 센다** — A 에서 셋, B 에서 둘이면 B 의 다섯 번째가 429', async () => {
    const A = await serve();
    const B = await serve();
    const s: number[] = [];
    for (let i = 0; i < 3; i++) s.push((await fetch(`${A}/api/v1/config/head`, { headers: WRONG })).status);
    for (let i = 0; i < 2; i++) s.push((await fetch(`${B}/api/v1/config/head`, { headers: WRONG })).status);
    expect(s).toEqual([401, 401, 401, 401, 429]);
    const row = (await db.query(`SELECT key, failures, blocked_until IS NOT NULL AS blocked FROM auth_throttle`)).rows;
    expect(row).toEqual([{ key: 'api:127.0.0.1', failures: 5, blocked: true }]);
  });

  it('한 인스턴스에서의 성공이 공유 계수를 지운다(메모리와 같은 뜻)', async () => {
    const A = await serve();
    const B = await serve();
    for (let i = 0; i < 4; i++) await fetch(`${A}/api/v1/config/head`, { headers: WRONG });
    expect((await fetch(`${B}/api/v1/config/head`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
    // 지우기는 기다리지 않는다 — 행이 사라질 때까지 잠깐 본다
    for (let i = 0; i < 50 && (await db.query(`SELECT 1 FROM auth_throttle`)).rows.length > 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect((await fetch(`${A}/api/v1/config/head`, { headers: WRONG })).status).toBe(401);
  });

  it('**동시에 와도 하나도 잃지 않는다** — 열 개를 한꺼번에 보내면 계수가 10', async () => {
    const p = pgRateLimit({ db });
    await Promise.all(Array.from({ length: 10 }, () => p.record('10.0.0.1')));
    expect((await db.query(`SELECT failures FROM auth_throttle WHERE key='api:10.0.0.1'`)).rows[0]).toEqual({ failures: 10 });
  });
});

describe('수치는 메모리 구현과 같다', () => {
  it('같은 시각열에 같은 대기(초)를 낸다 — 상한 60초 · 10분 뒤 처음부터', async () => {
    let t = Date.parse('2026-11-05T00:00:00Z');
    const p = pgRateLimit({ db, now: () => t });
    const m = new AuthFailureLimiter();
    const steps = [0, 1_000, 1_000, 1_000, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 1_000, 10 * 60_000, 1_000];
    const fromPg: (number | undefined)[] = [];
    const fromMem: (number | undefined)[] = [];
    for (const d of steps) {
      t += d;
      const r = await p.record('k');
      fromPg.push(r.ok ? r.retryAfterS : -1);
      fromMem.push(m.record('k', t));
    }
    expect(fromPg).toEqual(fromMem);
    expect(fromPg.slice(4, 12)).toEqual([1, 2, 4, 8, 16, 32, 60, 60]);
  });

  it('사람 로그인의 계수(login:)와 섞이지 않는다', async () => {
    await db.query(`INSERT INTO auth_throttle (key, failures, last_failure_at) VALUES ('login:10.0.0.1', 9, now())`);
    const p = pgRateLimit({ db });
    expect(await p.record('10.0.0.1')).toEqual({ ok: true });
    await p.clear('10.0.0.1');
    expect((await db.query(`SELECT failures FROM auth_throttle WHERE key='login:10.0.0.1'`)).rows[0]).toEqual({ failures: 9 });
  });
});
