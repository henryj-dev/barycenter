/**
 * **경로별 묶음 → 라우트들** (2026-11-02, `routeGroupPatch`). 사람이 한 호스트의 규칙을 줄로 적으면 같은 뜻의 라우트 여럿으로 편다.
 */
import { describe, expect, it } from 'vitest';

import { fallbackOfListener, routeGroupPatch } from '../../src/web/route-group.js';
import { decodeModel } from '../../src/model/decode.js';
import { render } from '../../src/conf/render.js';
import { validateModel } from '../../src/validate/model.js';

const CF = ['@cloudflare-ips-v4', '@cloudflare-ips-v6'];
const pool = { kind: 'proxy' as const, pool: 'counter', websocket: false };

describe('routeGroupPatch', () => {
  it('**counter 의 예 — 경로 묶음마다 라우트 하나, 출발지 줄은 규칙, 그 밖은 리스너 기본 동작**', () => {
    const ops = routeGroupPatch({
      key: 'counter.tinyuniver.se', listener: 'counter.tinyuniver.se', hosts: ['counter.tinyuniver.se'],
      fallback: fallbackOfListener({ pool: 'counter' })!,
      lines: [
        { paths: ['/'], from: CF, action: { kind: 'reject', status: 444 } },
        { paths: ['/count.js', '/count'], from: CF, action: pool },
      ],
    });
    expect(ops.map((o) => [o.key, o.body.pathPrefix ?? o.body.pathPrefixes, o.body.action.kind, o.body.sourceRules?.map((r) => r.action.kind)])).toEqual([
      ['counter.tinyuniver.se', '/', 'proxy', ['reject']],
      ['counter.tinyuniver.se-p2', ['/count.js', '/count'], 'proxy', ['proxy']],
    ]);
  });

  it('출발지 없는 줄은 그 경로의 기본 동작이다 · 같은 경로 목록은 순서가 달라도 한 묶음이다', () => {
    const ops = routeGroupPatch({
      key: 'app', listener: 'web', hosts: ['a.test'],
      lines: [
        { paths: ['/b/', '/a/'], from: ['10.0.0.0/8'], action: pool },
        { paths: ['/a/', '/b/'], from: [], action: { kind: 'reject', status: 403 } },
      ],
    });
    expect(ops).toHaveLength(1);
    expect(ops[0]?.body.action).toEqual({ kind: 'reject', status: 403 });
    expect(ops[0]?.body.sourceRules?.[0]?.from).toEqual(['10.0.0.0/8']);
  });

  it('**한 경로가 다른 묶음에 나뉘면 · 기본 동작이 둘이면 · 정할 수 없으면 거절한다**', () => {
    const base = { key: 'app', listener: 'web', hosts: ['a.test'] };
    expect(() => routeGroupPatch({ ...base, fallback: pool, lines: [
      { paths: ['/a/', '/b/'], from: [], action: pool },
      { paths: ['/a/'], from: ['10.0.0.0/8'], action: pool },
    ] })).toThrow(/\/a\/ 가 서로 다른 묶음/);
    expect(() => routeGroupPatch({ ...base, lines: [
      { paths: ['/a/'], from: [], action: pool },
      { paths: ['/a/'], from: [], action: { kind: 'reject', status: 403 } },
    ] })).toThrow(/둘이다/);
    expect(() => routeGroupPatch({ ...base, lines: [{ paths: ['/a/'], from: ['10.0.0.0/8'], action: pool }] }))
      .toThrow(/기본 동작을 정할 수 없다/);
  });

  it('리스너 기본 동작 — 풀은 풀로, reject 는 444 로 따른다', () => {
    expect(fallbackOfListener({ pool: 'p' })).toEqual({ kind: 'proxy', pool: 'p', websocket: false });
    expect(fallbackOfListener('reject')).toEqual({ kind: 'reject', status: 444 });
    expect(fallbackOfListener(undefined)).toBeUndefined();
  });

  it('**펼친 라우트가 해독 · 검증 · 렌더를 지난다**', () => {
    const ops = routeGroupPatch({
      key: 'c', listener: 'web', hosts: ['c.test'], fallback: pool,
      lines: [
        { paths: ['/'], from: ['@cf'], address: 'connection', action: { kind: 'reject', status: 444 } },
        { paths: ['/count.js', '/count'], from: [], action: pool },
      ],
    });
    const d = decodeModel({
      listeners: [{ key: 'web', protocol: 'http', bind: '127.0.0.1', port: 18080, enabled: true, http: { defaultAction: { pool: 'counter' } } }],
      httpRoutes: ops.map((o) => ({ key: o.key, ...o.body })),
      passthroughRoutes: [], pools: [{ key: 'counter', protocolClass: 'http', algorithm: 'round_robin' }],
      backends: [{ key: 'b', pool: 'counter', host: '10.0.0.1', port: 80, weight: 1 }],
      certificates: [], tlsPolicies: [], sniBindings: [], addressSets: [{ key: 'cf', cidrs: ['173.245.48.0/20'] }],
    });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    const caps = { streamRealip: false, httpLua: false, streamLua: false };
    expect(validateModel(d.model, caps)).toEqual([]);
    const conf = render(d.model, caps).conf;
    expect(conf).toMatch(/geo \$realip_remote_addr \$bary_rsrc_c_1 \{/);
  });
});

describe('보는 주소 (address)', () => {
  const model = (rules: unknown[]): unknown => ({
    listeners: [{ key: 'web', protocol: 'http', bind: '127.0.0.1', port: 18080, enabled: true, http: { defaultAction: 'reject' } }],
    httpRoutes: [{ key: 'r', listener: 'web', hosts: ['a.test'], priority: 0, action: { kind: 'reject', status: 403 }, sourceRules: rules }],
    passthroughRoutes: [], pools: [], backends: [], certificates: [], tlsPolicies: [], sniBindings: [],
  });

  it('visitor · connection 밖은 거절한다', () => {
    expect(decodeModel(model([{ from: ['10.0.0.0/8'], address: 'peer', action: { kind: 'reject', status: 403 } }])).ok).toBe(false);
  });

  it('**방문자 주소와 연결 주소는 서로 가리지 않는다** — 다른 주소다', () => {
    const d = decodeModel(model([
      { from: ['10.0.0.0/8'], address: 'connection', action: { kind: 'reject', status: 444 } },
      { from: ['10.1.0.0/16'], action: { kind: 'reject', status: 404 } },
    ]));
    expect(d.ok).toBe(true);
    if (d.ok) expect(validateModel(d.model, { streamRealip: false })).toEqual([]);
  });
});
