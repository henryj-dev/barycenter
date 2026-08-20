/**
 * CLI 가 GUI 와 같은 삭제를 연다 — apply 가 아니다.
 *
 * GUI 가 빼는 것은 listener · httpRoute · passthroughRoute · sniBinding · backend ·
 * certificate · tlsPolicy 다. backend 는 이미 있다.
 */
import { describe, expect, it } from 'vitest';

import type { Http, HttpResult } from '../../src/cli/flow.js';
import { listenerDelete, listenerDeletePatch } from '../../src/cli/listener.js';
import { routeDelete, routeDeletePatch } from '../../src/cli/route.js';
import {
  certificateDelete, certificateDeletePatch, sniBindingDelete, sniBindingDeletePatch,
  tlsPolicyDelete, tlsPolicyDeletePatch,
} from '../../src/cli/tls.js';

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

describe('리스너 삭제', () => {
  it('리스너 삭제는 delete 한 줄이다', () => {
    expect(listenerDeletePatch('web')).toEqual([{ op: 'delete', kind: 'listener', key: 'web' }]);
    expect(listenerDeletePatch('')).toBeUndefined();
  });

  it('리스너 delete 는 apply 를 안 한다', async () => {
    const { http, calls } = script(commitReplies());
    expect(await listenerDelete(http, 'web')).toEqual({ revision: '4', planId: 'pl-1' });
    expect(calls.some(([m, p]) => m === 'POST' && p === '/api/v1/apply')).toBe(false);
    const patched = calls.find(([m, p]) => m === 'PATCH' && p === '/api/v1/changesets/cs-1');
    expect(patched?.[2]).toEqual({ patch: [{ op: 'delete', kind: 'listener', key: 'web' }] });
  });
});

describe('라우트 삭제', () => {
  it('HTTP 라우트 삭제는 --host 다. 패스스루는 --sni 다', () => {
    expect(routeDeletePatch({ name: 'api', host: true })).toEqual([
      { op: 'delete', kind: 'httpRoute', key: 'api' },
    ]);
    expect(routeDeletePatch({ name: 'edge', sni: true })).toEqual([
      { op: 'delete', kind: 'passthroughRoute', key: 'edge' },
    ]);
    expect(routeDeletePatch({ name: 'api' })).toBeUndefined();
    expect(routeDeletePatch({ name: 'api', host: true, sni: true })).toBeUndefined();
    expect(routeDeletePatch({ name: '', host: true })).toBeUndefined();
  });

  it('HTTP 라우트 delete 는 apply 를 안 한다', async () => {
    const { http, calls } = script(commitReplies());
    expect(await routeDelete(http, { name: 'api', host: true })).toEqual({ revision: '4', planId: 'pl-1' });
    expect(calls.some(([m, p]) => m === 'POST' && p === '/api/v1/apply')).toBe(false);
  });
});

describe('SNI 바인딩 삭제', () => {
  it('SNI 바인딩 삭제는 delete 한 줄이다', () => {
    expect(sniBindingDeletePatch('b1')).toEqual([{ op: 'delete', kind: 'sniBinding', key: 'b1' }]);
    expect(sniBindingDeletePatch('')).toBeUndefined();
  });

  it('SNI 바인딩 delete 는 apply 를 안 한다', async () => {
    const { http, calls } = script(commitReplies());
    expect(await sniBindingDelete(http, 'b1')).toEqual({ revision: '4', planId: 'pl-1' });
    expect(calls.some(([m, p]) => m === 'POST' && p === '/api/v1/apply')).toBe(false);
  });
});

describe('인증서·TLS 정책 삭제', () => {
  it('인증서·정책 삭제는 delete 한 줄이다', () => {
    expect(certificateDeletePatch('site')).toEqual([{ op: 'delete', kind: 'certificate', key: 'site' }]);
    expect(tlsPolicyDeletePatch('modern')).toEqual([{ op: 'delete', kind: 'tlsPolicy', key: 'modern' }]);
    expect(certificateDeletePatch('')).toBeUndefined();
    expect(tlsPolicyDeletePatch('')).toBeUndefined();
  });

  it('인증서 delete 는 apply 를 안 한다', async () => {
    const { http, calls } = script(commitReplies());
    expect(await certificateDelete(http, 'site')).toEqual({ revision: '4', planId: 'pl-1' });
    expect(calls.some(([m, p]) => m === 'POST' && p === '/api/v1/apply')).toBe(false);
    const patched = calls.find(([m, p]) => m === 'PATCH' && p === '/api/v1/changesets/cs-1');
    expect(patched?.[2]).toEqual({ patch: [{ op: 'delete', kind: 'certificate', key: 'site' }] });
  });

  it('TLS 정책 delete 는 apply 를 안 한다', async () => {
    const { http, calls } = script(commitReplies());
    expect(await tlsPolicyDelete(http, 'modern')).toEqual({ revision: '4', planId: 'pl-1' });
    expect(calls.some(([m, p]) => m === 'POST' && p === '/api/v1/apply')).toBe(false);
  });
});
