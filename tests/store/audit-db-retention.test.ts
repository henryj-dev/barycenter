/**
 * 검수 2026-08-22 · B-08 / 제안#10 — **자라기만 하는 두 테이블**
 *
 * `health_events` 와 `audit` 은 삽입만 있고 지우는 코드가 없었다. 세대는 이미 상한이
 * 있고(`dp/retention.ts`) 시크릿도 뒤늦게 얻었는데(`dp/secret-gc.ts`) DB 는 없었다.
 *
 * 두 테이블은 **같은 정책을 쓰면 안 된다.**
 *
 *   · `health_events` — 프로덕션에서 **아무도 안 읽는다.** replay 는 `projectHealth()`
 *     로 대체됐고, 006 의 머리말이 말하는 *"이벤트 로그가 단일 정본이다"* 는 지금
 *     사실이 아니다. 읽는 곳이 없으니 기본 상한을 걸어도 잃는 것이 없다.
 *   · `audit` — `GET /api/v1/audit` 가 읽는 **진짜 감사 추적**이다. 여기에 기본값으로
 *     칼을 대면 업그레이드가 조용히 남의 보존 요건을 위반한다. 껐다가, 정하면 켠다.
 *
 * 비대칭이 요점이다. "둘 다 30 일" 이 더 단순해 보이지만 그건 단순한 것이 아니라
 * **두 테이블이 서로 다른 것이라는 사실을 안 본 것**이다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { sweepDatabase } from '../../src/store/db-retention.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('dbretention');
let db: Db;

const HAVE_DOCKER = dockerAvailable();
const maybe = HAVE_DOCKER ? describe : describe.skip;

/** `at` 을 직접 박는다 — 나이를 기다릴 수는 없다. */
async function insertEvent(seq: number, ageDays: number): Promise<void> {
  await db.query(
    `INSERT INTO health_events (seq, backend_key, state, at)
     VALUES ($1, 'b', 'healthy', now() - ($2 || ' days')::interval)`,
    [String(seq), String(ageDays)],
  );
}

async function insertAudit(ageDays: number): Promise<void> {
  await db.query(
    `INSERT INTO audit (principal, action, subject, at)
     VALUES ('t', 'changeset.create', 's', now() - ($1 || ' days')::interval)`,
    [String(ageDays)],
  );
}

const countOf = async (table: string): Promise<number> => Number(
  (await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.['n'] ?? 0,
);

maybe('DB 보존 (검수 B-08 · 제안#10)', () => {
  beforeAll(async () => {
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

  it('오래된 헬스 이벤트는 기본값으로 잘린다', async () => {
    await insertEvent(1, 90);
    await insertEvent(2, 40);
    await insertEvent(3, 1);

    const out = await sweepDatabase({ db });

    expect(out.healthEvents).toBe(2);
    const left = (await db.query('SELECT seq::text AS s FROM health_events ORDER BY seq')).rows;
    expect(left.map((r) => r['s'])).toEqual(['3']);
  });

  it('감사 추적은 정하기 전에는 안 지운다', async () => {
    // 여기가 이 테스트의 핵심이다. 기본값으로 지우면 업그레이드가 곧 데이터 소실이다.
    await insertAudit(4000);
    const out = await sweepDatabase({ db });
    expect(out.audit).toBe(0);
    expect(await countOf('audit')).toBe(1);
  });

  it('감사 추적은 정하면 잘린다', async () => {
    await insertAudit(400);
    await insertAudit(10);
    const out = await sweepDatabase({ db, auditDays: 365 });
    expect(out.audit).toBe(1);
    expect(await countOf('audit')).toBe(1);
  });

  it('헬스 이벤트를 지워도 커서는 뒤로 안 간다', async () => {
    /**
     * §6.6 의 반례가 여기서도 산다. 커서를 "남은 최대 seq + 1" 로 다시 맞추고 싶은
     * 유혹이 있는데, 그러면 **번호가 재사용된다** — 잘린 구간과 겹치는 seq 가 다시
     * 발급되고, 그 시점에 `health_events` 의 PRIMARY KEY 가 터진다. 커서는 단조다.
     */
    await insertEvent(1, 90);
    await insertEvent(2, 90);
    await db.query('UPDATE health_cursor SET next_seq = 3');

    await sweepDatabase({ db });

    const after = (await db.query('SELECT next_seq::text AS n FROM health_cursor')).rows[0];
    expect(after?.['n']).toBe('3');
  });

  it('한 번에 다 지우지 않는다 — 상한이 있다', async () => {
    /**
     * 처음 켜는 배포에서는 이 테이블이 수백만 행일 수 있다. 한 트랜잭션으로 밀면 그
     * 시간 동안 `emit()` 이 잡는 `health_cursor FOR UPDATE` 뒤로 프로버가 줄을 선다 —
     * §6.7 의 판정 동결과 같은 증상이다. 잘라서 지운다.
     */
    for (let i = 1; i <= 10; i += 1) await insertEvent(i, 90);

    const out = await sweepDatabase({ db, maxPerSweep: 4 });

    expect(out.healthEvents).toBe(4);
    expect(await countOf('health_events')).toBe(6);
  });

  it('안 지울 것이 없으면 조용하다', async () => {
    await insertEvent(1, 1);
    const out = await sweepDatabase({ db });
    expect(out).toEqual({ healthEvents: 0, audit: 0 });
  });

  it('나이는 사용자 문자열이 아니다 — 정수만 지난다', async () => {
    // 간격을 문자열로 받으면 그것이 곧 SQL 로 가는 자유 문자열이 된다 (검수 S-11 부류).
    await expect(sweepDatabase({ db, auditDays: 0 })).rejects.toThrow(/보존 일수/);
    await expect(sweepDatabase({ db, auditDays: 1.5 })).rejects.toThrow(/보존 일수/);
    await expect(sweepDatabase({ db, healthEventDays: -1 })).rejects.toThrow(/보존 일수/);
  });
});
