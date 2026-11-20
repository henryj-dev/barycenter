/**
 * 트래픽 통계 (2026-11-20) — 엔진의 Lua 카운터 → 데몬의 시계열.
 *
 * 렌더는 Lua 가 있을 때만 이름 변수와 카운터를 낸다. 없으면 바이트가 그대로여야 한다 —
 * 그래야 순수 nginx 배포가 다음 apply 에서 세대 전환을 안 한다.
 */
import { describe, expect, it } from 'vitest';

import { getPath } from '../../src/cli/get.js';
import { render, upstreamName } from '../../src/conf/render.js';
import { parseTrafficDump, trafficDumpLua, trafficLogLua, TRAFFIC_DICT } from '../../src/conf/traffic.js';
import { canonicalPeer, TrafficSampler } from '../../src/control/traffic.js';
import { RELAY_PATHS } from '../../src/global/relay.js';
import type { Model } from '../../src/model/provisional.js';

const LUA = { httpLua: true, streamLua: true, streamRealip: false, sslConfCommand: true };

const model = (): Model => ({
  listeners: [
    { key: 'web:front', protocol: 'http', bind: '0.0.0.0', port: 8080, enabled: true, http: { defaultAction: { pool: 'app' } } },
    { key: 'tcp', protocol: 'tcp', bind: '0.0.0.0', port: 9000, enabled: true, defaultPool: 'raw' },
    { key: 'pt', protocol: 'tls_passthrough', bind: '0.0.0.0', port: 9443, enabled: true },
  ],
  httpRoutes: [{
    key: 'api', listener: 'web:front', hosts: ['a.test'], priority: 10, pathPrefix: '/api/',
    action: { kind: 'proxy', pool: 'app', websocket: false },
  }, {
    key: 'gone', listener: 'web:front', hosts: ['a.test'], priority: 5, pathPrefix: '/old/',
    action: { kind: 'redirect', to: 'https://b.test/', status: 301 },
  }],
  passthroughRoutes: [{ key: 'pt:one', listener: 'pt', snis: ['s.test'], priority: 1, action: { kind: 'proxy', pool: 'raw' } }],
  pools: [
    { key: 'app', protocolClass: 'http', algorithm: 'round_robin' },
    { key: 'raw', protocolClass: 'tcp', algorithm: 'round_robin' },
  ],
  backends: [
    { key: 'app-1', pool: 'app', host: '10.0.0.1', port: 80, weight: 1 },
    { key: 'app-6', pool: 'app', host: 'fd00::6', port: 80, weight: 1 },
    { key: 'raw-1', pool: 'raw', host: '10.0.0.1', port: 80, weight: 1 },
  ],
  certificates: [], tlsPolicies: [], sniBindings: [],
});

