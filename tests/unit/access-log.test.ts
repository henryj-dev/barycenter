/**
 * 액세스 로그 (2026-11-22) — 엔진의 고리 → 데몬의 메모리 → API.
 *
 * 엔진에서 실제로 적히는지는 `tests/golden/access-log.test.ts` 가 잰다. 여기서는 렌더 · 덤프 읽기 · 순번 ·
 * 이름 풀기 · 거르기 · 쪽 · 내보내기 · API 를 잰다.
 */
import { describe, expect, it } from 'vitest';

import { getPath } from '../../src/cli/get.js';
import { render, upstreamName } from '../../src/conf/render.js';
import { ACCESS_DICT, ACCESS_RING, parseAccessDump } from '../../src/conf/access-log.js';
import { AccessLogCollector, accessCsvRow, ACCESS_CSV_COLUMNS, type AccessEntry } from '../../src/control/access-log.js';
import { httpAdminConf, streamAdminConf } from '../../src/control/membership.js';
import { RELAY_PATHS } from '../../src/global/relay.js';
import { decodeAfter } from '../../src/dp/wire.js';
import type { Model } from '../../src/model/provisional.js';

const LUA = { httpLua: true, streamLua: true, streamRealip: false, sslConfCommand: true };

const model = (): Model => ({
  listeners: [
    { key: 'web', protocol: 'http', bind: '0.0.0.0', port: 8080, enabled: true, http: { defaultAction: 'reject' } },
    { key: 'pt', protocol: 'tls_passthrough', bind: '0.0.0.0', port: 9443, enabled: true },
  ],
  httpRoutes: [{ key: 'api', listener: 'web', hosts: ['a.test'], priority: 10, action: { kind: 'proxy', pool: 'app', websocket: false } }],
  passthroughRoutes: [{ key: 'pt:one', listener: 'pt', snis: ['s.test'], priority: 1, action: { kind: 'proxy', pool: 'raw' } }],
  pools: [
    { key: 'app', protocolClass: 'http', algorithm: 'round_robin' },
    { key: 'raw', protocolClass: 'tcp', algorithm: 'round_robin' },
  ],
  backends: [
    { key: 'app-1', pool: 'app', host: '10.0.0.1', port: 80, weight: 1 },
    { key: 'raw-1', pool: 'raw', host: '10.0.0.1', port: 80, weight: 1 },
  ],
  certificates: [], tlsPolicies: [], sniBindings: [],
});

const line = (o: Record<string, unknown>): string => JSON.stringify(o);
const dump = (boot: string, seq: number, rows: Record<string, unknown>[]): string =>
  [`boot ${boot} ${seq}`, ...rows.map(line)].join('\n');
const http = (q: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  q, t: 1_795_000_000 + q, c: '198.51.100.7', l: 'web', m: 'GET', h: 'a.test', u: `/p/${q}`, s: 200, ...extra,
});

/** 엔진 하나를 흉내 낸다. `after` 뒤의 줄만, 한 번에 `max` 줄까지 준다. */
function fakeEngine(): { boot: string; rows: Record<string, unknown>[]; max: number; read: (a: { http?: number }) => Promise<{ http: string }> } {
  const e = {
    boot: '100.5', rows: [] as Record<string, unknown>[], max: 1000,
    read: async (a: { http?: number }) => {
      const seq = e.rows.length === 0 ? 0 : Number(e.rows[e.rows.length - 1]!['q']);
      const after = a.http ?? 0;
      const from = Math.max(after + 1, seq - ACCESS_RING + 1);
      const out = e.rows.filter((r) => Number(r['q']) >= from).slice(0, e.max);
      return { http: dump(e.boot, seq, out) };
    },
  };
  return e;
}

const collector = (read: (a: { http?: number }) => Promise<{ http?: string; stream?: string }>, keep?: number): AccessLogCollector =>
  new AccessLogCollector({
    read, model: async () => model(), lua: () => ({ http: true, stream: true }), node: 'n1',
    resolve: async (hp) => hp, ...(keep === undefined ? {} : { keep }),
  });

