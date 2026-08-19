/**
 * Routes 화면의 값 — 브라우저 없이 계약을 지킨다.
 */
import { describe, expect, it } from 'vitest';

import { pageOf } from '../../src/web/page.js';
import { viewOfRoutes } from '../../src/web/routes-view.js';

describe('컴파일된 순서', () => {
  it('매치 클래스가 priority 를 이긴다 — 순서가 그림자다', () => {
    const view = viewOfRoutes(
      [
        {
          key: 'wild', listener: 'front', hosts: ['*.example.com'],
          priority: 99, action: { kind: 'proxy' },
        },
        {
          key: 'exact', listener: 'front', hosts: ['api.example.com'],
          priority: 1, action: { kind: 'proxy' },
        },
      ],
      [],
    );
    expect(view.order.map((r) => r.key)).toEqual(['exact', 'wild']);
    expect(view.warnings.some((w) => w.kind === 'priority_inversion')).toBe(true);
    expect(view.errors).toEqual([]);
  });

  it('컴파일 오류면 순서를 비운다 — 반쯤 그린 순서는 거짓말이다', () => {
    const view = viewOfRoutes(
      [
        {
          key: 'first', listener: 'front', hosts: ['api.example.com'],
          priority: 10, pathPrefix: '/', action: { kind: 'proxy' },
        },
        {
          key: 'second', listener: 'front', hosts: ['api.example.com'],
          priority: 5, pathPrefix: '/', action: { kind: 'reject' },
        },
      ],
      [],
    );
    expect(view.order).toEqual([]);
    expect(view.errors.map((e) => e.kind)).toEqual(['duplicate_match']);
  });

  it('패스스루는 컴파일하지 않고 사실만 나열한다', () => {
    const view = viewOfRoutes([], [
      {
        key: 'tls-b', listener: 'edge', snis: ['b.example.com'],
        priority: 1, action: { kind: 'reject' },
      },
      {
        key: 'tls-a', listener: 'edge', snis: ['a.example.com'],
        priority: 10, action: { kind: 'proxy' },
      },
    ]);
    expect(view.order).toEqual([]);
    expect(view.passthrough.map((p) => p.key)).toEqual(['tls-a', 'tls-b']);
  });
});

describe('화면 자리', () => {
  it('/routes 가 라우트 화면이다 — Kit 이 아니다', () => {
    expect(pageOf('/routes')).toBe('routes');
    expect(pageOf('/pools')).toBe('pools');
    expect(pageOf('/')).toBe('impact');
  });
});