describe('렌더 — 이름 변수와 카운터 dict', () => {
  it('Lua 가 없으면 아무것도 안 낸다 — 렌더 바이트가 그대로다', () => {
    const conf = render(model()).conf;
    expect(conf).not.toContain('bary_l');
    expect(conf).not.toContain('bary_r');
    expect(conf).not.toContain('_traffic');
  });

  it('Lua 가 있으면 http 와 stream 에 따로 dict 를 둔다', () => {
    const conf = render(model(), LUA).conf;
    expect(conf).toContain(`lua_shared_dict ${TRAFFIC_DICT.http} 2m;`);
    expect(conf).toContain(`lua_shared_dict ${TRAFFIC_DICT.stream} 2m;`);
  });

  it('server 는 리스너 이름을, location 은 라우트 이름을 적는다', () => {
    const conf = render(model(), LUA).conf;
    expect(conf).toContain('set $bary_l web:front;');
    expect(conf).toContain('set $bary_r api;');
    // 리다이렉트도 센다 — `set` 이 `return` 앞에 있어야 돈다.
    expect(conf).toMatch(/set \$bary_r gone;\s*return 301/);
  });

  it('stream server 도 리스너 이름을 적고, 패스스루는 SNI 로 라우트를 고른다', () => {
    const conf = render(model(), LUA).conf;
    expect(conf).toContain('set $bary_l tcp;');
    expect(conf).toContain('set $bary_l pt;');
    expect(conf).toMatch(/map \$ssl_preread_server_name \$bary_ptr_\w+ \{[^}]*s\.test pt:one;[^}]*default "";/);
    expect(conf).toMatch(/set \$bary_rv bary_ptr_\w+;/);
  });

  it('밸런서가 풀(upstream 이름)을 ctx 에 남긴다', () => {
    const conf = render(model(), LUA).conf;
    expect(conf).toContain(`ngx.ctx.bary_up = "${upstreamName('app')}"`);
  });

  it('카운터는 inflight 내리기 **앞**에 선다 — 그쪽은 peer 가 없으면 return 한다', () => {
    const conf = render(model(), LUA).conf;
    const http = conf.slice(conf.indexOf('http {'));
    const log = http.slice(http.indexOf('log_by_lua_block'));
    expect(log.indexOf('트래픽 카운터')).toBeLessThan(log.indexOf('local chosen = ngx.ctx.bary_peers'));
  });

  it('Lua 조각의 중괄호가 맞는다', () => {
    for (const p of ['http', 'stream'] as const) {
      for (const body of [trafficLogLua(p), trafficDumpLua(p)]) {
        expect([...body].filter((c) => c === '{').length).toBe([...body].filter((c) => c === '}').length);
      }
    }
  });
});

describe('덤프 읽기', () => {
  it('키를 종류 · 이름 · 칸으로 가른다. 백엔드는 upstream 과 peer 를 갖는다', () => {
    const got = parseTrafficDump([
      'l|web:front|n=5', 'l|web:front|s2=4', 'l|web:front|s4=1',
      'r|api|bi=120', 'p|pool_app|ms=12.5',
      'b|pool_app|[fd00::6]:80|n=2',
      'junk', 'x|y|n=1', 'l|web|zz=1', 'l|web|n=-1', 'l||n=1',
    ].join('\n'));
    expect(got).toContainEqual({ kind: 'listener', id: 'web:front', values: { n: 5, s2: 4, s4: 1 } });
    expect(got).toContainEqual({ kind: 'route', id: 'api', values: { bi: 120 } });
    expect(got).toContainEqual({ kind: 'pool', id: 'pool_app', values: { ms: 12.5 } });
    expect(got).toContainEqual({ kind: 'backend', id: 'pool_app|[fd00::6]:80', upstream: 'pool_app', peer: '[fd00::6]:80', values: { n: 2 } });
    expect(got).toHaveLength(4);
  });

  it('peer 의 대괄호를 벗겨 같은 것으로 본다', () => {
    expect(canonicalPeer('[FD00::6]:80')).toBe('fd00::6:80');
    expect(canonicalPeer('fd00::6:80')).toBe('fd00::6:80');
    expect(canonicalPeer('10.0.0.1:80')).toBe('10.0.0.1:80');
  });
});