describe('렌더 — Lua 가 있을 때만 고리를 낸다', () => {
  it('http · stream 에 dict 와 log 단계', () => {
    const conf = render(model(), LUA).conf;
    expect(conf).toContain(`lua_shared_dict ${ACCESS_DICT.http} 8m;`);
    expect(conf).toContain(`lua_shared_dict ${ACCESS_DICT.stream} 8m;`);
    expect(conf).toContain(`local A = ngx.shared.${ACCESS_DICT.http}`);
    expect(conf).toContain(`local A = ngx.shared.${ACCESS_DICT.stream}`);
  });

  it('Lua 가 없으면 아무것도 안 낸다', () => {
    const conf = render(model(), { ...LUA, httpLua: false, streamLua: false }).conf;
    expect(conf).not.toContain('bary_http_access');
    expect(conf).not.toContain('bary_stream_access');
  });

  it('admin 조각에 읽는 창구가 있다 — http 는 /access-log, stream 은 access 동사', () => {
    expect(httpAdminConf('g', '1', '/run/a.sock')).toContain('location = /access-log');
    expect(streamAdminConf('1', '/run/s.sock')).toContain('if verb == "access" then');
  });
});

describe('덤프 읽기 (parseAccessDump)', () => {
  it('머리가 없으면 undefined — 지어내지 않는다', () => {
    expect(parseAccessDump('')).toBeUndefined();
    expect(parseAccessDump('{"q":1}')).toBeUndefined();
  });

  it('모르는 줄 · 틀린 칸은 버리고, 순번 차례로 낸다', () => {
    const d = parseAccessDump([
      'boot 12.3 3', line(http(3)), 'not json', line({ q: 'x', t: 1, s: 200 }), line(http(1, { us: 'bad', d: 0.25, tr: 'nope' })),
    ].join('\n'))!;
    expect(d.boot).toBe('12.3');
    expect(d.seq).toBe(3);
    expect(d.entries.map((e) => e.q)).toEqual([1, 3]);
    expect(d.entries[0]).not.toHaveProperty('us');
    expect(d.entries[0]).not.toHaveProperty('tr');
    expect(d.entries[0]!.d).toBe(0.25);
  });

  it('한 번도 안 쓰인 고리', () => {
    expect(parseAccessDump('boot - 0\n')).toEqual({ boot: '-', seq: 0, entries: [] });
  });
});

