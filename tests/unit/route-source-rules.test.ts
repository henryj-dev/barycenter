/**
 * **라우트 출발지 규칙** (2026-11-02, `sourceRules`) — 해독기 · 검증기 · 렌더 · 주소 집합 · 화면 · patch 빌더.
 * 실물 nginx 로 재는 것은 `tests/golden/route-source-rules.test.ts` 다.
 */
import { describe, expect, it } from 'vitest';

import { decodeModel } from '../../src/model/decode.js';
import { render } from '../../src/conf/render.js';
import { validateModel } from '../../src/validate/model.js';
import { expandAddressSets } from '../../src/model/address-sets.js';
import { routeActions } from '../../src/model/route-rules.js';
import { relationsOf, trafficOf } from '../../src/web/resources.js';
import { putHttpRejectPatch, sourceRulesOf } from '../../src/web/edit.js';
import type { Model } from '../../src/model/provisional.js';

const caps = { streamRealip: false, httpLua: false, streamLua: false };

const base = (routes: unknown[], extra: Record<string, unknown> = {}): unknown => ({
  listeners: [{ key: 'web', protocol: 'http', bind: '127.0.0.1', port: 18080, enabled: true, http: { defaultAction: 'reject' } }],
  httpRoutes: routes,
  passthroughRoutes: [],
  pools: [
    { key: 'pub', protocolClass: 'http', algorithm: 'round_robin' },
    { key: 'internal', protocolClass: 'http', algorithm: 'round_robin' },
  ],
  backends: [
    { key: 'p1', pool: 'pub', host: '10.0.0.1', port: 80, weight: 1 },
    { key: 'i1', pool: 'internal', host: '10.0.0.2', port: 80, weight: 1 },
  ],
  certificates: [], tlsPolicies: [], sniBindings: [],
  ...extra,
});
const route = (sourceRules: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  key: 'app', listener: 'web', hosts: ['app.test'], priority: 0,
  action: { kind: 'proxy', pool: 'pub', websocket: false }, sourceRules, ...extra,
});
const toInternal = { kind: 'proxy', pool: 'internal', websocket: false };
const ok = (m: unknown): Model => {
  const d = decodeModel(m);
  if (!d.ok) throw new Error(JSON.stringify(d.issues));
  return d.model;
};

describe('해독기', () => {
  it('**규칙을 받는다** — 순서 그대로', () => {
    const m = ok(base([route([{ from: ['10.0.0.0/8', '@office'], action: toInternal }, { from: ['203.0.113.7'], action: { kind: 'reject', status: 403 } }])]));
    expect(m.httpRoutes[0]?.sourceRules?.map((r) => r.from)).toEqual([['10.0.0.0/8', '@office'], ['203.0.113.7']]);
  });

  it('빈 목록 · 빈 from · 대역이 아닌 값 · 21 개는 거절한다', () => {
    expect(decodeModel(base([route([])])).ok).toBe(false);
    expect(decodeModel(base([route([{ from: [], action: toInternal }])])).ok).toBe(false);
    expect(decodeModel(base([route([{ from: ['office'], action: toInternal }])])).ok).toBe(false);
    const many = Array.from({ length: 21 }, (_, i) => ({ from: [`10.${i}.0.0/16`], action: toInternal }));
    expect(decodeModel(base([route(many)])).ok).toBe(false);
  });

  it('규칙의 경로 바꾸기도 끝 / 가 경로마다 맞아야 한다', () => {
    const rw = { kind: 'proxy', pool: 'internal', websocket: false, rewritePrefix: '/v1/' };
    expect(decodeModel(base([route([{ from: ['10.0.0.0/8'], action: rw }], { pathPrefix: '/api' })])).ok).toBe(false);
    expect(decodeModel(base([route([{ from: ['10.0.0.0/8'], action: rw }], { pathPrefix: '/api/' })])).ok).toBe(true);
  });
});

describe('검증기', () => {
  it('**뒤 규칙의 대역이 앞 규칙의 대역 안에 들면 막는다** — 결코 맞지 않는다', () => {
    const m = ok(base([route([
      { from: ['10.0.0.0/8'], action: toInternal },
      { from: ['10.1.0.0/16'], action: { kind: 'reject', status: 403 } },
    ])]));
    expect(validateModel(m, caps).map((i) => i.code)).toContain('source_rule_shadowed');
  });

  it('앞 규칙이 좁고 뒤 규칙이 넓은 것은 받는다 — 좁은 것이 먼저 걸린다', () => {
    const m = ok(base([route([
      { from: ['10.1.0.0/16'], action: { kind: 'reject', status: 403 } },
      { from: ['10.0.0.0/8'], action: toInternal },
    ])]));
    expect(validateModel(m, caps)).toEqual([]);
  });

  it('주소 집합을 펼친 뒤에 본다', () => {
    const m = ok(base([route([
      { from: ['@office'], action: toInternal },
      { from: ['192.0.2.10'], action: { kind: 'reject', status: 403 } },
    ])], { addressSets: [{ key: 'office', cidrs: ['192.0.2.0/24'] }] }));
    expect(validateModel(m, caps).map((i) => i.code)).toContain('source_rule_shadowed');
  });

  it('없는 주소 집합 · 없는 풀을 막는다', () => {
    const noSet = ok(base([route([{ from: ['@nope'], action: toInternal }])]));
    expect(validateModel(noSet, caps).map((i) => i.code)).toContain('unknown_address_set');
    const noPool = ok(base([route([{ from: ['10.0.0.0/8'], action: { kind: 'proxy', pool: 'ghost', websocket: false } }])]));
    expect(validateModel(noPool, caps).length).toBeGreaterThan(0);
  });
});

