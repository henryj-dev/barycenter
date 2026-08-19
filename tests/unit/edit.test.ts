/**
 * GUI 편집 패치 — 브라우저 없이 계약을 지킨다.
 */
import { describe, expect, it } from 'vitest';

import { deletePatch } from '../../src/web/edit.js';

describe('설정에서 빼기', () => {
  it('백엔드를 빼는 패치는 delete 한 줄이다 — apply 가 아니다', () => {
    expect(deletePatch('backend', 'be-a')).toEqual([
      { op: 'delete', kind: 'backend', key: 'be-a' },
    ]);
  });

  it('빈 키는 패치를 만들지 않는다', () => {
    expect(() => deletePatch('backend', '')).toThrow(/키/);
  });
});