describe('수집 (AccessLogCollector)', () => {
  it('이름을 모델로 푼다 — 리스너 · 라우트 · 풀 · 백엔드. 못 찾으면 null', async () => {
    const c = collector(async () => ({
      http: dump('1.5', 3, [
        http(1, { r: 'api', p: upstreamName('app'), ua: '10.0.0.1:80', us: 502, s: 502, d: 0.0123, uc: 0.001, uh: 0.01, id: 'ab' }),
        http(2, { l: 'web~http', r: 'gone', p: 'nope', ua: '10.9.9.9:80' }),
        http(3, { l: 'ghost' }),
      ]),
      stream: dump('2', 1, [{ q: 1, t: 1_795_000_000, s: 200, l: 'pt', r: 'pt:one', p: upstreamName('raw'), ua: '10.0.0.1:80', sni: 's.test', tr: 'tcp' }]),
    }));
    await c.tick();
    const all = c.list({}, { limit: 10 }).entries;
    expect(all.map((e) => e.id)).toEqual(['s2-1', 'h15-3', 'h15-2', 'h15-1']);
    const one = c.get('h15-1')!;
    expect(one).toMatchObject({
      listener: 'web', route: { kind: 'httpRoute', key: 'api' }, pool: 'app', backend: 'app-1', status: 502, upstreamStatus: 502,
      durationMs: 12.3, timing: { connectMs: 1, headerMs: 10 }, requestId: 'ab', node: 'n1', transport: 'http',
    });
    expect(c.get('h15-2')).toMatchObject({ listener: 'web', route: null, pool: null, backend: null, upstreamAddr: '10.9.9.9:80' });
    expect(c.get('h15-3')!.listener).toBeNull();
    expect(c.get('s2-1')).toMatchObject({
      plane: 'stream', transport: 'tcp', route: { kind: 'passthroughRoute', key: 'pt:one' }, pool: 'raw', backend: 'raw-1',
      tls: { sni: 's.test', version: null },
    });
  });

  it('마지막 순번 뒤만 묻고, 같은 줄을 두 번 넣지 않는다', async () => {
    const eng = fakeEngine();
    const asked: (number | undefined)[] = [];
    const c = collector(async (a) => { asked.push(a.http); return eng.read(a); });
    eng.rows.push(http(1), http(2));
    await c.tick();
    eng.rows.push(http(3));
    await c.tick();
    await c.tick();
    expect(asked).toEqual([0, 2, 3]);
    expect(c.list({}, { limit: 10 }).entries.map((e) => e.path)).toEqual(['/p/3', '/p/2', '/p/1']);
  });

  it('한 번에 다 못 받으면 같은 주기에 이어 묻는다', async () => {
    const eng = fakeEngine();
    eng.max = 2;
    for (let i = 1; i <= 5; i += 1) eng.rows.push(http(i));
    const c = collector((a) => eng.read(a));
    await c.tick();
    expect(c.window().kept).toBe(5);
  });

  it('엔진이 다시 뜨면(boot 가 바뀌면) 처음부터 센다', async () => {
    const eng = fakeEngine();
    eng.rows.push(http(1), http(2), http(3));
    const c = collector((a) => eng.read(a));
    await c.tick();
    eng.boot = '200.1';
    eng.rows = [http(1, { u: '/new' })];
    await c.tick();
    expect(c.get('h2001-1')!.path).toBe('/new');
    expect(c.window().kept).toBe(4);
    expect(c.dropped()).toBe(0);
  });

  it('고리가 한 바퀴를 넘게 돌면 못 읽은 수를 센다', async () => {
    const eng = fakeEngine();
    eng.rows.push(http(1));
    const c = collector((a) => eng.read(a));
    await c.tick();
    for (let i = 2; i <= ACCESS_RING + 11; i += 1) eng.rows.push(http(i));
    await c.tick();
    expect(c.dropped()).toBe(10);
  });

  it('머리보다 새 줄(덤프 중에 덮인 칸)은 받지 않고, 다음 주기에 제자리에서 받는다', async () => {
    let n = 0;
    const c = collector(async () => {
      n += 1;
      return n === 1
        ? { http: dump('1', 2, [http(1), http(2), http(5003)]) }
        : { http: dump('1', 3, [http(3)]) };
    });
    await c.tick();
    expect(c.list({}, { limit: 10 }).entries.map((e) => e.path)).toEqual(['/p/2', '/p/1']);
    await c.tick();
    expect(c.list({}, { limit: 10 }).entries.map((e) => e.path)).toEqual(['/p/3', '/p/2', '/p/1']);
    expect(c.dropped()).toBe(0);
  });

  it('keep 을 넘으면 오래된 것부터 버린다', async () => {
    const eng = fakeEngine();
    for (let i = 1; i <= 5; i += 1) eng.rows.push(http(i));
    const c = collector((a) => eng.read(a), 3);
    await c.tick();
    expect(c.list({}, { limit: 10 }).entries.map((e) => e.path)).toEqual(['/p/5', '/p/4', '/p/3']);
  });

  it('거르기 · 쪽 · 실시간', async () => {
    const eng = fakeEngine();
    eng.rows.push(http(1, { s: 404 }), http(2, { s: 500, r: 'api', p: upstreamName('app'), ua: '10.0.0.1:80' }), http(3), http(4, { s: 404, h: 'B.test' }));
    const c = collector((a) => eng.read(a));
    await c.tick();
    expect(c.list({ classes: ['4xx'] }, { limit: 10 }).entries.map((e) => e.path)).toEqual(['/p/4', '/p/1']);
    expect(c.list({ classes: ['4xx', '5xx'], route: 'api' }, { limit: 10 }).entries.map((e) => e.path)).toEqual(['/p/2']);
    expect(c.list({ backend: 'app-1' }, { limit: 10 }).entries.length).toBe(1);
    expect(c.list({ q: 'b.TEST' }, { limit: 10 }).entries.map((e) => e.path)).toEqual(['/p/4']);
    const first = c.list({}, { limit: 2 });
    expect(first.entries.map((e) => e.path)).toEqual(['/p/4', '/p/3']);
    expect(first.more).toBe(true);
    const next = c.list({}, { limit: 2, before: first.entries[1]!.cursor });
    expect(next.entries.map((e) => e.path)).toEqual(['/p/2', '/p/1']);
    expect(next.more).toBe(false);
    eng.rows.push(http(5));
    await c.tick();
    const live = c.list({}, { limit: 100, after: first.cursor });
    expect(live.entries.map((e) => e.path)).toEqual(['/p/5']);
    expect(live.cursor).toBeGreaterThan(first.cursor);
  });

  it('못 읽으면 unavailable, Lua 가 없으면 unsupported — 줄을 짓지 않는다', async () => {
    const bad = collector(async () => { throw new Error('socket'); });
    await bad.tick();
    expect(bad.state()).toMatchObject({ state: 'unavailable' });
    const none = new AccessLogCollector({ model: async () => model(), lua: () => ({ http: true, stream: true }) });
    expect(none.state().state).toBe('unsupported');
    const noLua = collector(async () => ({}));
    expect(new AccessLogCollector({ read: async () => ({}), model: async () => model(), lua: () => ({ http: false, stream: false }) }).state().state).toBe('unsupported');
    await noLua.tick();
    expect(noLua.state()).toMatchObject({ state: 'unavailable' });
  });
});

