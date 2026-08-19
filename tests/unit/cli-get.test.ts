/**
 * CLI get — 있는 GET 만. 모르는 이름은 호출하지 않는다.
 */
import { describe, expect, it } from 'vitest';

import type { Http, HttpResult } from '../../src/cli/flow.js';
import { getPath, getResource } from '../../src/cli/get.js';

const script = (replies: HttpResult[]): { http: Http; calls: [string, string][] } => {
  const calls: [string, string][] = [];
  let i = 0;
  const http: Http = async (method, path) => {
    calls.push([method, path]);
    const r = replies[i];
    i += 1;
    if (r === undefined) throw new Error(`예상 밖 호출 ${method} ${path}`);
    return r;
  };
  return { http, calls };
};

describe('getPath', () => {
  it('인증서·정책·SNI·헬스는 있는 GET 이다', () => {
    expect(getPath('certificates')).toBe('/api/v1/certificates');
    expect(getPath('tls-policies')).toBe('/api/v1/tls-policies');
    expect(getPath('sni-bindings')).toBe('/api/v1/sni-bindings');
    expect(getPath('health')).toBe('/api/v1/health/backends');
    expect(getPath('health/backends')).toBe('/api/v1/health/backends');
  });

  it('이미 열던 목록과 산출물도 같은 표다', () => {
    expect(getPath('listeners')).toBe('/api/v1/listeners');
    expect(getPath('pools')).toBe('/api/v1/pools');
    expect(getPath('backends')).toBe('/api/v1/backends');
    expect(getPath('routes')).toBe('/api/v1/routes');
    expect(getPath('model')).toBe('/api/v1/config/model');
    expect(getPath('rendered')).toBe('/api/v1/config/rendered');
  });

  it('한 풀의 백엔드와 한 백엔드의 헬스는 키를 싣는다', () => {
    expect(getPath('pools/app/backends')).toBe('/api/v1/pools/app/backends');
    expect(getPath('backends/a1/status')).toBe('/api/v1/backends/a1/status');
  });

  it('모르는 이름·빈 이름은 경로를 안 만든다', () => {
    expect(getPath('')).toBeUndefined();
    expect(getPath('orders')).toBeUndefined();
    expect(getPath('audit')).toBeUndefined();
    expect(getPath('pools//backends')).toBeUndefined();
    expect(getPath('backends//status')).toBeUndefined();
  });
});

describe('getResource', () => {
  it('헬스는 GET /health/backends 다. apply 를 안 한다', async () => {
    const { http, calls } = script([{ status: 200, body: [{ backendKey: 'a1', state: 'unknown' }] }]);
    expect(await getResource(http, 'health')).toEqual([{ backendKey: 'a1', state: 'unknown' }]);
    expect(calls).toEqual([['GET', '/api/v1/health/backends']]);
    expect(calls.some(([m, p]) => m === 'POST' && p === '/api/v1/apply')).toBe(false);
  });

  it('모르는 이름은 호출하지 않는다', async () => {
    const { http, calls } = script([]);
    await expect(getResource(http, 'orders')).rejects.toThrow(/없는 읽기/);
    expect(calls).toEqual([]);
  });
});
