/**
 * 주소 집합의 저작 표면 (#114) — GUI 와 CLI 가 같은 자리를 쓴다.
 */
import { describe, expect, it } from 'vitest';

import { parseSourceAllow, putAddressSetPatch } from '../../src/web/edit.js';
import { fetchCloudflareCidrs } from '../../src/cli/address-set.js';

describe('parseSourceAllow 가 @참조를 받는다', () => {
  it('대역과 섞어 쓴다', () => {
    expect(parseSourceAllow('@cloudflare\n203.0.113.7')).toEqual(['@cloudflare', '203.0.113.7']);
  });
  it('이상한 @ 는 거절한다', () => {
    expect(() => parseSourceAllow('@')).toThrow(/@주소집합/);
  });
});

describe('putAddressSetPatch', () => {
  it('붙여 넣은 목록을 끊고 중복을 접는다', () => {
    expect(putAddressSetPatch('cloudflare', { cidrs: '173.245.48.0/20\n173.245.48.0/20, 2400:cb00::/32', source: 'cloudflare' }))
      .toEqual([{ op: 'put', kind: 'addressSet', key: 'cloudflare', body: { cidrs: ['173.245.48.0/20', '2400:cb00::/32'], source: 'cloudflare' } }]);
  });
  it('비면 거절한다', () => {
    expect(() => putAddressSetPatch('x', { cidrs: ' ' })).toThrow(/비어/);
  });
  it('다른 집합을 참조하면 거절한다', () => {
    expect(() => putAddressSetPatch('x', { cidrs: '@cloudflare' })).toThrow(/참조하지 않는다/);
  });
});

describe('fetchCloudflareCidrs', () => {
  const ok = (body: string) => ({ ok: true, status: 200, text: async () => body });

  it('v4 와 v6 을 이어 붙인다', async () => {
    const got = await fetchCloudflareCidrs(async (u) => ok(u.includes('v4') ? '173.245.48.0/20\n103.21.244.0/22\n' : '2400:cb00::/32\n'));
    expect(got).toEqual(['173.245.48.0/20', '103.21.244.0/22', '2400:cb00::/32']);
  });

  it('**하나라도 실패하면 던진다** — 반쪽 목록으로 바꾸지 않는다', async () => {
    await expect(fetchCloudflareCidrs(async (u) => (u.includes('v6') ? { ok: false, status: 503, text: async () => '' } : ok('1.1.1.0/24'))))
      .rejects.toThrow(/503/);
  });

  it('빈 목록이면 던진다', async () => {
    await expect(fetchCloudflareCidrs(async () => ok('\n'))).rejects.toThrow(/비었다/);
  });
});