describe('렌더', () => {
  const m = ok(base([route([
    { from: ['10.0.0.0/8'], action: toInternal },
    { from: ['203.0.113.0/24'], action: { kind: 'redirect', to: 'https://elsewhere/', status: 302 } },
    { from: ['198.51.100.7'], action: { kind: 'reject', status: 403 } },
  ], { pathPrefix: '/api/' })]));
  const conf = render(m, caps).conf;

  it('**규칙마다 geo 변수 하나** — 방문자 주소($remote_addr)를 본다', () => {
    expect(conf).toMatch(/geo \$bary_rsrc_app_1 \{\s*default 0;\s*10\.0\.0\.0\/8 1;\s*\}/);
    expect(conf).toMatch(/geo \$bary_rsrc_app_3 \{/);
    expect(conf).not.toMatch(/geo \$realip_remote_addr \$bary_rsrc/);
  });

  it('위 규칙부터 if 로 본다 — 프록시는 named location, 거절 · redirect 는 return', () => {
    const loc = conf.slice(conf.indexOf('location /api/ {'));
    const first = loc.indexOf('$bary_rsrc_app_1');
    const second = loc.indexOf('$bary_rsrc_app_2');
    const third = loc.indexOf('$bary_rsrc_app_3');
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
    expect(conf).toMatch(/error_page 570 = @bary_rule_app_0_1;/);
    expect(conf).toMatch(/location @bary_rule_app_0_1 \{[^}]*proxy_pass http:\/\/[^;/]+;/);
    expect(conf).toMatch(/if \(\$bary_rsrc_app_2\) \{\s*return 302 "?https:\/\/elsewhere\/"?;/);
    expect(conf).toMatch(/if \(\$bary_rsrc_app_3\) \{\s*return 403;/);
  });

  it('**규칙의 풀도 upstream 이 선다** — 기본 동작이 안 쓰는 풀이어도', () => {
    expect(conf).toMatch(/upstream [^ ]*internal[^ ]* \{/);
  });

  it('규칙 없는 라우트의 산출물은 그대로다', () => {
    const plain = ok(base([{ key: 'app', listener: 'web', hosts: ['app.test'], priority: 0, pathPrefix: '/api/', action: { kind: 'proxy', pool: 'pub', websocket: false } }]));
    expect(render(plain, caps).conf).not.toMatch(/bary_rsrc_|error_page/);
  });

  it('프록시 규칙의 경로 바꾸기는 rewrite … break 다 — named location 의 proxy_pass 에는 URI 를 못 붙인다', () => {
    const rw = ok(base([route([{ from: ['10.0.0.0/8'], action: { kind: 'proxy', pool: 'internal', websocket: false, rewritePrefix: '/v1/' } }], { pathPrefix: '/api.x/' })]));
    expect(render(rw, caps).conf).toMatch(/rewrite \^\/api\\\.x\/\(\.\*\)\$ \/v1\/\$1 break;/);
  });
});

describe('주소 집합 · 화면 · 빌더', () => {
  it('**규칙의 @집합을 펼친다**', () => {
    const m = ok(base([route([{ from: ['@office', '10.9.0.0/16'], action: toInternal }])], { addressSets: [{ key: 'office', cidrs: ['192.0.2.0/24'] }] }));
    expect(expandAddressSets(m).httpRoutes[0]?.sourceRules?.[0]?.from).toEqual(['192.0.2.0/24', '10.9.0.0/16']);
  });

  it('routeActions 는 기본 동작과 규칙 동작을 다 낸다', () => {
    const m = ok(base([route([{ from: ['10.0.0.0/8'], action: toInternal }])]));
    expect(routeActions(m.httpRoutes[0]!).map((a) => (a.kind === 'proxy' ? a.pool : a.kind))).toEqual(['pub', 'internal']);
  });

  it('**그래프와 흐름에 규칙이 보인다** — 규칙이 위, 그 밖의 출발지가 아래', () => {
    const m = ok(base([route([{ from: ['10.0.0.0/8'], action: toInternal }])])) as unknown as Parameters<typeof trafficOf>[0];
    const rel = relationsOf(m, { kind: 'httpRoute', key: 'app' }).uses.map((x) => `${x.to.kind}:${x.to.key}:${x.via}`);
    expect(rel).toContain('pool:internal:출발지 규칙');
    const lines = trafficOf(m, { kind: 'httpRoute', key: 'app' }, () => 'healthy');
    expect(lines.map((l) => l.match)).toEqual(['app.test · 출발지 10.0.0.0/8', 'app.test · 그 밖의 출발지']);
  });

  it('빌더는 대역이 빈 규칙을 버리고, 남는 것이 없으면 싣지 않는다', () => {
    expect(sourceRulesOf([{ from: [' ', ''], action: { kind: 'reject', status: 403 } }])).toBeUndefined();
    const [op] = putHttpRejectPatch({ key: 'r', listener: 'web', hosts: ['a.test'],
      sourceRules: [{ from: ['10.0.0.0/8 '], action: { kind: 'proxy', pool: 'internal', websocket: false } }] });
    expect(op?.body.sourceRules?.[0]?.from).toEqual(['10.0.0.0/8']);
    expect(() => sourceRulesOf([{ from: ['10.0.0.0/8'], action: { kind: 'proxy', pool: '', websocket: false } }])).toThrow(/풀/);
  });
});
