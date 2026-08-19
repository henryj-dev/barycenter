/**
 * CLI HTTP·TCP·UDP·HTTPS·패스스루 리스너 create — apply 가 아니다.
 */
import { describe, expect, it } from 'vitest';

import { listenerCreate, listenerCreatePatch } from '../../src/cli/listener.js';
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

describe('listener create 패치', () => {
  it('HTTP 리스너는 protocol=http 다. tls 를 안 붙인다', () => {
    const patch = listenerCreatePatch({
      name: 'web', protocol: 'http', bind: '0.0.0.0', port: 80, pool: 'app',
    });
    expect(patch).toEqual([{
      op: 'put',
      kind: 'listener',
      key: 'web',
      body: {
        protocol: 'http',
        bind: '0.0.0.0',
        port: 80,
        enabled: true,
        http: { defaultAction: { pool: 'app' } },
      },
    }]);
  });

  it('TCP 리스너는 protocol=tcp 다. http/tls 를 안 붙인다', () => {
    const patch = listenerCreatePatch({
      name: 'game', protocol: 'tcp', bind: '0.0.0.0', port: 999, pool: 'pool-a',
    });
    expect(patch).toEqual([{
      op: 'put',
      kind: 'listener',
      key: 'game',
      body: {
        protocol: 'tcp',
        bind: '0.0.0.0',
        port: 999,
        enabled: true,
        defaultPool: 'pool-a',
      },
    }]);
  });

  it('UDP 리스너는 named preset 이다. PROXY 필드가 없다', () => {
    const patch = listenerCreatePatch({
      name: 'dns', protocol: 'udp', bind: '0.0.0.0', port: 53, pool: 'pool-a', preset: 'dns',
    });
    expect(patch).toEqual([{
      op: 'put',
      kind: 'listener',
      key: 'dns',
      body: {
        protocol: 'udp',
        bind: '0.0.0.0',
        port: 53,
        enabled: true,
        defaultPool: 'pool-a',
        udp: { preset: 'dns' },
      },
    }]);
  });

  it('HTTPS 리스너는 tls 결박이 필수다. http2 를 안 적는다', () => {
    const patch = listenerCreatePatch({
      name: 'web', protocol: 'https', bind: '0.0.0.0', port: 443, pool: 'app',
      policy: 'modern', certificate: 'site',
    });
    expect(patch).toEqual([{
      op: 'put',
      kind: 'listener',
      key: 'web',
      body: {
        protocol: 'https',
        bind: '0.0.0.0',
        port: 443,
        enabled: true,
        http: { defaultAction: { pool: 'app' } },
        tls: { policy: 'modern', defaultCertificate: 'site' },
      },
    }]);
    expect(JSON.stringify(patch)).not.toContain('http2');
  });

  it('패스스루 리스너는 tls 를 안 붙인다', () => {
    const patch = listenerCreatePatch({
      name: 'edge', protocol: 'tls_passthrough', bind: '0.0.0.0', port: 443,
    });
    expect(patch).toEqual([{
      op: 'put',
      kind: 'listener',
      key: 'edge',
      body: {
        protocol: 'tls_passthrough',
        bind: '0.0.0.0',
        port: 443,
        enabled: true,
      },
    }]);
  });

  it('모르는 udp preset 과 tls 없는 https 는 패치를 안 만든다', () => {
    expect(listenerCreatePatch({
      name: 'dns', protocol: 'udp', bind: '0.0.0.0', port: 53, pool: 'pool-a',
    })).toBeUndefined();
    expect(listenerCreatePatch({
      name: 'dns', protocol: 'udp', bind: '0.0.0.0', port: 53, pool: 'pool-a', preset: 'quic',
    })).toBeUndefined();
    expect(listenerCreatePatch({
      name: 'web', protocol: 'https', bind: '0.0.0.0', port: 443, pool: 'app',
    })).toBeUndefined();
  });
});

describe('listener create 단계', () => {
  it('changeset 을 지나 commit 까지 하고 apply 는 안 한다', async () => {
    const { http, calls } = script([
      { status: 200, body: { revision: '3' } },
      { status: 201, body: { id: 'cs-1' } },
      { status: 200, body: {} },
      { status: 200, body: { id: 'pl-1', impact: { socketChanges: { added: [], removed: [] }, planes: [] }, renderDigest: 'd' } },
      { status: 200, body: { changesetId: 'cs-1', id: 'pl-1' } },
      { status: 200, body: { revision: '4' } },
    ]);
    expect(await listenerCreate(http, {
      name: 'web', protocol: 'http', bind: '0.0.0.0', port: 80, pool: 'app',
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
