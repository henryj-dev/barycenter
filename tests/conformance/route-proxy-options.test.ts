/**
 * **프록시 라우트의 요청 헤더와 경로 접두사 바꾸기** (2026-10-29, #109)
 *
 * nginx 의 `location /api/ { proxy_pass https://api.example.com/; }` 를 옮기려면 둘이 필요하다:
 *   · 이 라우트에만 거는 요청 헤더(`Host: api.example.com`)
 *   · 맞은 접두사를 바꿔 보내는 것(`/api/` → `/`)
 *
 * 여기서 재는 것: 모양 · 끝 '/' 일치 · 렌더(proxy_pass URI, 같은 이름의 리스너 헤더 빼기) ·
 * 안 적으면 렌더 바이트 그대로. 실제 엔진 동작은 `tests/golden/route-proxy-options.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { render } from '../../src/conf/render.js';
import { decodeModel } from '../../src/model/decode.js';
import { validateModel } from '../../src/validate/model.js';
import type { HttpRoute, Model } from '../../src/model/provisional.js';

const model = (routes: unknown[], listenerHeaders?: { name: string; value: string }[]): unknown => ({
  listeners: [{
    key: 'web', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true,
    http: {
      defaultAction: 'reject',
      ...(listenerHeaders === undefined ? {} : { headers: { request: listenerHeaders } }),
    },
  }],
  httpRoutes: routes,
  passthroughRoutes: [],
  pools: [{ key: 'ext', protocolClass: 'http', algorithm: 'round_robin' }],
  backends: [{ key: 'b', pool: 'ext', host: '10.0.0.1', port: 443, weight: 1 }],
  certificates: [], tlsPolicies: [], sniBindings: [],
});

const route = (action: Record<string, unknown>, extra: { [K in keyof HttpRoute]?: HttpRoute[K] | undefined } = {}): unknown => ({
  key: 'api', listener: 'web', hosts: ['a.test'], priority: 0, pathPrefix: '/api/',
  action: { kind: 'proxy', pool: 'ext', websocket: false, ...action }, ...extra,
});

function issues(m: unknown): string[] {
  const r = decodeModel(m);
  return r.ok ? [] : r.issues.map((i) => `${i.code} ${i.subjects.join(',')}`);
}

function conf(m: unknown): string {
  const r = decodeModel(m);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  expect(validateModel(r.model)).toEqual([]);
  return render(r.model as Model).conf;
}

/** `location /api/ { … }` 블록 하나. */
function location(c: string, prefix: string): string {
  const at = c.indexOf(`location ${prefix} {`);
  expect(at, `location ${prefix} 가 없다`).toBeGreaterThan(-1);
  return c.slice(at, c.indexOf('\n        }', at));
}

describe('해독', () => {
  it('둘 다 받는다', () => {
    expect(issues(model([route({
      requestHeaders: [{ name: 'Host', value: 'api.example.com' }], rewritePrefix: '/v1/',
    })]))).toEqual([]);
  });

  it('예약 헤더는 리스너와 같이 막는다 (X-Forwarded-For 등)', () => {
    expect(issues(model([route({ requestHeaders: [{ name: 'X-Forwarded-For', value: '1.2.3.4' }] })])))
      .toEqual([expect.stringMatching(/^invalid_value/)]);
  });

  it('같은 이름을 두 번 적으면 막는다', () => {
    expect(issues(model([route({ requestHeaders: [{ name: 'X-A', value: '1' }, { name: 'x-a', value: '2' }] })])))
      .not.toEqual([]);
  });

  it.each(['v1/', '/v1/$host/', '/v 1/', '/v1/;'])(
    'rewritePrefix %s 는 막는다 — `$` 는 nginx 가 변수로 푼다', (p) => {
      expect(issues(model([route({ rewritePrefix: p })]))).not.toEqual([]);
    });

  it.each([
    ['/api/', '/v1'], ['/api', '/v1/'],
  ])('끝 / 가 다르면 막는다 — 접두사 %s · 바꾸기 %s', (prefix, rw) => {
    expect(issues(model([route({ rewritePrefix: rw }, { pathPrefix: prefix })])))
      .toEqual([expect.stringMatching(/^invalid_value/)]);
  });

  it('접두사가 없으면 / 로 본다 — 바꾸기도 / 로 끝나야 한다', () => {
    expect(issues(model([route({ rewritePrefix: '/v1/' }, { pathPrefix: undefined })]))).toEqual([]);
    expect(issues(model([route({ rewritePrefix: '/v1' }, { pathPrefix: undefined })]))).not.toEqual([]);
  });

  it('redirect·reject 에는 없다', () => {
    expect(issues(model([{
      key: 'r', listener: 'web', hosts: ['a.test'], priority: 0,
      action: { kind: 'redirect', to: 'https://x.test/', status: 302, rewritePrefix: '/v1/' },
    }]))).not.toEqual([]);
  });

  it('빈 헤더 목록은 키를 안 만든다', () => {
    const r = decodeModel(model([route({ requestHeaders: [] })]));
    expect(r.ok).toBe(true);
    if (r.ok) expect('requestHeaders' in (r.model.httpRoutes[0]!.action)).toBe(false);
  });
});

describe('렌더', () => {
  it('rewritePrefix 는 proxy_pass 의 URI 다', () => {
    expect(location(conf(model([route({ rewritePrefix: '/v1/' })])), '/api/'))
      .toMatch(/proxy_pass http:\/\/[^;]+\/v1\/;/);
  });

  it('없으면 URI 를 안 붙인다 — 옛 동작', () => {
    expect(location(conf(model([route({})])), '/api/')).toMatch(/proxy_pass http:\/\/[a-z0-9_]+;/);
  });

  it('라우트 헤더가 기본 Host 셋 뒤에 나간다', () => {
    const loc = location(conf(model([route({ requestHeaders: [{ name: 'Host', value: 'api.example.com' }] })])), '/api/');
    expect(loc.indexOf('proxy_set_header Host $host;')).toBeLessThan(loc.indexOf('proxy_set_header Host api.example.com;'));
  });

  it('**같은 이름의 리스너 헤더를 뺀다** — nginx 는 둘 다 보낸다(실측)', () => {
    const c = conf(model(
      [route({ requestHeaders: [{ name: 'x-tenant', value: 'route' }] })],
      [{ name: 'X-Tenant', value: 'listener' }, { name: 'X-Keep', value: 'yes' }],
    ));
    const loc = location(c, '/api/');
    expect(loc).toContain('proxy_set_header x-tenant route;');
    expect(loc).not.toContain('X-Tenant listener');
    expect(loc).toContain('proxy_set_header X-Keep yes;');
  });

  it('다른 라우트에는 영향이 없다 — 리스너 헤더 그대로', () => {
    const c = conf(model([
      route({ requestHeaders: [{ name: 'X-Tenant', value: 'route' }] }),
      route({}, { key: 'other', pathPrefix: '/other/' }),
    ], [{ name: 'X-Tenant', value: 'listener' }]));
    expect(location(c, '/other/')).toContain('proxy_set_header X-Tenant listener;');
  });

  it('안 적으면 렌더 바이트가 그대로다', () => {
    const before = conf(model([route({})], [{ name: 'X-A', value: '1' }]));
    expect(before).not.toMatch(/\/v1\//);
    const decoded = decodeModel(model([route({})], [{ name: 'X-A', value: '1' }]));
    expect(decoded.ok).toBe(true);
  });
});
