/**
 * CLI 풀 create — 빈 풀만은 안 만든다. apply 가 아니다.
 */
import { describe, expect, it } from 'vitest';

import { poolCreate, poolCreatePatch } from '../../src/cli/pool.js';
import type { Http, HttpResult } from '../../src/cli/flow.js';

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

describe('pool create 패치', () => {
  it('풀은 첫 백엔드와 같이 넣는다. 빈 풀만은 안 만든다', () => {
    const patch = poolCreatePatch({
      name: 'app', protocolClass: 'http', backend: 'a1', host: '10.0.0.11', port: 11,
    });
    expect(patch).toEqual([
      {
        op: 'put',
        kind: 'pool',
        key: 'app',
        body: { protocolClass: 'http', algorithm: 'round_robin' },
      },
      {
        op: 'put',
        kind: 'backend',
        key: 'a1',
        body: { pool: 'app', host: '10.0.0.11', port: 11, weight: 1 },
      },
    ]);
  });

  it('hash·source_ip_hash·least_conn 은 패치를 안 만든다', () => {
    const base = { name: 'app', protocolClass: 'http', backend: 'a1', host: '10.0.0.11', port: 11 };
    expect(poolCreatePatch({ ...base, algorithm: 'hash' })).toBeUndefined();
    expect(poolCreatePatch({ ...base, algorithm: 'source_ip_hash' })).toBeUndefined();
    expect(poolCreatePatch({ ...base, algorithm: 'least_conn' })).toBeUndefined();
    expect(poolCreatePatch({ ...base, protocolClass: 'quic' })).toBeUndefined();
  });
});

describe('pool create 단계', () => {
  it('changeset 을 지나 commit 까지 하고 apply 는 안 한다', async () => {
    const { http, calls } = script([
      { status: 200, body: { revision: '3' } },
      { status: 201, body: { id: 'cs-1' } },
      { status: 200, body: {} },
      { status: 200, body: { id: 'pl-1', impact: { socketChanges: { added: [], removed: [] }, planes: [] }, renderDigest: 'd' } },
      { status: 200, body: { changesetId: 'cs-1', id: 'pl-1' } },
      { status: 200, body: { revision: '4' } },
    ]);
    expect(await poolCreate(http, {
      name: 'app', protocolClass: 'http', backend: 'a1', host: '10.0.0.11', port: 11,
    })).toEqual({ revision: '4', planId: 'pl-1' });
    expect(calls.map(([m, p]) => [m, p])).toEqual([
      ['GET', '/api/v1/config/head'],
      ['POST', '/api/v1/changesets'],
      ['PATCH', '/api/v1/changesets/cs-1'],
      ['POST', '/api/v1/changesets/cs-1/plan'],
      ['GET', '/api/v1/plans/pl-1'],
      ['POST', '/api/v1/changesets/cs-1/commit'],
    ]);
    expect(calls.some(([m, p]) => m === 'POST' && p === '/api/v1/apply')).toBe(false);
  });
});
