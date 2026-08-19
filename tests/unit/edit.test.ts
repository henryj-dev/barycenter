/**
 * GUI 편집 패치 — 브라우저 없이 계약을 지킨다.
 */
import { describe, expect, it } from 'vitest';

import { deletePatch, putBackendPatch, putCertificatePatch, putHttpListenerPatch, putHttpsListenerPatch, putHttpRedirectPatch, putHttpRejectPatch, putHttpRoutePatch, putPassthroughListenerPatch, putPassthroughRoutePatch, putPoolWithBackendPatch, putSniBindingPatch, putTcpListenerPatch, putTlsPolicyPatch, putUdpListenerPatch } from '../../src/web/edit.js';

describe('설정에서 빼기', () => {
  it('백엔드를 빼는 패치는 delete 한 줄이다 — apply 가 아니다', () => {
    expect(deletePatch('backend', 'be-a')).toEqual([
      { op: 'delete', kind: 'backend', key: 'be-a' },
    ]);
  });

  it('빈 키는 패치를 만들지 않는다', () => {
    expect(() => deletePatch('backend', '')).toThrow(/키/);
  });

  it('백엔드를 넣는 패치는 put 한 줄이다 — apply 가 아니다', () => {
    expect(putBackendPatch('be-b', { pool: 'web', host: '10.0.0.3', port: 8080 })).toEqual([
      {
        op: 'put', kind: 'backend', key: 'be-b',
        body: { pool: 'web', host: '10.0.0.3', port: 8080, weight: 1 },
      },
    ]);
  });

  it('포트가 정수가 아니면 패치를 만들지 않는다', () => {
    expect(() => putBackendPatch('be-b', { pool: 'web', host: '10.0.0.3', port: 0 })).toThrow(/포트/);
  });

  it('풀은 첫 백엔드와 같이 넣는다 — 빈 풀은 plan 이 막힌다', () => {
    expect(putPoolWithBackendPatch({
      pool: 'web', protocolClass: 'http', backend: 'a', host: '10.0.0.1', port: 80,
    })).toEqual([
      { op: 'put', kind: 'pool', key: 'web', body: { protocolClass: 'http', algorithm: 'round_robin' } },
      { op: 'put', kind: 'backend', key: 'a', body: { pool: 'web', host: '10.0.0.1', port: 80, weight: 1 } },
    ]);
  });

  it('HTTP 리스너를 넣는 패치는 put 한 줄이다 — tls 는 안 붙인다', () => {
    expect(putHttpListenerPatch('front', { bind: '0.0.0.0', port: 999, pool: 'app' })).toEqual([
      {
        op: 'put', kind: 'listener', key: 'front',
        body: {
          protocol: 'http', bind: '0.0.0.0', port: 999, enabled: true,
          http: { defaultAction: { pool: 'app' } },
        },
      },
    ]);
  });

  it('TCP 리스너를 넣는 패치는 put 한 줄이다 — defaultPool 이지 http 가 아니다', () => {
    expect(putTcpListenerPatch('stream', { bind: '0.0.0.0', port: 9000, pool: 'db' })).toEqual([
      {
        op: 'put', kind: 'listener', key: 'stream',
        body: {
          protocol: 'tcp', bind: '0.0.0.0', port: 9000, enabled: true,
          defaultPool: 'db',
        },
      },
    ]);
  });

  it('TCP 패치에 http 프로필을 붙이지 않는다', () => {
    const [op] = putTcpListenerPatch('stream', { bind: '0.0.0.0', port: 9000, pool: 'db' });
    expect(op).toBeDefined();
    expect(op?.body).not.toHaveProperty('http');
    expect(op?.body).not.toHaveProperty('tls');
    expect(op?.body).not.toHaveProperty('udp');
  });

  it('UDP 리스너를 넣는 패치는 put 한 줄이다 — preset 이 필수다', () => {
    expect(putUdpListenerPatch('dns', {
      bind: '0.0.0.0', port: 53, pool: 'resolvers', preset: 'dns',
    })).toEqual([
      {
        op: 'put', kind: 'listener', key: 'dns',
        body: {
          protocol: 'udp', bind: '0.0.0.0', port: 53, enabled: true,
          defaultPool: 'resolvers', udp: { preset: 'dns' },
        },
      },
    ]);
  });

  it('모르는 UDP preset 은 패치를 만들지 않는다', () => {
    expect(() => putUdpListenerPatch('dns', {
      bind: '0.0.0.0', port: 53, pool: 'resolvers',
      preset: '없음' as 'dns',
    })).toThrow(/preset/);
  });

  it('TLS 정책은 minVersion 한 줄이다', () => {
    expect(putTlsPolicyPatch('modern')).toEqual([
      { op: 'put', kind: 'tlsPolicy', key: 'modern', body: { minVersion: '1.2' } },
    ]);
  });

  it('HTTPS 리스너를 넣는 패치는 tls 결박을 붙인다 — 평문 443 이 아니다', () => {
    expect(putHttpsListenerPatch('front-tls', {
      bind: '0.0.0.0', port: 443, pool: 'app', policy: 'modern', certificate: 'cert-a',
    })).toEqual([
      {
        op: 'put', kind: 'listener', key: 'front-tls',
        body: {
          protocol: 'https', bind: '0.0.0.0', port: 443, enabled: true,
          http: { defaultAction: { pool: 'app' } },
          tls: { policy: 'modern', defaultCertificate: 'cert-a' },
        },
      },
    ]);
  });

  it('인증서가 비면 HTTPS 패치를 만들지 않는다', () => {
    expect(() => putHttpsListenerPatch('front-tls', {
      bind: '0.0.0.0', port: 443, pool: 'app', policy: 'modern', certificate: '',
    })).toThrow(/인증서/);
  });

  it('인증서 패치에는 참조만 실린다 — 개인키가 없다', () => {
    const patch = putCertificatePatch('cert-a', {
      materialRef: 'store://cert-a@1',
      chainDigest: 'sha256:' + 'a'.repeat(64),
      keyDigest: 'sha256:' + 'b'.repeat(64),
    });
    expect(patch).toEqual([
      {
        op: 'put', kind: 'certificate', key: 'cert-a',
        body: {
          materialRef: 'store://cert-a@1',
          chainDigest: 'sha256:' + 'a'.repeat(64),
          keyDigest: 'sha256:' + 'b'.repeat(64),
        },
      },
    ]);
    expect(JSON.stringify(patch)).not.toMatch(/PRIVATE KEY|fullchain|privkey/);
  });

  it('자료 참조가 비면 인증서 패치를 만들지 않는다', () => {
    expect(() => putCertificatePatch('cert-a', {
      materialRef: '', chainDigest: 'sha256:aa', keyDigest: 'sha256:bb',
    })).toThrow(/참조/);
  });

  it('SNI 바인딩 패치는 listener·hosts·certificate 다 — 라우트에 안 붙인다', () => {
    expect(putSniBindingPatch({
      key: 'sni-a', listener: 'front-tls', hosts: ['app.example.com'], certificate: 'cert-a',
    })).toEqual([
      {
        op: 'put', kind: 'sniBinding', key: 'sni-a',
        body: { listener: 'front-tls', hosts: ['app.example.com'], certificate: 'cert-a' },
      },
    ]);
  });

  it('SNI 바인딩에 override 를 안 붙인다', () => {
    const patch = putSniBindingPatch({
      key: 'sni-a', listener: 'front-tls', hosts: ['app.example.com'], certificate: 'cert-a',
    });
    expect(patch[0]?.body).not.toHaveProperty('override');
  });

  it('호스트가 없으면 SNI 바인딩 패치를 만들지 않는다', () => {
    expect(() => putSniBindingPatch({
      key: 'sni-a', listener: 'front-tls', hosts: ['  '], certificate: 'cert-a',
    })).toThrow(/호스트/);
  });

  it('패스스루 리스너를 넣는 패치는 put 한 줄이다 — tls 를 안 붙인다', () => {
    expect(putPassthroughListenerPatch('edge', { bind: '0.0.0.0', port: 443 })).toEqual([
      {
        op: 'put', kind: 'listener', key: 'edge',
        body: {
          protocol: 'tls_passthrough', bind: '0.0.0.0', port: 443, enabled: true,
        },
      },
    ]);
  });

  it('패스스루 패치에 tls·http·defaultPool 을 안 붙인다', () => {
    const [op] = putPassthroughListenerPatch('edge', { bind: '0.0.0.0', port: 443 });
    expect(op).toBeDefined();
    expect(op?.body).not.toHaveProperty('tls');
    expect(op?.body).not.toHaveProperty('http');
    expect(op?.body).not.toHaveProperty('defaultPool');
    expect(op?.body).not.toHaveProperty('onUnmatchedSni');
  });

  it('unmatched SNI 풀이 있으면 onUnmatchedSni 만 붙인다', () => {
    expect(putPassthroughListenerPatch('edge', {
      bind: '0.0.0.0', port: 443, pool: 'origin',
    })).toEqual([
      {
        op: 'put', kind: 'listener', key: 'edge',
        body: {
          protocol: 'tls_passthrough', bind: '0.0.0.0', port: 443, enabled: true,
          onUnmatchedSni: { pool: 'origin' },
        },
      },
    ]);
  });

  it('HTTP 라우트를 넣는 패치는 put 한 줄이다 — proxy 이고 websocket 은 끈다', () => {
    expect(putHttpRoutePatch({
      key: 'r-app', listener: 'front', hosts: ['app.example.com'], pool: 'app',
    })).toEqual([
      {
        op: 'put', kind: 'httpRoute', key: 'r-app',
        body: {
          listener: 'front', hosts: ['app.example.com'], priority: 0,
          action: { kind: 'proxy', pool: 'app', websocket: false },
        },
      },
    ]);
  });

  it('경로가 비면 pathPrefix 를 붙이지 않는다', () => {
    const patch = putHttpRoutePatch({
      key: 'r-app', listener: 'front', hosts: ['app.example.com'], pool: 'app',
      pathPrefix: '  ',
    });
    expect(patch[0]?.body).not.toHaveProperty('pathPrefix');
  });

  it('호스트가 없으면 패치를 만들지 않는다', () => {
    expect(() => putHttpRoutePatch({
      key: 'r-app', listener: 'front', hosts: ['  ', ''], pool: 'app',
    })).toThrow(/호스트/);
  });

  it('HTTP 라우트를 빼는 패치는 delete 한 줄이다', () => {
    expect(deletePatch('httpRoute', 'r-app')).toEqual([
      { op: 'delete', kind: 'httpRoute', key: 'r-app' },
    ]);
  });

  it('HTTP redirect 패치는 to·status 다 — pool 을 안 붙인다', () => {
    expect(putHttpRedirectPatch({
      key: 'r-https', listener: 'front', hosts: ['app.example.com'], to: 'https://app.example.com/',
    })).toEqual([
      {
        op: 'put', kind: 'httpRoute', key: 'r-https',
        body: {
          listener: 'front', hosts: ['app.example.com'], priority: 0,
          action: { kind: 'redirect', to: 'https://app.example.com/', status: 302 },
        },
      },
    ]);
  });

  it('HTTP redirect 패치에 pool·websocket 을 안 붙인다', () => {
    const [op] = putHttpRedirectPatch({
      key: 'r-https', listener: 'front', hosts: ['app.example.com'], to: 'https://x/',
    });
    expect(op?.body.action).not.toHaveProperty('pool');
    expect(op?.body.action).not.toHaveProperty('websocket');
  });

  it('대상이 비면 redirect 패치를 만들지 않는다', () => {
    expect(() => putHttpRedirectPatch({
      key: 'r-https', listener: 'front', hosts: ['app.example.com'], to: '  ',
    })).toThrow(/대상/);
  });

  it('모르는 redirect 상태는 패치를 만들지 않는다', () => {
    expect(() => putHttpRedirectPatch({
      key: 'r-https', listener: 'front', hosts: ['app.example.com'], to: 'https://x/',
      status: 418 as 302,
    })).toThrow(/status/);
  });

  it('HTTP reject 패치는 status 다 — to·pool 을 안 붙인다', () => {
    expect(putHttpRejectPatch({
      key: 'r-deny', listener: 'front', hosts: ['app.example.com'],
    })).toEqual([
      {
        op: 'put', kind: 'httpRoute', key: 'r-deny',
        body: {
          listener: 'front', hosts: ['app.example.com'], priority: 0,
          action: { kind: 'reject', status: 403 },
        },
      },
    ]);
  });

  it('HTTP reject 패치에 to·pool·websocket 을 안 붙인다', () => {
    const [op] = putHttpRejectPatch({
      key: 'r-deny', listener: 'front', hosts: ['app.example.com'],
    });
    expect(op?.body.action).not.toHaveProperty('to');
    expect(op?.body.action).not.toHaveProperty('pool');
    expect(op?.body.action).not.toHaveProperty('websocket');
  });

  it('모르는 reject 상태는 패치를 만들지 않는다', () => {
    expect(() => putHttpRejectPatch({
      key: 'r-deny', listener: 'front', hosts: ['app.example.com'],
      status: 500 as 403,
    })).toThrow(/status/);
  });

  it('패스스루 라우트 패치는 SNI → 풀 proxy 다 — websocket 이 없다', () => {
    expect(putPassthroughRoutePatch({
      key: 'pt-app', listener: 'edge', snis: ['app.example.com'], pool: 'origin',
    })).toEqual([
      {
        op: 'put', kind: 'passthroughRoute', key: 'pt-app',
        body: {
          listener: 'edge', snis: ['app.example.com'], priority: 0,
          action: { kind: 'proxy', pool: 'origin' },
        },
      },
    ]);
  });

  it('패스스루 라우트에 hosts·pathPrefix·websocket 을 안 붙인다', () => {
    const [op] = putPassthroughRoutePatch({
      key: 'pt-app', listener: 'edge', snis: ['app.example.com'], pool: 'origin',
    });
    expect(op?.body).not.toHaveProperty('hosts');
    expect(op?.body).not.toHaveProperty('pathPrefix');
    expect(op?.body.action).not.toHaveProperty('websocket');
  });

  it('SNI 가 없으면 패스스루 라우트 패치를 만들지 않는다', () => {
    expect(() => putPassthroughRoutePatch({
      key: 'pt-app', listener: 'edge', snis: ['  ', ''], pool: 'origin',
    })).toThrow(/SNI/);
  });

  it('패스스루 라우트를 빼는 패치는 delete 한 줄이다', () => {
    expect(deletePatch('passthroughRoute', 'pt-app')).toEqual([
      { op: 'delete', kind: 'passthroughRoute', key: 'pt-app' },
    ]);
  });
});
