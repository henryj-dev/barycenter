/**
 * **라우트 하나에 경로 여럿** (2026-11-02, `pathPrefixes`).
 *
 * 같은 동작 · 헤더로 `/api/` · `/v2/` · `/graphql` 을 함께 덮는다. 전에는 경로마다 라우트를 따로 적어야 했다.
 * 재는 것: 해독기 규칙 · 검증기의 겹침 판정 · 렌더(경로마다 location) · patch 빌더 · 라우트 화면의 행.
 */
import { describe, expect, it } from 'vitest';

import { decodeModel } from '../../src/model/decode.js';
import { render } from '../../src/conf/render.js';
import { validateModel } from '../../src/validate/model.js';
import { routePaths } from '../../src/model/route-paths.js';
import { pathFieldsOf, parsePathList, putHttpRoutePatch } from '../../src/web/edit.js';
import { viewOfRoutes } from '../../src/web/routes-view.js';
import { routeCreatePatch } from '../../src/cli/route.js';
import type { HttpRoute, Model } from '../../src/model/provisional.js';

const caps = { streamRealip: false, httpLua: false, streamLua: false };

const modelWith = (routes: unknown[]): unknown => ({
  listeners: [{ key: 'web', protocol: 'http', bind: '127.0.0.1', port: 18080, enabled: true, http: { defaultAction: 'reject' } }],
  httpRoutes: routes,
  passthroughRoutes: [],
  pools: [{ key: 'api', protocolClass: 'http', algorithm: 'round_robin' }],
  backends: [{ key: 'a1', pool: 'api', host: '10.0.0.1', port: 80, weight: 1 }],
  certificates: [], tlsPolicies: [], sniBindings: [],
});
const route = (extra: Record<string, unknown>): Record<string, unknown> => ({
  key: 'r', listener: 'web', hosts: ['app.test'], priority: 0,
  action: { kind: 'proxy', pool: 'api', websocket: false }, ...extra,
});
const decoded = (routes: unknown[]): ReturnType<typeof decodeModel> => decodeModel(modelWith(routes));

describe('routePaths', () => {
  it('경로가 없으면 / 하나, 하나면 그것, 여럿이면 그 순서대로다', () => {
    expect(routePaths({})).toEqual(['/']);
    expect(routePaths({ pathPrefix: '/api/' })).toEqual(['/api/']);
    expect(routePaths({ pathPrefixes: ['/v2/', '/api/'] })).toEqual(['/v2/', '/api/']);
  });
});

describe('해독기', () => {
  it('**경로 여럿을 받는다**', () => {
    const d = decoded([route({ pathPrefixes: ['/api/', '/v2/'] })]);
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.model.httpRoutes[0]?.pathPrefixes).toEqual(['/api/', '/v2/']);
  });

  it('pathPrefix 와 함께 적으면 거절한다 — 어느 쪽이 맞는지 고를 근거가 없다', () => {
    const d = decoded([route({ pathPrefix: '/a/', pathPrefixes: ['/b/'] })]);
    expect(d.ok).toBe(false);
  });

  it('빈 목록 · 같은 경로 두 번은 거절한다', () => {
    expect(decoded([route({ pathPrefixes: [] })]).ok).toBe(false);
    expect(decoded([route({ pathPrefixes: ['/a/', '/a/'] })]).ok).toBe(false);
  });

  it('경로 바꾸기의 끝 / 는 경로마다 맞아야 한다', () => {
    const bad = route({ pathPrefixes: ['/api/', '/graphql'], action: { kind: 'proxy', pool: 'api', websocket: false, rewritePrefix: '/v1/' } });
    expect(decoded([bad]).ok).toBe(false);
    const good = route({ pathPrefixes: ['/api/', '/v2/'], action: { kind: 'proxy', pool: 'api', websocket: false, rewritePrefix: '/v1/' } });
    expect(decoded([good]).ok).toBe(true);
  });
});

