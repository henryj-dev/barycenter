/** pickPending — 적용할 plan 고르기. */
import { describe, expect, it } from 'vitest';

import { pickPending } from '../../src/web/impact-view.js';

describe('pickPending — head 의 plan 만 (2026-11-01)', () => {
  const pending = [{ planId: 'a', revision: '5' }, { planId: 'b', revision: '7' }];
  it('head 를 주면 head 의 plan 만 고른다', () => {
    expect(pickPending(pending, '7')).toEqual({ planId: 'b', revision: '7' });
  });
  it('**가장 새 plan 이 head 보다 옛것이면 고르지 않는다** — 적용하면 언제나 PLAN_STALE 이다', () => {
    expect(pickPending(pending, '8')).toBeUndefined();
  });
  it('head 를 안 주면 전처럼 가장 새 것', () => {
    expect(pickPending(pending)).toEqual({ planId: 'b', revision: '7' });
  });
});
