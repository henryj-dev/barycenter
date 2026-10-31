/**
 * 발급 반영기가 인증서마다 가장 새 발급 주문 하나만 본다 — 단위 쪽 고정
 * (실물 PG 재현은 `tests/store/acme-publish.test.ts` 의 「발급됨 주문이 둘일 때」).
 *
 * web-01 에서 스테이징 · 운영 주문이 둘 다 「발급됨」 이라 15초마다 번갈아 게시 · 자동 적용했다(2026-10-31).
 * 고르기(DISTINCT ON … 연 시각 내림차순)를 비교(material_ref 와 다름)보다 **먼저** 하는가를 잰다.
 */
import { describe, expect, it } from 'vitest';

import { pendingPublications } from '../../src/control/acme-publish.js';
import type { Db } from '../../src/store/pg.js';

describe('발급 반영 후보', () => {
  it('인증서마다 가장 새로 연 발급 주문을 먼저 고르고, 그다음에 설정과 비교한다', async () => {
    let sql = '';
    const db = { query: async (q: string) => { sql = q; return { rows: [] }; } } as unknown as Db;
    await pendingPublications(db);
    const pick = sql.indexOf('DISTINCT ON (o.certificate_id)');
    const compare = sql.indexOf('latest.material_ref IS DISTINCT FROM latest.issued_ref');
    expect(pick, '인증서마다 하나만 고르지 않는다').toBeGreaterThan(-1);
    expect(sql).toMatch(/ORDER BY o\.certificate_id, o\.created_at DESC/);
    expect(compare, '고른 뒤에 비교하지 않는다 — 옛 주문이 뽑힌다').toBeGreaterThan(pick);
  });
});
