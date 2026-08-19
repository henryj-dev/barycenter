/**
 * GUI 편집 패치 — 브라우저 없이 계약을 지킨다.
 */
import { describe, expect, it } from 'vitest';

import { deletePatch, putBackendPatch, putHttpListenerPatch, putHttpRoutePatch, putPoolWithBackendPatch } from '../../src/web/edit.js';

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

  it('풀은 첫 백엔드와 같이 넣는다 — 빈 풀은 plan 이 막힌다', () => {
    expect(putPoolWithBackendPatch({
      pool: 'web', protocolClass: 'http', backend: 'a', host: '10.0.0.1', port: 80,
    })).toEqual([
      { op: 'put', kind: 'pool', key: 'web', body: { protocolClass: 'http', algorithm: 'round_robin' } },
      { op: 'put', kind: 'backend', key: 'a', body: { pool: 'web', host: '10.0.0.1', port: 80, weight: 1 } },
    ]);
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

  it('HTTP 라우트를 넣는 패치는 put 한 줄이다 — proxy 이고 websocket 은 끈다', () => {
    expect(putHttpRoutePatch({
      key: 'r-app', listener: 'front', hosts: ['app.example.com'], pool: 'app',
    })).toEqual([
      {
        op: 'put', kind: 'httpRoute', key: 'r-app',
        body: {
          listener: 'front', hosts: ['app.example.com'], priority: 0,
          action: { kind: 'proxy', pool: 'app', websocket: false },
        },
      },
    ]);
  });

  it('경로가 비면 pathPrefix 를 붙이지 않는다', () => {
    const patch = putHttpRoutePatch({
      key: 'r-app', listener: 'front', hosts: ['app.example.com'], pool: 'app',
      pathPrefix: '  ',
    });
    expect(patch[0]?.body).not.toHaveProperty('pathPrefix');
  });

  it('호스트가 없으면 패치를 만들지 않는다', () => {
    expect(() => putHttpRoutePatch({
      key: 'r-app', listener: 'front', hosts: ['  ', ''], pool: 'app',
    })).toThrow(/호스트/);
  });

  it('HTTP 라우트를 빼는 패치는 delete 한 줄이다', () => {
    expect(deletePatch('httpRoute', 'r-app')).toEqual([
      { op: 'delete', kind: 'httpRoute', key: 'r-app' },
    ]);
  });
});
