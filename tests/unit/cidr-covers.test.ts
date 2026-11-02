/**
 * **대역이 대역을 덮는가** (2026-11-02) — 라우트 출발지 규칙의 「가려진 규칙」 판정이 쓴다.
 */
import { describe, expect, it } from 'vitest';

import { cidrCovers } from '../../src/validate/ip.js';

describe('cidrCovers', () => {
  it('넓은 대역이 좁은 대역 · 단일 주소를 덮는다 — 거꾸로는 아니다', () => {
    expect(cidrCovers('10.0.0.0/8', '10.1.0.0/16')).toBe(true);
    expect(cidrCovers('10.1.0.0/16', '10.0.0.0/8')).toBe(false);
    expect(cidrCovers('10.0.0.0/8', '10.0.0.5')).toBe(true);
    expect(cidrCovers('0.0.0.0/0', '1.2.3.4')).toBe(true);
    expect(cidrCovers('10.0.0.5', '10.0.0.5/32')).toBe(true);
  });

  it('IPv6 도 같다 — 임베디드 IPv4 표기도 읽는다', () => {
    expect(cidrCovers('2001:db8::/32', '2001:db8:1::/48')).toBe(true);
    expect(cidrCovers('2001:db8::/32', '2001:db9::/48')).toBe(false);
    expect(cidrCovers('::ffff:0:0/96', '::ffff:1.2.3.4')).toBe(true);
  });

  it('계열이 다르면 덮지 않는다 · 호스트 비트는 망 주소로 읽는다 · CIDR 이 아니면 거짓', () => {
    expect(cidrCovers('10.0.0.0/8', '2001:db8::1')).toBe(false);
    expect(cidrCovers('10.0.0.1/8', '10.9.9.9')).toBe(true);
    expect(cidrCovers('@office', '10.0.0.1')).toBe(false);
  });
});