describe('내보내기 (CSV)', () => {
  it('머리 칸과 값의 수가 같고, 수식으로 읽힐 값은 막는다', async () => {
    const c = collector(async () => ({ http: dump('1', 1, [http(1, { ag: '=HYPERLINK("x")', u: '/a,b' })]) }));
    await c.tick();
    const e = c.get('h1-1') as AccessEntry;
    const row = accessCsvRow(e);
    expect(row).toContain(`"'=HYPERLINK(""x"")"`);
    expect(row).toContain('"/a,b"');
    expect(row.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).length).toBe(ACCESS_CSV_COLUMNS.length);
  });
});

describe('원격 DP 창구 — after 검사 (decodeAfter)', () => {
  it('평면마다 음이 아닌 정수만 받는다', () => {
    expect(decodeAfter(undefined)).toEqual({});
    expect(decodeAfter({ http: 3, stream: 0 })).toEqual({ http: 3, stream: 0 });
    for (const bad of [null, [], { http: -1 }, { http: 1.5 }, { http: '3' }, { tcp: 1 }]) {
      expect(() => decodeAfter(bad), JSON.stringify(bad)).toThrow();
    }
  });
});

describe('CLI — bary get', () => {
  it('access-log · access-log/<id>', () => {
    expect(getPath('access-log')).toBe('/api/v1/access-log');
    expect(getPath('access-log/h1-2')).toBe('/api/v1/access-log/h1-2');
  });
});

describe('전역 중계', () => {
  it('전역이 지역의 액세스 로그를 읽는다', () => {
    expect(RELAY_PATHS).toContain('access-log');
    expect(RELAY_PATHS).toContain('access-log/:id');
  });
});