describe('표본기 — 율 · 재시작 · 이름 풀기', () => {
  const up = upstreamName('app');
  const raw = upstreamName('raw');
  const dumps: { http?: string; stream?: string }[] = [];
  let t = 0;
  const sampler = (): TrafficSampler => new TrafficSampler({
    read: async () => dumps.shift() ?? {},
    model: async () => model(),
    lua: () => ({ http: true, stream: true }),
    now: () => t,
    resolve: async (hp) => hp,
  });

  it('두 표본의 차이를 간격으로 나눈다', async () => {
    const s = sampler();
    dumps.push(
      { http: `l|web:front|n=10\nl|web:front|s2=10\nl|web:front|ms=100\nl|web:front~http|n=2` },
      { http: `l|web:front|n=30\nl|web:front|s2=25\nl|web:front|s5=5\nl|web:front|ms=500\nl|web:front|bo=2000\nl|web:front~http|n=4` },
    );
    t = 0; await s.tick();
    t = 10_000; await s.tick();
    const pts = s.series('listener', 'web:front');
    expect(pts).toHaveLength(1);
    // 평문 리다이렉트 소켓(`~http`)은 그 리스너에 더한다: (30+4) - (10+2) = 22 → 2.2/s.
    expect(pts[0]!.rps).toBe(2.2);
    expect(pts[0]!.status.s5).toBe(0.5);
    expect(pts[0]!.bytesOutPerS).toBe(200);
    expect(pts[0]!.avgMs).toBeCloseTo(400 / 22, 3);
    const row = s.summary('listener')[0]!;
    expect(row.window.requests).toBe(22);
    expect(row.window.errors5xx).toBe(5);
  });

  it('값이 줄면 엔진이 다시 뜬 것이다 — 지금 값을 그 사이 증가로 본다', async () => {
    const s = sampler();
    dumps.push({ http: 'l|web:front|n=100' }, { http: 'l|web:front|n=7' });
    t = 0; await s.tick();
    t = 1000; await s.tick();
    expect(s.series('listener', 'web:front')[0]!.rps).toBe(7);
  });

  it('풀은 upstream 이름으로, 백엔드는 (풀, peer) 로 찾는다. 평면이 라우트 종류를 정한다', async () => {
    const s = sampler();
    dumps.push(
      { http: `p|${up}|n=1\nb|${up}|[fd00::6]:80|n=1\nb|${up}|10.0.0.1:80|n=1\nr|api|n=1`, stream: `b|${raw}|10.0.0.1:80|n=1\nr|pt:one|n=1` },
      { http: `p|${up}|n=3\nb|${up}|[fd00::6]:80|n=2\nb|${up}|10.0.0.1:80|n=3\nr|api|n=4`, stream: `b|${raw}|10.0.0.1:80|n=6\nr|pt:one|n=2` },
    );
    t = 0; await s.tick();
    t = 1000; await s.tick();
    expect(s.series('pool', 'app')[0]!.rps).toBe(2);
    expect(s.series('backend', 'app-6')[0]!.rps).toBe(1);
    // 같은 주소가 두 풀에 있다 — upstream 이 가른다.
    expect(s.series('backend', 'app-1')[0]!.rps).toBe(2);
    expect(s.series('backend', 'raw-1')[0]!.rps).toBe(5);
    expect(s.series('httpRoute', 'api')[0]!.rps).toBe(3);
    expect(s.series('passthroughRoute', 'pt:one')[0]!.rps).toBe(1);
  });

  it('upstream 을 잃은 백엔드(error_page 로 ctx 가 비었다)는 주소가 하나뿐일 때만 잡는다', async () => {
    const s = sampler();
    dumps.push({ http: 'b||[fd00::6]:80|n=1\nb||10.0.0.1:80|n=1' }, { http: 'b||[fd00::6]:80|n=3\nb||10.0.0.1:80|n=5' });
    t = 0; await s.tick();
    t = 1000; await s.tick();
    expect(s.series('backend', 'app-6')[0]!.rps).toBe(2);
    expect(s.summary('backend').map((r) => r.key)).toEqual(['app-6']);
  });

  it('Lua 가 없으면 unsupported, 못 읽으면 unavailable — 숫자를 짓지 않는다', async () => {
    const off = new TrafficSampler({ model: async () => model(), lua: () => ({ http: false, stream: false }) });
    expect(off.state().state).toBe('unsupported');
    const broken = new TrafficSampler({
      read: async () => ({}), model: async () => model(), lua: () => ({ http: true, stream: false }),
    });
    await broken.tick();
    expect(broken.state()).toEqual({ state: 'unavailable', reason: expect.stringContaining('admin') as string });
    expect(broken.summary()).toEqual([]);
  });

  it('창은 keep 개로 자른다', async () => {
    const s = new TrafficSampler({
      read: async () => ({ http: 'l|web:front|n=1' }), model: async () => model(),
      lua: () => ({ http: true, stream: true }), keep: 3, now: () => t,
    });
    for (let i = 0; i < 5; i += 1) { t = i * 1000; await s.tick(); }
    expect(s.window().samples).toBe(3);
    expect(s.series('listener', 'web:front')).toHaveLength(2);
  });
});

