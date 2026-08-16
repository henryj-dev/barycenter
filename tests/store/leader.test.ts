/**
 * 리더 선출 — PG advisory lock (DESIGN.md §3.5)
 *
 * v0.1 까지 `leader_token` 은 **환경변수**였다. DP Agent 가 50 회차 동안 그 토큰으로
 * 펜싱·승계·`superseded` 를 지었는데 **아무도 발급하지 않았다.** 여기서 재는 것은 그
 * 발급이 §3.5 의 계약을 지키는가다.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { LeaderElection, NotLeader } from '../../src/control/leader.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('leader');

let db: Db;
const open: LeaderElection[] = [];

const elect = (name: string): LeaderElection => {
  const e = new LeaderElection(PG.dsn, name);
  open.push(e);
  return e;
};

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 이 스위트는 실물 PG 를 쓴다');
  startPg(PG);
  db = new Db(PG.dsn);
  await db.migrate();
}, 180_000);

afterAll(async () => {
  await db?.close();
  stopPg(PG);
});

beforeEach(async () => {
  await reset(db);
});

afterEach(async () => {
  // 락을 쥔 세션이 남으면 다음 테스트가 리더가 못 된다.
  for (const e of open.splice(0)) await e.release();
});

describe('리더 선출', () => {
  it('첫 인스턴스가 리더가 되고 토큰을 받는다', async () => {
    const a = elect('a');
    expect(await a.tryAcquire()).toBe(true);
    expect(a.state.isLeader).toBe(true);
    expect(a.state.token).toBe('1');
    expect(a.state.reason).toBeUndefined();
  });

  it('**둘째는 리더가 못 된다** — 그리고 토큰도 안 태운다', async () => {
    const a = elect('a');
    const b = elect('b');
    expect(await a.tryAcquire()).toBe(true);
    expect(await b.tryAcquire()).toBe(false);
    expect(b.state.isLeader).toBe(false);
    expect(b.state.token).toBeUndefined();
    expect(b.state.reason).toMatch(/다른 인스턴스가 리더/);

    // **토큰은 "리더가 몇 번 바뀌었나" 를 뜻해야 한다.** 락을 못 잡은 인스턴스가
    // 시퀀스를 태우면 그 뜻이 깨진다 — 락을 잡은 뒤에 뽑는 이유다.
    const seq = (await db.query(`SELECT last_value::text AS v FROM leader_token_seq`)).rows[0];
    expect(seq?.['v']).toBe('1');
  });

  it('**토큰은 엄격 단조다** — 리더가 바뀔 때마다 커진다 (§3.5)', async () => {
    const a = elect('a');
    await a.tryAcquire();
    const first = a.state.token;
    await a.release();

    const b = elect('b');
    expect(await b.tryAcquire()).toBe(true);
    expect(BigInt(b.state.token ?? '0') > BigInt(first ?? '0')).toBe(true);
  });

  it('물러난 뒤에는 리더가 아니다 — 그리고 다음 인스턴스가 이어받는다', async () => {
    const a = elect('a');
    await a.tryAcquire();
    await a.release();
    expect(a.state.isLeader).toBe(false);
    expect(() => a.assertLeader()).toThrow(NotLeader);

    const b = elect('b');
    expect(await b.tryAcquire()).toBe(true);
  });

  it('**깨끗하게 물러난 것과 죽은 것을 구분한다**', async () => {
    const a = elect('a');
    await a.tryAcquire();
    await a.release();
    const rows = (await db.query(
      `SELECT token::text AS token, holder, released_at FROM leadership ORDER BY token`,
    )).rows;
    expect(rows).toHaveLength(1);
    // `released_at` 이 NULL 이면 "죽어서 락이 풀렸다" 는 뜻이다. 그 구분이 정보다.
    expect(rows[0]?.['released_at']).not.toBeNull();
    expect(rows[0]?.['holder']).toBe('a');
  });

  it('`assertLeader` 는 리더가 아니면 **503 으로 던진다**', () => {
    const a = elect('a');   // 아직 시도조차 안 했다
    try {
      a.assertLeader();
      expect.unreachable('던졌어야 한다');
    } catch (e) {
      expect(e).toBeInstanceOf(NotLeader);
      // 권한 없음(403)이 아니다 — *여기서는* 못 하는 것이고 다른 곳에서는 된다.
      expect((e as NotLeader).status).toBe(503);
      expect((e as NotLeader).code).toBe('not_leader');
    }
  });

  it('이미 리더면 다시 잡으려 해도 **토큰이 안 바뀐다**', async () => {
    const a = elect('a');
    await a.tryAcquire();
    const token = a.state.token;
    expect(await a.tryAcquire()).toBe(true);
    // 재시도마다 토큰이 뛰면 DP 의 `maxLeaderToken` 이 이유 없이 올라가고, 그러면
    // 진짜 리더 교체와 구분할 수 없다.
    expect(a.state.token).toBe(token);
  });
});
