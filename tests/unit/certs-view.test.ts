/**
 * Certificates 화면의 값 — 브라우저 없이 계약을 지킨다.
 */
import { describe, expect, it } from 'vitest';

import { pageOf } from '../../src/web/page.js';
import { viewOfCertificates } from '../../src/web/certs-view.js';

describe('인증서 목록', () => {
  it('자료 없는 인증서를 빼지 않는다 — 발급 전이 안 보이면 안 된다', () => {
    const view = viewOfCertificates([
      { key: 'live', expiresInDays: 80, notAfter: '2026-11-01', domains: ['a.test'] },
      { key: 'pending', facts: null, acme: { account: 'lets', domains: ['b.test'] } },
    ]);
    expect(view.rows.map((r) => [r.key, r.mark, r.acme])).toEqual([
      ['pending', 'missing', true],
      ['live', 'ok', false],
    ]);
    expect(view.rows[0]?.domains).toEqual(['b.test']);
  });

  it('주문 상태는 GET /acme/orders 에서 오고 인증서 목록에 섞이지 않는다', () => {
    const view = viewOfCertificates(
      [{ key: 'pending', facts: null, acme: { account: 'lets', domains: ['b.test'] } }],
      [{ id: 'o1', certificate: 'pending', state: 'validating' }],
    );
    expect(view.rows[0]?.orderState).toBe('validating');
  });

  it('만료가 먼저다 — 남은 일수가 음수면 이미 죽었다', () => {
    const view = viewOfCertificates([
      { key: 'later', expiresInDays: 40, domains: ['c.test'] },
      { key: 'dead', expiresInDays: -3, domains: ['a.test'] },
      { key: 'soon', expiresInDays: 7, domains: ['b.test'] },
    ]);
    expect(view.rows.map((r) => r.key)).toEqual(['dead', 'soon', 'later']);
    expect(view.rows[0]?.mark).toBe('expired');
  });
});

describe('화면 자리', () => {
  it('/certificates 가 인증서 화면이다 — Kit 이 아니다', () => {
    expect(pageOf('/certificates')).toBe('certificates');
    expect(pageOf('/routes')).toBe('routes');
    expect(pageOf('/')).toBe('impact');
  });
});