describe('창구 — CLI 와 전역 중계', () => {
  it('bary get traffic 의 세 모양', () => {
    expect(getPath('traffic')).toBe('/api/v1/traffic');
    expect(getPath('traffic/pool')).toBe('/api/v1/traffic?kind=pool');
    expect(getPath('traffic/backend/web-01:app:01')).toBe('/api/v1/traffic/backend/web-01%3Aapp%3A01');
  });

  it('전역이 지역의 트래픽을 읽는다', () => {
    expect(RELAY_PATHS).toContain('traffic');
    expect(RELAY_PATHS).toContain('traffic/:kind/:id');
  });
});

describe('API — /api/v1/traffic', () => {
  it('세지 않는 인스턴스는 unsupported, 세면 ok 와 시계열', async () => {
    const { TokenAuth, hashToken } = await import('../../src/api/auth.js');
    const { createApi } = await import('../../src/api/server.js');
    const auth = new TokenAuth([{ name: 'r', hash: hashToken('t'), scopes: ['read'] }]);
    const election = { state: { isLeader: true, token: '1', holder: 't', since: '' } };
    let tt = 0;
    const s = new TrafficSampler({
      read: async () => ({ http: `l|web:front|n=${tt / 100}` }), model: async () => model(),
      lua: () => ({ http: true, stream: false }), now: () => tt,
    });
    await s.tick(); tt = 1000; await s.tick();
    const base = { db: { query: async () => ({ rows: [] }) }, store: {}, control: {}, auth, election } as never;
    for (const [opts, want] of [[{}, 'unsupported'], [{ traffic: s }, 'ok']] as const) {
      const server = createApi({ ...(base as object), ...opts } as never);
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const h = { authorization: 'Bearer t' };
      const all = await (await fetch(`${url}/api/v1/traffic`, { headers: h })).json() as Record<string, unknown>;
      expect(all['state']).toBe(want);
      const one = await (await fetch(`${url}/api/v1/traffic/listener/web%3Afront`, { headers: h })).json() as Record<string, unknown>;
      expect(one['state']).toBe(want);
      if (want === 'ok') {
        expect(one['points']).toEqual([expect.objectContaining({ rps: 10 })]);
        expect((all['rows'] as unknown[]).length).toBe(1);
        const bad = await fetch(`${url}/api/v1/traffic?kind=nope`, { headers: h });
        expect(bad.status).toBe(400);
      } else {
        expect(all).not.toHaveProperty('rows');
      }
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('화면의 숫자 표기 (src/web/traffic-view.ts)', () => {
  it('축 위 끝은 1 · 2 · 2.5 · 5 × 10ⁿ 이고 눈금은 다섯이다', async () => {
    const { niceScale } = await import('../../src/web/traffic-view.js');
    expect(niceScale(0)).toEqual({ top: 1, ticks: [0, 0.25, 0.5, 0.75, 1] });
    expect(niceScale(7).top).toBe(10);
    expect(niceScale(180).top).toBe(200);
    expect(niceScale(0.03).top).toBeCloseTo(0.05, 10);
    expect(niceScale(220).ticks).toEqual([0, 62.5, 125, 187.5, 250]);
  });

  it('율 · 바이트 · 시간', async () => {
    const v = await import('../../src/web/traffic-view.js');
    expect(v.rateText(0)).toBe('0/s');
    expect(v.rateText(2.2)).toBe('2.2/s');
    expect(v.rateText(1234)).toBe('1,234/s');
    expect(v.bytesText(2048, true)).toBe('2 KB/s');
    expect(v.bytesText(1536)).toBe('1.5 KB');
    expect(v.msText(18.18)).toBe('18.2 ms');
    expect(v.msText(2500)).toBe('2.5 s');
    expect(v.windowText({ samples: 1 })).toBeUndefined();
    expect(v.windowText({ samples: 3, from: '2026-11-20T00:00:00Z', to: '2026-11-20T00:12:00Z' })).toBe('지난 12분');
  });
});