describe('API — /api/v1/access-log', () => {
  it('적지 않는 인스턴스는 unsupported, 적으면 ok · 거르기 · 하나 · 내보내기', async () => {
    const { TokenAuth, hashToken } = await import('../../src/api/auth.js');
    const { createApi } = await import('../../src/api/server.js');
    const auth = new TokenAuth([{ name: 'r', hash: hashToken('t'), scopes: ['read'] }]);
    const election = { state: { isLeader: true, token: '1', holder: 't', since: '' } };
    const c = collector(async () => ({ http: dump('7', 2, [http(1, { s: 404 }), http(2)]) }));
    await c.tick();
    const base = { db: { query: async () => ({ rows: [] }) }, store: {}, control: {}, auth, election } as never;
    for (const [opts, want] of [[{}, 'unsupported'], [{ accessLog: c }, 'ok']] as const) {
      const server = createApi({ ...(base as object), ...opts } as never);
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const h = { authorization: 'Bearer t' };
      const all = await (await fetch(`${url}/api/v1/access-log`, { headers: h })).json() as Record<string, unknown>;
      expect(all['state']).toBe(want);
      if (want === 'ok') {
        expect((all['entries'] as unknown[]).length).toBe(2);
        expect(all['window']).toMatchObject({ kept: 2 });
        const f = await (await fetch(`${url}/api/v1/access-log?status=4xx`, { headers: h })).json() as { entries: AccessEntry[] };
        expect(f.entries.map((e) => e.status)).toEqual([404]);
        expect((await fetch(`${url}/api/v1/access-log?status=6xx`, { headers: h })).status).toBe(400);
        expect((await fetch(`${url}/api/v1/access-log?before=x`, { headers: h })).status).toBe(400);
        expect((await fetch(`${url}/api/v1/access-log?format=xml`, { headers: h })).status).toBe(400);
        const one = await fetch(`${url}/api/v1/access-log/h7-1`, { headers: h });
        expect(one.status).toBe(200);
        expect(((await one.json()) as AccessEntry).status).toBe(404);
        expect((await fetch(`${url}/api/v1/access-log/h7-9`, { headers: h })).status).toBe(404);
        const csv = await fetch(`${url}/api/v1/access-log?format=csv`, { headers: h });
        expect(csv.headers.get('content-type')).toContain('text/csv');
        expect(csv.headers.get('content-disposition')).toMatch(/attachment; filename="access-log-.+\.csv"/);
        const text = await csv.text();
        expect(text.split('\r\n')[0]).toBe(ACCESS_CSV_COLUMNS.join(','));
        expect(text.trim().split('\r\n').length).toBe(3);
        const nd = await (await fetch(`${url}/api/v1/access-log?format=ndjson&status=2xx`, { headers: h })).text();
        expect(nd.trim().split('\n').map((l) => (JSON.parse(l) as AccessEntry).status)).toEqual([200]);
      } else {
        expect(all).not.toHaveProperty('entries');
        expect((await fetch(`${url}/api/v1/access-log?format=csv`, { headers: h })).status).toBe(409);
      }
      expect((await fetch(`${url}/api/v1/access-log`)).status).toBe(401);
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('화면 규칙 (src/web/access-log-view.ts)', () => {
  it('주소 · 쿼리 · 대상', async () => {
    const v = await import('../../src/web/access-log-view.js');
    const { NAV_GROUPS } = await import('../../src/web/nav.js');
    const { KIT_ROUTES, pageOf } = await import('../../src/web/page.js');
    expect(KIT_ROUTES).toContainEqual({ place: 'accessLog', path: '/ops/access-log' });
    expect(pageOf('/ops/access-log')).toBe('accessLog');
    expect(NAV_GROUPS.flatMap((g) => g.items)).toContainEqual(expect.objectContaining({ place: 'accessLog', href: '/ops/access-log' }));
    expect(v.accessLogHref('route', 'a:b')).toBe('/ops/access-log?route=a%3Ab');
    expect(v.targetOf(new URLSearchParams('pool=p1&backend=b1'))).toEqual({ kind: 'pool', key: 'p1' });
    expect(v.targetOf(new URLSearchParams(''))).toBeUndefined();
    expect(v.accessSearch({ classes: [], q: '  ' })).toBe('');
    expect(v.accessSearch({ classes: ['4xx', '5xx'], target: { kind: 'listener', key: 'web' }, q: ' /api ' }, { before: 9, limit: 100, format: 'csv' }))
      .toBe('?status=4xx%2C5xx&listener=web&q=%2Fapi&before=9&limit=100&format=csv');
  });

  it('문구 — 없는 값은 짓지 않는다', async () => {
    const v = await import('../../src/web/access-log-view.js');
    const c = collector(async () => ({
      http: dump('1', 2, [
        http(1, { s: 502, us: 502, r: 'api', p: upstreamName('app'), ua: '10.0.0.1:80', d: 1.234 }),
        http(2, { s: 403 }),
      ]),
    }));
    await c.tick();
    const proxied = c.get('h1-1')!;
    const local = c.get('h1-2')!;
    expect(v.statusTone(502)).toBe('danger');
    expect(v.statusTone(403)).toBe('warn');
    expect(v.statusTone(301)).toBe('info');
    expect(v.statusTone(200)).toBe('ok');
    expect(v.requestText(local)).toBe('GET a.test/p/2');
    expect(v.pathText(proxied)).toBe('api → app → app-1');
    expect(v.pathText(local)).toBe('—');
    expect(v.originText(proxied)).toBe('백엔드가 502 로 답했어요');
    expect(v.originText(local)).toBe('barycenter 가 백엔드 없이 답했어요');
    expect(v.durationText(1234)).toBe('1.23s');
    expect(v.durationText(0.2)).toBe('<1ms');
    expect(v.durationText(null)).toBe('—');
    expect(v.bytesText(2048)).toBe('2.0KB');
    const items = v.detailItems(local);
    expect(items.find((i) => i.label === '라우트')!.value).toBe('—');
    expect(items.find((i) => i.label === '줄 이름')!.value).toBe('h1-2');
  });
});

