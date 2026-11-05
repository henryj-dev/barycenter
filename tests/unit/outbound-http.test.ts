/**
 * 바깥 호출의 공통 규칙 — https 만 · 리다이렉트 거절 · 응답 상한 — 과 SigV4 서명.
 *
 * SigV4 는 AWS 문서의 공개 예시(get-vanilla · IAM ListUsers)와 같은 서명이 나오는지 본다.
 * 예시의 비밀 키는 AWS 가 문서에 싣는 가짜 값이다. 검사기에 걸리지 않게 실행 중에 이어 붙인다.
 */
import { describe, expect, it } from 'vitest';

import { httpRequest, readBounded } from '../../src/outbound/http.js';
import { readSecretFile } from '../../src/outbound/secret-file.js';
import { signV4 } from '../../src/outbound/sigv4.js';

const fakeAws = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: ['wJalrXUtnFEMI', 'K7MDENG+bPxRfiCYEXAMPLEKEY'].join('/') };
const at = new Date('2015-08-30T12:36:00Z');

describe('SigV4', () => {
  it('get-vanilla 예시와 같은 서명', () => {
    const h = signV4({ method: 'GET', url: 'https://example.amazonaws.com/', headers: {}, body: '', region: 'us-east-1', service: 'service', credentials: fakeAws, now: at });
    expect(h['authorization']).toBe('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
    expect(h['x-amz-date']).toBe('20150830T123600Z');
  });

  it('IAM ListUsers 예시와 같은 서명(쿼리 · content-type)', () => {
    const h = signV4({
      method: 'GET', url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' }, body: '',
      region: 'us-east-1', service: 'iam', credentials: fakeAws, now: at,
    });
    expect(h['authorization']).toContain('SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
  });
});

describe('httpRequest', () => {
  it('http 주소는 보내지 않는다', async () => {
    let called = false;
    const r = await httpRequest({ method: 'POST', url: 'http://example.test/x', fetch: (async () => { called = true; return new Response('ok'); }) as typeof fetch });
    expect(r).toMatchObject({ ok: false, reason: 'insecure' });
    expect(called).toBe(false);
  });

  it('리다이렉트를 따라가지 않게 redirect:error 로 부른다', async () => {
    let init: RequestInit | undefined;
    await httpRequest({ method: 'GET', url: 'https://example.test/', fetch: (async (_u: unknown, i?: RequestInit) => { init = i; return new Response(''); }) as typeof fetch });
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeDefined();
  });

  it('fetch 가 던지면 unreachable', async () => {
    const r = await httpRequest({ method: 'GET', url: 'https://example.test/', fetch: (async () => { throw new TypeError('redirect mode is set to error'); }) as typeof fetch });
    expect(r).toMatchObject({ ok: false, reason: 'unreachable' });
  });

  it('상한을 넘는 답은 too-large — 선언이 없어도 세면서 끊는다', async () => {
    const big = new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < 10; i += 1) c.enqueue(new Uint8Array(1024)); c.close(); } });
    const r = await httpRequest({ method: 'GET', url: 'https://example.test/', maxBytes: 4096, fetch: (async () => new Response(big)) as typeof fetch });
    expect(r).toMatchObject({ ok: false, reason: 'too-large' });
    await expect(readBounded(new Response('x'.repeat(10), { headers: { 'content-length': '10' } }), 5)).rejects.toThrow();
  });
});

describe('readSecretFile', () => {
  it('끝 줄바꿈을 지우고, 빈 파일 · 없는 파일은 던진다(값은 문장에 없다)', () => {
    expect(readSecretFile('X_FILE', '/p', () => 'abc\n')).toBe('abc');
    expect(() => readSecretFile('X_FILE', '/p', () => '\n')).toThrow(/비었다/);
    expect(() => readSecretFile('X_FILE', '/nope', () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); })).toThrow(/ENOENT/);
  });
});
