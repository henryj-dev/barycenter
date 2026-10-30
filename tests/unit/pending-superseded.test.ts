/**
 * 적용 대기에서 이미 덮인 plan 을 뺀다 — 단위 쪽 고정 (실물 PG 검증은 `tests/store/pending-superseded.test.ts`).
 *
 * web-01 에서 ACME 가 r22 를 자동 적용한 뒤에도 r20 · r21 이 「적용 대기」 로 남아 「적용해요」 가
 * `PLAN_STALE` 로 거절됐다(2026-10-31). 상태와 지표가 같은 판단(`pendingApplies`)을 쓰는가를 잰다.
 */
import { describe, expect, it } from 'vitest';

import { pendingApplies } from '../../src/control/plane.js';
import type { Db } from '../../src/store/pg.js';

describe('적용 대기 판단', () => {
  it('활성화된 것보다 오래된 plan 을 빼는 쿼리로 묻는다', async () => {
    let sql = '';
    const db = { query: async (q: string) => { sql = q; return { rows: [{ id: 'p', target_revision: '23' }] }; } } as unknown as Db;
    expect(await pendingApplies(db)).toEqual([{ planId: 'p', revision: '23' }]);
    expect(sql).toMatch(/p\.target_revision > COALESCE\(\s*\(SELECT max\(o2\.revision\) FROM operations o2 WHERE o2\.phase = 'activated'\), 0\)/);
    expect(sql, '커밋됐지만 미적용인 것만').toMatch(/p\.state='committed'/);
  });
});
