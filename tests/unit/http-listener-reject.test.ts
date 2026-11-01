/**
 * HTTP · HTTPS 리스너를 「거절」 기본 동작으로 만든다 (2026-11-01, 도그푸딩에서 잡았다).
 *
 * 설정 탭에는 「거절」 이 있었는데 만들기 폼과 패치 함수는 풀을 꼭 요구했다.
 * ACME 용 :80 리스너처럼 풀 없이 끊기만 하는 리스너를 GUI 로 만들 수 없었다.
 */
import { describe, expect, it } from 'vitest';

import { decodeModel } from '../../src/model/decode.js';
import { validateModel } from '../../src/validate/model.js';
import { putHttpListenerPatch, putHttpsListenerPatch } from '../../src/web/edit.js';

describe('풀을 안 주면 기본 동작이 거절이다', () => {
  it('**HTTP** — defaultAction 이 reject 다', () => {
    const [op] = putHttpListenerPatch('acme-public', { bind: '64.176.226.52', port: 80 });
    expect(op!.body.http.defaultAction).toBe('reject');
  });

  it('**HTTPS** — defaultAction 이 reject 다', () => {
    const [op] = putHttpsListenerPatch('edge', { bind: '0.0.0.0', port: 443, policy: 'modern', certificate: 'c' });
    expect(op!.body.http.defaultAction).toBe('reject');
  });

  it('풀을 주면 전처럼 그 풀이다', () => {
    const [op] = putHttpListenerPatch('front', { bind: '0.0.0.0', port: 80, pool: 'app' });
    expect(op!.body.http.defaultAction).toEqual({ pool: 'app' });
  });

  it('빈 풀 이름은 거절로 바꾸지 않고 막는다 — 실수다', () => {
    expect(() => putHttpListenerPatch('front', { bind: '0.0.0.0', port: 80, pool: '' })).toThrow(/풀이 비어/);
    expect(() => putHttpsListenerPatch('edge', { bind: '0.0.0.0', port: 443, pool: '', policy: 'p', certificate: 'c' }))
      .toThrow(/풀이 비어/);
  });

  it('거절 리스너 patch 가 해독기와 검증기를 지난다 — 라우트도 풀도 없다', () => {
    const [op] = putHttpListenerPatch('acme-public', { bind: '64.176.226.52', port: 80 });
    const decoded = decodeModel({
      listeners: [{ key: op!.key, ...op!.body }],
      httpRoutes: [], passthroughRoutes: [], pools: [], backends: [],
      certificates: [], tlsPolicies: [], sniBindings: [],
    });
    expect(decoded.ok, JSON.stringify(decoded)).toBe(true);
    if (decoded.ok) expect(validateModel(decoded.model)).toEqual([]);
  });
});
