/**
 * CLI 의 호스트 리스너 (ADR-VHOST, 2026-10-31).
 *
 *   · `bary listener create --hosts` — http · https 리스너가 받을 이름을 싣는다. 다른 프로토콜은 한 줄로 거절한다
 *   · `bary listener update --hosts | --clear-hosts` — head 의 그 리스너를 바탕으로 **호스트만** 바꾼다.
 *     다른 칸(헤더 규칙 · TLS · 출발지 제한 …)은 그대로 싣는다 — `put` 은 리스너 전체를 갈아 끼우기 때문이다
 */
import { describe, expect, it } from 'vitest';

import { listenerCreate, listenerCreatePatch, listenerUpdate, listenerUpdatePatch } from '../../src/cli/listener.js';
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

const httpsListener = {
  key: 'web', protocol: 'https', bind: '0.0.0.0', port: 443, enabled: true,
  sourceAllow: ['@internal'],
  tls: { policy: 'p', defaultCertificate: 'c' },
  http: { defaultAction: { pool: 'app' }, headers: { request: [{ op: 'set', name: 'X-A', value: '1' }] } },
};

describe('listener create --hosts', () => {
  it('http 리스너에 hosts 를 싣는다', () => {
    const patch = listenerCreatePatch({
      name: 'a', protocol: 'http', bind: '0.0.0.0', port: 80, pool: 'app', hosts: ['a.example.com'],
    });
    expect(patch?.[0]?.body).toMatchObject({ protocol: 'http', hosts: ['a.example.com'] });
  });

  it('https 리스너에 hosts 를 싣는다', () => {
    const patch = listenerCreatePatch({
      name: 'a', protocol: 'https', bind: '0.0.0.0', port: 443, pool: 'app',
      policy: 'p', certificate: 'c', hosts: ['a.example.com', 'b.example.com'],
    });
    expect(patch?.[0]?.body).toMatchObject({ protocol: 'https', hosts: ['a.example.com', 'b.example.com'] });
  });

  it('hosts 가 없으면 키를 안 만든다 — 그 포트의 기본 리스너다', () => {
    const patch = listenerCreatePatch({ name: 'a', protocol: 'http', bind: '0.0.0.0', port: 80, pool: 'app', hosts: [] });
    expect(patch?.[0]?.body).not.toHaveProperty('hosts');
  });

  it('tcp 에 hosts 를 주면 요청을 보내기 전에 한 줄로 거절한다', async () => {
    const { http, calls } = script([]);
    await expect(listenerCreate(http, {
      name: 'g', protocol: 'tcp', bind: '0.0.0.0', port: 999, pool: 'p', hosts: ['a.example.com'],
    })).rejects.toThrow(/http · https 만/);
    expect(calls).toHaveLength(0);
  });
});

describe('listener update --hosts', () => {
  it('호스트만 바꾸고 나머지 칸은 그대로 싣는다', () => {
    const [op] = listenerUpdatePatch(httpsListener, { name: 'web', hosts: ['a.example.com'] });
    const { key: _k, ...rest } = httpsListener;
    expect(op).toEqual({ op: 'put', kind: 'listener', key: 'web', body: { ...rest, hosts: ['a.example.com'] } });
  });

  it('출발지 제한을 지우지 않는다', () => {
    const [op] = listenerUpdatePatch(httpsListener, { name: 'web', hosts: ['a.example.com'] });
    expect(op?.body['sourceAllow']).toEqual(['@internal']);
  });

  it('빈 목록(--clear-hosts)은 호스트 키를 지운다', () => {
    const [op] = listenerUpdatePatch({ ...httpsListener, hosts: ['a.example.com'] }, { name: 'web', hosts: [] });
    expect(op?.body).not.toHaveProperty('hosts');
    expect(op?.body['tls']).toEqual(httpsListener.tls);
  });

  it('tcp 리스너는 거절한다', () => {
    expect(() => listenerUpdatePatch(
      { key: 'g', protocol: 'tcp', bind: '0.0.0.0', port: 999, enabled: true, defaultPool: 'p' },
      { name: 'g', hosts: ['a.example.com'] },
    )).toThrow(/호스트가 없다/);
  });

  it('head 의 리스너를 읽어 바탕으로 쓰고, 한 번에 커밋한다', async () => {
    const { http, calls } = script([
      { status: 200, body: [httpsListener] },
      { status: 200, body: { revision: '7' } },
      { status: 201, body: { id: 'cs1' } },
      { status: 200, body: {} },
      { status: 200, body: { id: 'pl1', impact: { socketChanges: { added: [], removed: [] }, planes: [] }, renderDigest: 'd' } },
      { status: 200, body: { changesetId: 'cs1', id: 'pl1' } },
      { status: 200, body: { revision: '8' } },
    ]);
    const out = await listenerUpdate(http, { name: 'web', hosts: ['a.example.com'] });
    expect(out.revision).toBe('8');
    expect(calls[0]).toEqual(['GET', '/api/v1/listeners']);
    // 바탕을 읽은 뒤 changeset 에 실은 patch 에 새 호스트가 있다.
    expect(JSON.stringify(calls[3])).toContain('"hosts":["a.example.com"]');
    expect(calls.some(([m, p]) => m === 'POST' && p === '/api/v1/apply')).toBe(false);
  });

  it('head 에 없는 리스너는 커밋하지 않고 거절한다', async () => {
    const { http, calls } = script([{ status: 200, body: [httpsListener] }]);
    await expect(listenerUpdate(http, { name: 'nope', hosts: ['a.example.com'] })).rejects.toThrow(/head 에 없다/);
    expect(calls).toHaveLength(1);
  });
});