describe('검증기', () => {
  it('**다른 라우트와 같은 (호스트, 경로) 를 덮으면 경로 하나라도 겹침이다**', () => {
    const d = decoded([
      route({ key: 'many', pathPrefixes: ['/api/', '/v2/'] }),
      route({ key: 'one', pathPrefix: '/v2/' }),
    ]);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    const issues = validateModel(d.model, caps);
    expect(issues.length).toBeGreaterThan(0);
    expect(JSON.stringify(issues)).toMatch(/many/);
  });

  it('ACME 예약 경로는 경로 여럿 안에서도 막는다', () => {
    const d = decoded([route({ pathPrefixes: ['/api/', '/.well-known/acme-challenge/x'] })]);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(validateModel(d.model, caps).map((i) => i.code)).toContain('acme_path_reserved');
  });
});

describe('렌더', () => {
  it('**경로마다 같은 본문의 location 을 낸다** — 경로 바꾸기도 location 마다 맞는다', () => {
    const d = decoded([route({ pathPrefixes: ['/api/', '/v2/'], action: { kind: 'proxy', pool: 'api', websocket: false, rewritePrefix: '/v1/' } })]);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    const conf = render(d.model as Model, caps).conf;
    expect(conf).toMatch(/location \/api\/ \{[^}]*proxy_pass http:\/\/[^;]+\/v1\/;/);
    expect(conf).toMatch(/location \/v2\/ \{[^}]*proxy_pass http:\/\/[^;]+\/v1\/;/);
  });

  it('경로 하나인 라우트의 산출물은 그대로다', () => {
    const one = decoded([route({ pathPrefix: '/api/' })]);
    const many = decoded([route({ pathPrefixes: ['/api/'] })]);
    expect(one.ok && many.ok).toBe(true);
    if (!one.ok || !many.ok) return;
    expect(render(many.model as Model, caps).conf).toBe(render(one.model as Model, caps).conf);
  });
});

describe('patch 빌더 · CLI', () => {
  it('하나면 pathPrefix, 여럿이면 pathPrefixes 로 싣는다 — 빈 칸과 중복은 지운다', () => {
    expect(pathFieldsOf({})).toEqual({});
    expect(pathFieldsOf({ pathPrefixes: [' /a/ ', ''] })).toEqual({ pathPrefix: '/a/' });
    expect(pathFieldsOf({ pathPrefixes: ['/a/', '/b/', '/a/'] })).toEqual({ pathPrefixes: ['/a/', '/b/'] });
    expect(parsePathList('/a/, /b/\n/c')).toEqual(['/a/', '/b/', '/c']);
  });

  it('경로 바꾸기의 끝 / 를 경로마다 미리 본다', () => {
    expect(() => putHttpRoutePatch({ key: 'r', listener: 'web', hosts: ['a.test'], pool: 'api', pathPrefixes: ['/a/', '/b'], rewritePrefix: '/v1/' }))
      .toThrow(/\/b/);
    const [op] = putHttpRoutePatch({ key: 'r', listener: 'web', hosts: ['a.test'], pool: 'api', pathPrefixes: ['/a/', '/b/'], rewritePrefix: '/v1/' });
    expect(op?.body.pathPrefixes).toEqual(['/a/', '/b/']);
    expect(op?.body.pathPrefix).toBeUndefined();
  });

  it('CLI 는 --path-prefix 를 여러 번 받는다', () => {
    const p = routeCreatePatch({ name: 'r', listener: 'web', hosts: 'a.test', pool: 'api', pathPrefixes: ['/a/', '/b/'] });
    expect((p?.[0]?.body as { pathPrefixes?: string[] }).pathPrefixes).toEqual(['/a/', '/b/']);
  });
});

describe('라우트 화면', () => {
  it('**행은 경로마다 하나이고, 키는 라우트 키 그대로다** — 상세를 그 키로 연다', () => {
    const r: HttpRoute = { key: 'many', listener: 'web', hosts: ['a.test'], priority: 0, pathPrefixes: ['/api/', '/v2/'], action: { kind: 'reject', status: 404 } };
    const v = viewOfRoutes([r], []);
    expect(v.order.map((o) => [o.key, o.pathPrefix])).toEqual([['many', '/api/'], ['many', '/v2/']]);
    expect(v.errors).toEqual([]);
  });
});
