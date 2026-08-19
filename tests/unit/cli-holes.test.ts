/**
 * CLI 가까운 쓰기 구멍 — 패치 계약이 이미 있는 것들. apply 가 아니다.
 */
import { describe, expect, it } from 'vitest';

import { backendDelete, backendDeletePatch, backendPut, backendPutPatch } from '../../src/cli/backend.js';
import type { Http, HttpResult } from '../../src/cli/flow.js';
import { routeCreate } from '../../src/cli/route.js';
import {
  certificateCreate, certificatePutPatch, sniBindingCreate, sniBindingCreatePatch,
  tlsPolicyCreate, tlsPolicyCreatePatch,
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

const commitCalls = [
  ['GET', '/api/v1/config/head'],
  ['POST', '/api/v1/changesets'],
  ['PATCH', '/api/v1/changesets/cs-1'],
  ['POST', '/api/v1/changesets/cs-1/plan'],
  ['GET', '/api/v1/plans/pl-1'],
  ['POST', '/api/v1/changesets/cs-1/commit'],
] as const;

describe('백엔드', () => {
  it('백엔드 put 은 한 줄이다. 포트 0 은 패치를 안 만든다', () => {
    expect(backendPutPatch({
      name: 'a1', pool: 'app', host: '10.0.0.11', port: 11,
    })).toEqual([{
      op: 'put',
      kind: 'backend',
      key: 'a1',
      body: { pool: 'app', host: '10.0.0.11', port: 11, weight: 1 },
    }]);
    expect(backendPutPatch({
      name: 'a1', pool: 'app', host: '10.0.0.11', port: 0,
    })).toBeUndefined();
  });

  it('백엔드 삭제는 delete 한 줄이다', () => {
    expect(backendDeletePatch('a1')).toEqual([{ op: 'delete', kind: 'backend', key: 'a1' }]);
    expect(backendDeletePatch('')).toBeUndefined();
  });
});

describe('TLS 정책', () => {
  it('TLS 정책은 minVersion 만. HSTS 안 켠다', () => {
    expect(tlsPolicyCreatePatch({ name: 'modern' })).toEqual([{
      op: 'put', kind: 'tlsPolicy', key: 'modern', body: { minVersion: '1.2' },
    }]);
    expect(tlsPolicyCreatePatch({ name: 'modern', minVersion: '1.3' })).toEqual([{
      op: 'put', kind: 'tlsPolicy', key: 'modern', body: { minVersion: '1.3' },
    }]);
    expect(JSON.stringify(tlsPolicyCreatePatch({ name: 'modern' }))).not.toContain('hsts');
    expect(tlsPolicyCreatePatch({ name: 'modern', minVersion: '1.1' })).toBeUndefined();
  });
});

describe('인증서', () => {
  it('인증서 put 은 참조·digest 만. 개인키·fullchain 이 패치에 없다', () => {
    const patch = certificatePutPatch('site', {
      materialRef: 'm1', chainDigest: 'c1', keyDigest: 'k1',
    });
    expect(patch).toEqual([{
      op: 'put',
      kind: 'certificate',
      key: 'site',
      body: { materialRef: 'm1', chainDigest: 'c1', keyDigest: 'k1' },
    }]);
    expect(JSON.stringify(patch)).not.toContain('privkey');
    expect(JSON.stringify(patch)).not.toContain('fullchain');
    expect(certificatePutPatch('', { materialRef: 'm1', chainDigest: 'c1', keyDigest: 'k1' }))
      .toBeUndefined();
  });
});

describe('SNI 바인딩', () => {
  it('SNI 바인딩은 listener·hosts·certificate 다. override 없음', () => {
    expect(sniBindingCreatePatch({
      name: 'b1', listener: 'web', hosts: 'a.example.com', certificate: 'site',
    })).toEqual([{
      op: 'put',
      kind: 'sniBinding',
      key: 'b1',
      body: { listener: 'web', hosts: ['a.example.com'], certificate: 'site' },
    }]);
    expect(JSON.stringify(sniBindingCreatePatch({
      name: 'b1', listener: 'web', hosts: 'a.example.com', certificate: 'site',
    }))).not.toContain('override');
    expect(sniBindingCreatePatch({
      name: 'b1', listener: 'web', hosts: '  ,  ', certificate: 'site',
    })).toBeUndefined();
  });
});

describe('쓰기 단계', () => {
  it('백엔드 put 은 changeset 을 지나 commit 까지 하고 apply 는 안 한다', async () => {
    const { http, calls } = script(commitReplies());
    expect(await backendPut(http, {
      name: 'a1', pool: 'app', host: '10.0.0.11', port: 11,
    })).toEqual({ revision: '4', planId: 'pl-1' });
    expect(calls.map(([m, p]) => [m, p])).toEqual([...commitCalls]);
    expect(calls.some(([m, p]) => m === 'POST' && p === '/api/v1/apply')).toBe(false);
  });

  it('백엔드 delete 는 apply 를 안 한다', async () => {
    const { http, calls } = script(commitReplies());
    expect(await backendDelete(http, 'a1')).toEqual({ revision: '4', planId: 'pl-1' });
    expect(calls.some(([m, p]) => m === 'POST' && p === '/api/v1/apply')).toBe(false);
  });

  it('TLS 정책 create 는 apply 를 안 한다', async () => {
    const { http, calls } = script(commitReplies());
    expect(await tlsPolicyCreate(http, { name: 'modern' })).toEqual({ revision: '4', planId: 'pl-1' });
    expect(calls.map(([m, p]) => [m, p])).toEqual([...commitCalls]);
    expect(calls.some(([m, p]) => m === 'POST' && p === '/api/v1/apply')).toBe(false);
  });

  it('인증서 create 는 자료를 올린 뒤 참조만 커밋한다', async () => {
    const { http, calls } = script([
      { status: 201, body: { ref: 'm1', chainDigest: 'c1', keyDigest: 'k1' } },
      ...commitReplies(),
    ]);
    expect(await certificateCreate(http, {
      name: 'site', fullchain: 'CERT', privkey: 'KEY',
    })).toEqual({ revision: '4', planId: 'pl-1' });
    expect(calls.map(([m, p]) => [m, p])).toEqual([
      ['POST', '/api/v1/certificates/material'],
      ...commitCalls,
    ]);
    const material = calls[0]?.[2] as { fullchain?: string; privkey?: string };
    expect(material.fullchain).toBe('CERT');
    expect(material.privkey).toBe('KEY');
    const patched = calls[3]?.[2] as { patch?: { body?: Record<string, unknown> }[] };
    expect(JSON.stringify(patched.patch)).not.toContain('privkey');
    expect(JSON.stringify(patched.patch)).not.toContain('CERT');
    expect(calls.some(([m, p]) => m === 'POST' && p === '/api/v1/apply')).toBe(false);
  });

  it('SNI 바인딩 create 는 apply 를 안 한다', async () => {
    const { http, calls } = script(commitReplies());
    expect(await sniBindingCreate(http, {
      name: 'b1', listener: 'web', hosts: 'a.example.com', certificate: 'site',
    })).toEqual({ revision: '4', planId: 'pl-1' });
    expect(calls.some(([m, p]) => m === 'POST' && p === '/api/v1/apply')).toBe(false);
  });

  it('패스스루 라우트 create 는 apply 를 안 한다', async () => {
    const { http, calls } = script(commitReplies());
    expect(await routeCreate(http, {
      name: 'edge', listener: 'pt', snis: 'a.example.com', pool: 'tcp-a',
    })).toEqual({ revision: '4', planId: 'pl-1' });
    expect(calls.map(([m, p]) => [m, p])).toEqual([...commitCalls]);
    expect(calls.some(([m, p]) => m === 'POST' && p === '/api/v1/apply')).toBe(false);
  });
});
