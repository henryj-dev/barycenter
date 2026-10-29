/**
 * **URL 하나 → 풀·백엔드·리스너(또는 라우트)** (#112).
 *
 * 펼친 결과를 **실제 해독기·검증기·렌더에** 통과시킨다. 모양만 맞고 저장이 안 되는 patch 를
 * 만들지 않는 것이 이 파일의 요점이다.
 */
import { describe, expect, it } from 'vitest';

import { proxyFromUrlPatch, type ProxyFromUrlOp } from '../../src/web/edit.js';
import { parseListen } from '../../src/cli/proxy.js';
import { decodeModel } from '../../src/model/decode.js';
import { validateModel } from '../../src/validate/model.js';
import { render } from '../../src/conf/render.js';

/** put 들을 빈 모델에 얹는다 — 저장소가 하는 것과 같은 모양. */
function modelOf(ops: ProxyFromUrlOp[], existing: unknown[] = []): unknown {
  const m: Record<string, unknown[]> = {
    listeners: [...existing], httpRoutes: [], passthroughRoutes: [], pools: [], backends: [],
    certificates: [], tlsPolicies: [], sniBindings: [],
  };
  const slot: Record<string, string> = { pool: 'pools', backend: 'backends', listener: 'listeners', httpRoute: 'httpRoutes' };
  for (const op of ops) m[slot[op.kind]!]!.push({ key: op.key, ...op.body });
  return m;
}

function confOf(ops: ProxyFromUrlOp[], existing: unknown[] = []): string {
  const r = decodeModel(modelOf(ops, existing));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  expect(validateModel(r.model)).toEqual([]);
  return render(r.model).conf;
}

const listen = { bind: '127.0.0.1', port: 8080 };

describe('리스너 기본 동작으로 (호스트 없음)', () => {
  const ops = proxyFromUrlPatch({ name: 'example', url: 'https://example.com/', listen });

  it('풀 → 백엔드 → 리스너 순서다 — 참조되는 쪽이 먼저', () => {
    expect(ops.map((o) => `${o.kind}:${o.key}`)).toEqual(['pool:example', 'backend:example-1', 'listener:example']);
  });

  it('https 면 업스트림 TLS 와 SNI, 헬스체크는 tcp_connect', () => {
    expect(ops[0]!.body).toMatchObject({
      upstreamTls: { enabled: true, sni: 'example.com' }, healthCheck: { protocol: 'tcp_connect' },
    });
    expect(ops[1]!.body).toMatchObject({ host: 'example.com', port: 443 });
  });

  it('렌더: https 업스트림, SNI, Host 헤더', () => {
    const c = confOf(ops);
    expect(c).toMatch(/proxy_pass https:\/\/[a-z0-9_]+;/);
    expect(c).toContain('proxy_ssl_name example.com;');
    expect(c).toContain('proxy_set_header Host example.com;');
  });
});

