/**
 * 멤버십 슬롯 — Lua 밸런서는 IP 만 받는다.
 */
import { describe, expect, it } from 'vitest';

import { encodeSlots, resolveSlots } from '../../src/control/membership.js';

describe('resolveSlots', () => {
  it('이미 IP 면 그대로다', async () => {
    const got = await resolveSlots({ p: ['10.2.0.1:11', '10.2.0.2:12'] });
    expect(got).toEqual({ p: ['10.2.0.1:11', '10.2.0.2:12'] });
  });

  it('localhost 를 루프백 IP 로 푼다', async () => {
    const got = await resolveSlots({ p: ['localhost:11'] });
    const peer = got['p']?.[0];
    expect(peer === '127.0.0.1:11' || peer === '[::1]:11').toBe(true);
  });

  it('encode 는 푼 값을 한 줄로 붙인다', async () => {
    const slots = await resolveSlots({ b: ['127.0.0.1:11'], a: ['10.0.0.1:80'] });
    expect(encodeSlots(slots)).toBe('a=10.0.0.1:80\nb=127.0.0.1:11');
  });
});
