/**
 * Rendered 화면의 값 — 브라우저 없이 계약을 지킨다.
 */
import { describe, expect, it } from 'vitest';

import { pageOf } from '../../src/web/page.js';
import { viewOfRendered } from '../../src/web/rendered-view.js';

describe('산출물', () => {
  it('revision·digest·planes·conf 를 접는다 — 모델이 정본이다', () => {
    const view = viewOfRendered({
      revision: '3',
      digest: 'sha256:abc',
      planes: ['http', 'stream'],
      conf: 'events {}\n',
    });
    expect(view.revision).toBe('3');
    expect(view.digest).toBe('sha256:abc');
    expect(view.planes).toEqual(['http', 'stream']);
    expect(view.conf).toBe('events {}\n');
  });

  it('모르는 본문은 빈 conf 다 — 지어내지 않는다', () => {
    const view = viewOfRendered({ revision: 1, planes: 'http', conf: null });
    expect(view.revision).toBeUndefined();
    expect(view.planes).toEqual([]);
    expect(view.conf).toBe('');
  });
});

describe('화면 자리', () => {
  it('/rendered 가 산출물 화면이다 — Kit 이 아니다', () => {
    expect(pageOf('/rendered')).toBe('rendered');
    expect(pageOf('/status')).toBe('status');
    expect(pageOf('/')).toBe('impact');
  });
});
