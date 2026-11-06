/**
 * 경로의 uuid 검사 — PG 의 `uuid_in` 이 받는 집합 그대로, 정규형으로 (src/api/server.ts `canonicalUuid`)
 *
 * 받는 집합을 좁히면 PG 에서 찾던 행을 400 으로 거절한다. 넓히면 PG 가 `22P02` 로 내던 400 을 놓친다.
 */
import { describe, expect, it } from 'vitest';

import { canonicalUuid } from '../../src/api/server.js';

const ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

describe('canonicalUuid', () => {
  it('PG 가 받는 표기를 정규형으로 돌려준다', () => {
    for (const s of [ID, ID.toUpperCase(), `{${ID}}`, ID.replace(/-/g, ''),
      'a0ee-bc99-9c0b-4ef8-bb6d-6bb9-bd38-0a11', '{a0eebc999c0b4ef8bb6d6bb9bd380a11}']) {
      expect(canonicalUuid(s), s).toBe(ID);
    }
  });

  it('PG 가 거절하는 것은 거절한다', () => {
    for (const s of ['', 'nope', 'does-not-exist', `${ID}0`, ID.slice(1), `{${ID}`, `${ID}}`, `(${ID})`,
      'a0eebc99-9c0b4ef8-bb6d-6bb9bd380a1-1', 'g0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', ` ${ID}`, `${ID}\n`, 'a0eebc99--9c0b-4ef8-bb6d-6bb9bd380a11']) {
      expect(canonicalUuid(s), JSON.stringify(s)).toBeUndefined();
    }
  });
});