describe('라우트로 (호스트 있음)', () => {
  const ops = proxyFromUrlPatch({
    name: 'api', url: 'https://api.example.com/v1/', listen, hosts: ['app.example.com'], pathPrefix: '/api/',
  });

  it('리스너 기본 동작은 거절이다 — 모르는 Host 가 외부로 새지 않는다', () => {
    const l = ops.find((o) => o.kind === 'listener')!;
    expect((l.body as { http: { defaultAction: unknown } }).http.defaultAction).toBe('reject');
  });

  it('렌더: 경로를 바꾸고 라우트에만 Host 를 건다', () => {
    const c = confOf(ops);
    expect(c).toMatch(/location \/api\/ \{\s+proxy_pass https:\/\/[a-z0-9_]+\/v1\/;/);
    expect(c).toContain('proxy_set_header Host api.example.com;');
  });

  it('기존 리스너에 붙인다 — 리스너를 새로 만들지 않는다', () => {
    const attach = proxyFromUrlPatch({ name: 'api', url: 'https://api.example.com/', listener: 'web', hosts: ['a.test'] });
    expect(attach.map((o) => o.kind)).toEqual(['pool', 'backend', 'httpRoute']);
    const web = { key: 'web', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true, http: { defaultAction: 'reject' } };
    expect(confOf(attach, [web])).toContain('proxy_set_header Host api.example.com;');
  });

  it('/ → / 는 rewritePrefix 를 안 싣는다 — 렌더 바이트를 늘리지 않는다', () => {
    const r = proxyFromUrlPatch({ name: 'x', url: 'https://x.test/', listen, hosts: ['a.test'] })
      .find((o) => o.kind === 'httpRoute')!;
    expect('rewritePrefix' in (r.body as { action: object }).action).toBe(false);
  });
});

describe('URL 해석', () => {
  it('http 는 TLS 없이 80', () => {
    const ops = proxyFromUrlPatch({ name: 'p', url: 'http://plain.test/', listen });
    expect('upstreamTls' in ops[0]!.body).toBe(false);
    expect(ops[1]!.body).toMatchObject({ port: 80 });
  });

  it('포트가 있으면 Host 헤더에 포트를 붙인다', () => {
    const ops = proxyFromUrlPatch({ name: 'p', url: 'https://api.test:8443/', listen });
    expect(ops[1]!.body).toMatchObject({ host: 'api.test', port: 8443 });
    expect(confOf(ops)).toContain('proxy_set_header Host api.test:8443;');
  });

  it('IP 면 SNI 를 안 보낸다', () => {
    const ops = proxyFromUrlPatch({ name: 'p', url: 'https://203.0.113.7/', listen });
    expect(ops[0]!.body).toMatchObject({ upstreamTls: { enabled: true } });
    expect((ops[0]!.body as { upstreamTls: object }).upstreamTls).not.toHaveProperty('sni');
  });

  it.each([
    ['ftp://x.test/', /https:\/\/ 나 http:\/\//],
    ['https://u:p@x.test/', /사용자 정보/],
    ['https://x.test/?a=1', /\? 나 #/],
    ['not a url', /URL 이 아니다/],
  ])('%s 는 거절한다', (url, msg) => {
    expect(() => proxyFromUrlPatch({ name: 'p', url, listen })).toThrow(msg);
  });

  it('경로가 있는데 호스트가 없으면 거절한다 — 경로 바꾸기는 라우트에만 있다', () => {
    expect(() => proxyFromUrlPatch({ name: 'p', url: 'https://x.test/v1/', listen })).toThrow(/--host/);
  });

  it('--listen 과 --listener 는 하나만', () => {
    expect(() => proxyFromUrlPatch({ name: 'p', url: 'https://x.test/' })).toThrow(/하나만/);
    expect(() => proxyFromUrlPatch({ name: 'p', url: 'https://x.test/', listen, listener: 'w', hosts: ['a'] })).toThrow(/하나만/);
  });

  it('기존 리스너에 붙이려면 호스트가 필요하다', () => {
    expect(() => proxyFromUrlPatch({ name: 'p', url: 'https://x.test/', listener: 'web' })).toThrow(/--host/);
  });
});

describe('parseListen', () => {
  it.each([
    ['127.0.0.1:8080', { bind: '127.0.0.1', port: 8080 }],
    ['[::1]:8443', { bind: '::1', port: 8443 }],
    ['8080', { bind: '0.0.0.0', port: 8080 }],
  ])('%s', (v, want) => { expect(parseListen(v)).toEqual(want); });

  it.each(['localhost', '1.2.3.4:0', '1.2.3.4:70000'])('%s 는 거절한다', (v) => {
    expect(() => parseListen(v)).toThrow();
  });
});

describe('HTTPS 리스너 (#116)', () => {
  const REF = `store://web@${'a'.repeat(32)}`;
  const tlsBits = {
    certificates: [{ key: 'web', materialRef: REF, chainDigest: `sha256:${'a'.repeat(64)}`, keyDigest: `sha256:${'b'.repeat(64)}` }],
    tlsPolicies: [{ key: 'modern', minVersion: '1.2' }],
  };
  const withTls = (ops: ProxyFromUrlOp[], sni: unknown[] = []): unknown =>
    ({ ...(modelOf(ops) as object), ...tlsBits, sniBindings: sni });
  const tls = { policy: 'modern', certificate: 'web' };

  it('정책과 인증서를 싣는다', () => {
    const ops = proxyFromUrlPatch({ name: 'api', url: 'https://api.example.com/', listen: { bind: '0.0.0.0', port: 443 }, protocol: 'https', tls });
    const l = ops.find((o) => o.kind === 'listener')!;
    expect(l.body).toMatchObject({ protocol: 'https', tls: { policy: 'modern', defaultCertificate: 'web' } });
  });

  it('렌더: 리스너는 ssl 로 열고 업스트림은 https 다', () => {
    const r = decodeModel(withTls(proxyFromUrlPatch({ name: 'api', url: 'https://api.example.com/', listen: { bind: '0.0.0.0', port: 443 }, protocol: 'https', tls })));
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(validateModel(r.model)).toEqual([]);
    const c = render(r.model).conf;
    expect(c).toMatch(/listen 443 ssl/);
    expect(c).toMatch(/proxy_pass https:\/\/[a-z0-9_]+;/);
  });

  it('**호스트를 주면 SNI 바인딩도 만든다** — 없으면 검증기가 sni_binding_missing 으로 막는다', () => {
    const ops = proxyFromUrlPatch({ name: 'api', url: 'https://api.example.com/', listen: { bind: '0.0.0.0', port: 443 }, protocol: 'https', tls, hosts: ['app.example.com'] });
    expect(ops.map((o) => o.kind)).toEqual(['pool', 'backend', 'listener', 'sniBinding', 'httpRoute']);
    const binding = ops.find((o) => o.kind === 'sniBinding')!;
    expect(binding.body).toEqual({ listener: 'api', hosts: ['app.example.com'], certificate: 'web' });
    const sni = ops.filter((o) => o.kind === 'sniBinding').map((o) => ({ key: o.key, ...o.body }));
    const rest = ops.filter((o) => o.kind !== 'sniBinding');
    const r = decodeModel(withTls(rest, sni));
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(validateModel(r.model)).toEqual([]);
  });

  it.each([
    [{ protocol: 'https' as const }, /--policy/],
    [{ protocol: 'https' as const, tls: { policy: 'modern', certificate: '' } }, /--certificate/],
    [{ tls }, /https 리스너에만/],
  ])('%j 는 거절한다', (extra, msg) => {
    expect(() => proxyFromUrlPatch({ name: 'p', url: 'https://x.test/', listen, ...extra })).toThrow(msg);
  });

  it('기존 리스너에 붙일 때는 프로토콜 플래그를 받지 않는다', () => {
    expect(() => proxyFromUrlPatch({ name: 'p', url: 'https://x.test/', listener: 'web', hosts: ['a.test'], protocol: 'https', tls }))
      .toThrow(/새 리스너/);
  });
});
