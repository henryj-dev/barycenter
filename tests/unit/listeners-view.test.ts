/**
 * Listeners 화면의 값 — 브라우저 없이 계약을 지킨다.
 */
import { describe, expect, it } from 'vitest';

import { pageOf, socketOf, viewOfListeners } from '../../src/web/listeners-view.js';

describe('리스너 목록', () => {
  it('커밋됐지만 아직 안 열린 소켓을 join 으로 표시한다', () => {
    const view = viewOfListeners(
      [{ key: 'front', protocol: 'http', bind: '0.0.0.0', port: 999 }],
      { added: ['tcp://0.0.0.0:999'], removed: [] },
    );
    expect(socketOf(view.rows[0]!)).toBe('tcp://0.0.0.0:999');
    expect(view.rows).toEqual([
      {
        key: 'front', protocol: 'http', bind: '0.0.0.0', port: 999,
        enabled: true, socket: 'tcp://0.0.0.0:999', mark: 'join',
      },
    ]);
  });

  it('head 에서 빠진 소켓은 아직 엔진에 있다고 leave 로 남긴다', () => {
    const view = viewOfListeners(
      [{ key: 'keep', protocol: 'http', bind: '127.0.0.1', port: 80 }],
      { added: [], removed: ['tcp://0.0.0.0:999'] },
    );
    expect(view.rows.map((r) => [r.socket, r.mark])).toEqual([
      ['tcp://127.0.0.1:80', 'stay'],
      ['tcp://0.0.0.0:999', 'leave'],
    ]);
  });

  it('대기 열이 없으면 목록은 지금 모델 그대로다', () => {
    const view = viewOfListeners([
      { key: 'b', protocol: 'udp', bind: '0.0.0.0', port: 53, enabled: false },
      { key: 'a', protocol: 'tcp', bind: '127.0.0.1', port: 22 },
    ]);
    expect(view.rows.map((r) => r.key)).toEqual(['a', 'b']);
    expect(view.rows.every((r) => r.mark === 'stay')).toBe(true);
    expect(view.rows[1]?.enabled).toBe(false);
  });
});

describe('화면 자리', () => {
  it('/listeners 가 리스너 화면이다 — Kit 이 아니다', () => {
    expect(pageOf('/listeners')).toBe('listeners');
    expect(pageOf('/listeners/front')).toBe('listeners');
    expect(pageOf('/')).toBe('impact');
    expect(pageOf('/plan')).toBe('impact');
  });
});
