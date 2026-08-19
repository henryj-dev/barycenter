/**
 * Status 화면의 값 — 브라우저 없이 계약을 지킨다.
 */
import { describe, expect, it } from 'vitest';

import { pageOf } from '../../src/web/page.js';
import { viewOfStatus } from '../../src/web/status-view.js';

describe('4-way', () => {
  it('스탠바이는 리더가 아니라고 말한다 — 503 의 이유다', () => {
    const view = viewOfStatus({
      head: '4',
      leader: { isLeader: false, holder: 'other:8088', reason: '락을 못 쥐었다' },
      engine: { probed: false, reason: '바이너리가 없다' },
      driver: { loaded: false },
      published: { kind: 'none' },
      pendingApply: [],
    });
    expect(view.leader.isLeader).toBe(false);
    expect(view.leader.reason).toBe('락을 못 쥐었다');
    expect(view.engine.probed).toBe(false);
    expect(view.published.kind).toBe('none');
    expect(view.unfinished).toBe(false);
  });

  it('커밋됐지만 미적용은 숨기지 않는다', () => {
    const view = viewOfStatus({
      head: '8',
      leader: { isLeader: true, holder: 'me', token: '3' },
      engine: { probed: true, flavor: 'openresty', version: '1.21' },
      driver: { loaded: true, name: 'reference' },
      published: { kind: 'owned', record: { generation: 'r7-e2' } },
      unfinished: { generation: 'r8-e3' },
      pendingApply: [{ planId: 'p1', revision: '8' }],
    });
    expect(view.head).toBe('8');
    expect(view.published.generation).toBe('r7-e2');
    expect(view.unfinished).toBe(true);
    expect(view.pending).toEqual([{ planId: 'p1', revision: '8' }]);
    expect(view.engine.label).toContain('openresty');
    expect(view.driver.name).toBe('reference');
  });
});

describe('화면 자리', () => {
  it('/status 가 상태 화면이다 — Kit 이 아니다', () => {
    expect(pageOf('/status')).toBe('status');
    expect(pageOf('/certificates')).toBe('certificates');
    expect(pageOf('/')).toBe('impact');
  });
});
