/**
 * CLI HTTP 라우트 create — proxy · redirect · reject. apply 가 아니다.
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

  it('HTTP reject 는 403·404·444 다. to·pool 이 없다', () => {
    const patch = routeCreatePatch({
      name: 'deny', listener: 'web', hosts: 'bad.example.com', reject: true,
    });
    expect(patch).toEqual([{
      op: 'put',
      kind: 'httpRoute',
      key: 'deny',
      body: {
        listener: 'web',
        hosts: ['bad.example.com'],
        priority: 0,
        action: { kind: 'reject', status: 403 },
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
    expect(routeCreatePatch({
      name: 'deny', listener: 'web', hosts: 'bad.example.com', reject: true, status: '302',
    })).toBeUndefined();
    expect(routeCreatePatch({
      name: 'deny', listener: 'web', hosts: 'bad.example.com', reject: true, pool: 'app',
    })).toBeUndefined();
  });

  it('websocket 을 켜면 proxy 에 true 가 실린다', () => {
    const patch = routeCreatePatch({
      name: 'api', listener: 'web', hosts: 'api.example.com', pool: 'app', websocket: true,
    });
    expect(patch).toEqual([{
      op: 'put',
      kind: 'httpRoute',
      key: 'api',
      body: {
        listener: 'web',
        hosts: ['api.example.com'],
        priority: 0,
        action: { kind: 'proxy', pool: 'app', websocket: true },
      },
    }]);
  });

  it('패스스루 라우트는 SNI → 풀이다. websocket·path 가 없다', () => {
    const patch = routeCreatePatch({
      name: 'edge', listener: 'pt', snis: 'a.example.com', pool: 'tcp-a',
    });
    expect(patch).toEqual([{
      op: 'put',
      kind: 'passthroughRoute',
      key: 'edge',
      body: {
        listener: 'pt',
        snis: ['a.example.com'],
        priority: 0,
        action: { kind: 'proxy', pool: 'tcp-a' },
      },
    }]);
    expect(JSON.stringify(patch)).not.toContain('websocket');
    expect(JSON.stringify(patch)).not.toContain('path');
  });

  it('패스스루 reject 는 SNI 만 끊는다 — status 가 없다', () => {
    const patch = routeCreatePatch({
      name: 'edge', listener: 'pt', snis: 'bad.example.com', reject: true,
    });
    expect(patch).toEqual([{
      op: 'put',
      kind: 'passthroughRoute',
      key: 'edge',
      body: {
        listener: 'pt',
        snis: ['bad.example.com'],
        priority: 0,
        action: { kind: 'reject' },
      },
    }]);
    expect(JSON.stringify(patch)).not.toContain('status');
    expect(JSON.stringify(patch)).not.toContain('pool');
  });

  it('redirect·reject·패스스루에 websocket 과 빈 SNI 는 패치를 안 만든다', () => {
    expect(routeCreatePatch({
      name: 'old', listener: 'web', hosts: 'old.example.com', to: 'https://x', websocket: true,
    })).toBeUndefined();
    expect(routeCreatePatch({
      name: 'deny', listener: 'web', hosts: 'bad.example.com', reject: true, websocket: true,
    })).toBeUndefined();
    expect(routeCreatePatch({
      name: 'edge', listener: 'pt', snis: 'a.example.com', pool: 'tcp-a', websocket: true,
    })).toBeUndefined();
    expect(routeCreatePatch({
      name: 'edge', listener: 'pt', snis: '  ,  ', pool: 'tcp-a',
    })).toBeUndefined();
    expect(routeCreatePatch({
      name: 'edge', listener: 'pt', snis: 'a.example.com', reject: true, pool: 'tcp-a',
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
