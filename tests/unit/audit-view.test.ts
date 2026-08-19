/**
 * Audit 화면의 값 — 브라우저 없이 계약을 지킨다.
 */
import { describe, expect, it } from 'vitest';

import { pageOf } from '../../src/web/page.js';
import { viewOfAudit } from '../../src/web/audit-view.js';

describe('기록', () => {
  it('id·at·principal·action·subject·revision 을 접는다 — 로그다', () => {
    const view = viewOfAudit([
      {
        id: '9',
        at: '2026-08-19T08:00:00.000Z',
        principal: 'op',
        action: 'changeset.commit',
        subject: 'cs-1',
        revision: '3',
      },
    ]);
    expect(view.rows).toEqual([{
      id: '9',
      at: '2026-08-19T08:00:00.000Z',
      principal: 'op',
      action: 'changeset.commit',
      subject: 'cs-1',
      revision: '3',
    }]);
  });

  it('모르는 본문은 빈 목록이다 — 지어내지 않는다', () => {
    const view = viewOfAudit({ id: 1, action: 'commit' });
    expect(view.rows).toEqual([]);
    expect(viewOfAudit([{ id: '', principal: 'op', action: 'x' }]).rows).toEqual([]);
    expect(viewOfAudit([{ id: '1', principal: 'op', action: 'x', revision: 3 }]).rows[0]?.revision)
      .toBeUndefined();
  });
});

describe('화면 자리', () => {
  it('/audit 가 기록 화면이다 — Kit 이 아니다', () => {
    expect(pageOf('/audit')).toBe('audit');
    expect(pageOf('/rendered')).toBe('rendered');
    expect(pageOf('/')).toBe('impact');
  });
});
