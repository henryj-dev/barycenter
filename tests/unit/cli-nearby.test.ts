/**
 * API 는 있는데 클라이언트가 안 열던 자리 — recover · get · 풀 삭제. apply 가 아니다.
 */
import { describe, expect, it } from 'vitest';

import { recover, type Http, type HttpResult } from '../../src/cli/flow.js';
import { getPath, getResource } from '../../src/cli/get.js';
import { poolDelete, poolDeletePatch } from '../../src/cli/pool.js';

const script = (replies: HttpResult[]): { http: Http; calls: [string, string, unknown?][] } => {
  const calls: [string, string, unknown?][] = [];
  let i = 0;
  const http: Http = async (method, path, body) => {
    calls.push(body === undefined ? [method, path] : [method, path, body]);
    const r = replies[i];
    i += 1;
    if (r === undefined) throw new Error(`예상 밖 호출 ${method} ${path}`);
    return r;
  };
  return { http, calls };
};

const commitReplies = (): HttpResult[] => [
  { status: 200, body: { revision: '3' } },
  { status: 201, body: { id: 'cs-1' } },
  { status: 200, body: {} },
  { status: 200, body: { id: 'pl-1', impact: { socketChanges: { added: [], removed: [] }, planes: [] }, renderDigest: 'd' } },
  { status: 200, body: { changesetId: 'cs-1', id: 'pl-1' } },
  { status: 200, body: { revision: '4' } },
];

describe('recover', () => {
  it('recover 는 POST /api/v1/recover 만 한다. apply 와 changeset 을 안 연다', async () => {
    const { http, calls } = script([{ status: 200, body: { phase: 'activated' } }]);
    expect(await recover(http)).toEqual({ phase: 'activated' });
    expect(calls).toEqual([['POST', '/api/v1/recover']]);
    expect(calls.some(([m, p]) => m === 'POST' && p === '/api/v1/apply')).toBe(false);
    expect(calls.some(([, p]) => p.startsWith('/api/v1/changesets'))).toBe(false);
  });
});

describe('남은 GET', () => {
  it('오퍼레이션·plan·metrics 는 있는 GET 이다', () => {
    expect(getPath('operations/op-1')).toBe('/api/v1/operations/op-1');
    expect(getPath('plans/pl-1')).toBe('/api/v1/plans/pl-1');
    expect(getPath('metrics')).toBe('/metrics');
  });

  it('모르는 이름·빈 이름·주문은 경로를 안 만든다', () => {
    expect(getPath('')).toBeUndefined();
    expect(getPath('orders')).toBeUndefined();
    expect(getPath('operations/')).toBeUndefined();
    expect(getPath('plans/')).toBeUndefined();
  });

  it('오퍼레이션 get 은 GET 만 한다. apply 를 안 한다', async () => {
    const { http, calls } = script([{ status: 200, body: { id: 'op-1', phase: 'activated' } }]);
    expect(await getResource(http, 'operations/op-1')).toEqual({ id: 'op-1', phase: 'activated' });
    expect(calls).toEqual([['GET', '/api/v1/operations/op-1']]);
    expect(calls.some(([m, p]) => m === 'POST' && p === '/api/v1/apply')).toBe(false);
  });
});

describe('풀 삭제', () => {
  it('풀 삭제는 delete 한 줄이다', () => {
    expect(poolDeletePatch('app')).toEqual([{ op: 'delete', kind: 'pool', key: 'app' }]);
    expect(poolDeletePatch('')).toBeUndefined();
  });

  it('풀 delete 는 apply 를 안 한다', async () => {
    const { http, calls } = script(commitReplies());
    expect(await poolDelete(http, 'app')).toEqual({ revision: '4', planId: 'pl-1' });
    expect(calls.some(([m, p]) => m === 'POST' && p === '/api/v1/apply')).toBe(false);
    const patched = calls.find(([m, p]) => m === 'PATCH' && p === '/api/v1/changesets/cs-1');
    expect(patched?.[2]).toEqual({ patch: [{ op: 'delete', kind: 'pool', key: 'app' }] });
  });
});
