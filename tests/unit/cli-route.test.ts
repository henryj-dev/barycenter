/**
 * CLI HTTP 라우트 create — proxy 또는 redirect. apply 가 아니다.
 */
import { describe, expect, it } from 'vitest';

import { routeCreate, routeCreatePatch } from '../../src/cli/route.js';
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

describe('route create 패치', () => {
  it('HTTP 라우트는 proxy 다. websocket 은 끈다', () => {
    const patch = routeCreatePatch({
      name: 'api', listener: 'web', hosts: 'api.example.com', pool: 'app',
    });
    expect(patch).toEqual([{
      op: 'put',
      kind: 'httpRoute',
      key: 'api',
      body: {
        listener: 'web',
        hosts: ['api.example.com'],
        priority: 0,
        action: { kind: 'proxy', pool: 'app', websocket: false },
      },
    }]);
  });

  it('HTTP redirect 는 to·status 다. pool 이 없다', () => {
    const patch = routeCreatePatch({
      name: 'old', listener: 'web', hosts: 'old.example.com', to: 'https://new.example.com',
    });
    expect(patch).toEqual([{
      op: 'put',
      kind: 'httpRoute',
      key: 'old',
      body: {
        listener: 'web',
        hosts: ['old.example.com'],
        priority: 0,
        action: { kind: 'redirect', to: 'https://new.example.com', status: 302 },
      },
    }]);
  });

  it('빈 호스트·대상·모르는 status 와 pool+to 는 패치를 안 만든다', () => {
    expect(routeCreatePatch({
      name: 'api', listener: 'web', hosts: '  ,  ', pool: 'app',
    })).toBeUndefined();
    expect(routeCreatePatch({
      name: 'old', listener: 'web', hosts: 'old.example.com', to: '',
    })).toBeUndefined();
    expect(routeCreatePatch({
      name: 'old', listener: 'web', hosts: 'old.example.com', to: 'https://x', status: '200',
    })).toBeUndefined();
    expect(routeCreatePatch({
      name: 'old', listener: 'web', hosts: 'old.example.com', pool: 'app', to: 'https://x',
    })).toBeUndefined();
  });
});

describe('route create 단계', () => {
  it('changeset 을 지나 commit 까지 하고 apply 는 안 한다', async () => {
    const { http, calls } = script([
      { status: 200, body: { revision: '3' } },
      { status: 201, body: { id: 'cs-1' } },
      { status: 200, body: {} },
      { status: 200, body: { id: 'pl-1', impact: { socketChanges: { added: [], removed: [] }, planes: [] }, renderDigest: 'd' } },
      { status: 200, body: { changesetId: 'cs-1', id: 'pl-1' } },
      { status: 200, body: { revision: '4' } },
    ]);
    expect(await routeCreate(http, {
      name: 'api', listener: 'web', hosts: 'api.example.com', pool: 'app',
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
