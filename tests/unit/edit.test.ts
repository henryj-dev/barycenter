/**
 * GUI 편집 패치 — 브라우저 없이 계약을 지킨다.
 */
import { describe, expect, it } from 'vitest';

import { deletePatch, putBackendPatch, putHttpListenerPatch } from '../../src/web/edit.js';

describe('설정에서 빼기', () => {
  it('백엔드를 빼는 패치는 delete 한 줄이다 — apply 가 아니다', () => {
    expect(deletePatch('backend', 'be-a')).toEqual([
      { op: 'delete', kind: 'backend', key: 'be-a' },
    ]);
  });

  it('빈 키는 패치를 만들지 않는다', () => {
    expect(() => deletePatch('backend', '')).toThrow(/키/);
  });

  it('백엔드를 넣는 패치는 put 한 줄이다 — apply 가 아니다', () => {
    expect(putBackendPatch('be-b', { pool: 'web', host: '10.0.0.3', port: 8080 })).toEqual([
      {
        op: 'put', kind: 'backend', key: 'be-b',
        body: { pool: 'web', host: '10.0.0.3', port: 8080, weight: 1 },
      },
    ]);
  });

  it('포트가 정수가 아니면 패치를 만들지 않는다', () => {
    expect(() => putBackendPatch('be-b', { pool: 'web', host: '10.0.0.3', port: 0 })).toThrow(/포트/);
  });

  it('HTTP 리스너를 넣는 패치는 put 한 줄이다 — tls 는 안 붙인다', () => {
    expect(putHttpListenerPatch('front', { bind: '0.0.0.0', port: 999, pool: 'app' })).toEqual([
      {
        op: 'put', kind: 'listener', key: 'front',
        body: {
          protocol: 'http', bind: '0.0.0.0', port: 999, enabled: true,
          http: { defaultAction: { pool: 'app' } },
        },
      },
    ]);
  });
});
