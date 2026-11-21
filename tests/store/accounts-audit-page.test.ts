/**
 * 계정 감사 한 쪽 (관리 › 계정 감사, 2026-11-21) — 실물 PG.
 *
 * 재는 것: 최근 것부터 id 순서로 `limit` 개, `next` 로 다음 쪽을 이어 읽으면 겹치지도 빠지지도 않는다.
 * 대상 사람의 이름이 붙고, `detail` 은 객체로 온다.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ACCOUNT_MIGRATIONS } from '../../src/accounts/migrations.js';
import { Sealer } from '../../src/accounts/seal.js';
import { AccountService } from '../../src/accounts/service.js';
import { Db, dockerAvailable, freshSchema, pgFor, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('accounts-audit-page');
let db: Db;
const sealer = new Sealer(randomBytes(32).toString('base64'));
const svc = (): AccountService => new AccountService({ db, sealer, now: () => Date.now() });

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 이 스위트는 실물 PG 를 쓴다');
  startPg(PG);
  db = new Db(PG.dsn);
}, 180_000);

afterAll(async () => { await db?.close(); stopPg(PG); });

beforeEach(async () => {
  await freshSchema(db);
  await db.migrate(ACCOUNT_MIGRATIONS);
});

describe('계정 감사 한 쪽', () => {
  it('최근 것부터 · 쪽을 이어 읽으면 겹치지 않는다 · 대상 이름과 detail 이 붙는다', async () => {
    const s = svc();
    // id 를 직접 준다 — `RETURNING` 과 기본 uuid 는 방언마다 다르다(MySQL 에는 둘 다 없다).
    const uid = randomUUID();
    await db.query(`INSERT INTO users (id, username, role, created_by) VALUES ($1, 'alice', 'operator', 'test')`, [uid]);
    for (let i = 0; i < 5; i += 1) await s.recordGlobalView('user:admin', { region: `r${i}`, path: 'status' }, i === 4 ? uid : null, { ip: '10.0.0.9' });

    const p1 = await s.accountAudit(2);
    expect(p1.items.map((r) => (r.detail as { region: string }).region)).toEqual(['r4', 'r3']);
    expect(p1.items[0]).toMatchObject({ actor: 'user:admin', action: 'global.view', subjectUser: uid, subjectName: 'alice', ip: '10.0.0.9' });
    expect(p1.next).toBe(p1.items[1]!.id);

    const p2 = await s.accountAudit(2, p1.next);
    const p3 = await s.accountAudit(2, p2.next);
    expect([...p1.items, ...p2.items, ...p3.items].map((r) => (r.detail as { region: string }).region))
      .toEqual(['r4', 'r3', 'r2', 'r1', 'r0']);
    expect(p3.next).toBeUndefined();
    expect(p2.items[0]!.subjectName).toBeNull();
  });
});
