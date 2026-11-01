/**
 * **전역 모드** (docs/design-global-mode.md) — 가짜 지역(HTTPS) 둘과 실제 전역 서버로 잰다.
 *
 * 재는 것: 지역 목록 해독이 엄하다 · 요약은 지역 status 를 해석 없이 싣고 판 차이를 단다 · 못 닿은 지역은
 * 「모른다」(지난 값을 지금처럼 안 보인다) · 401/403 은 장애와 따로 · 허용 목록 밖은 404 · 쓰기는 보는 사람의 자격으로 중계 ·
 * **SSE 는 지역마다 상류 하나**(늦게 온 사람도 스냅샷부터) · readyz 는 지역 상태를 안 본다.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { createServer as createHttps, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hashToken, TokenAuth } from '../../src/api/auth.js';
import { createApi } from '../../src/api/server.js';
import { parseRegistry, type Region } from '../../src/global/registry.js';
import { RegionRelay } from '../../src/global/relay.js';

const VIEWER = 'viewer-token';
const WRITER = 'writer-token';
let pem: { cert: string; key: string };
let dir = '';

type Seen = { method: string; url: string; auth: string; body: string; ifMatch?: string; xff?: string };
type Fake = { server: HttpsServer; url: string; eventsOpened: number; push: (frame: string) => void; reject: boolean; commit: string; seen: Seen[] };
const fakes: Fake[] = [];

async function fakeRegion(commit: string): Promise<Fake> {
  const streams: import('node:http').ServerResponse[] = [];
  const f: Fake = { server: undefined as unknown as HttpsServer, url: '', eventsOpened: 0, push: (fr) => streams.forEach((s) => s.write(fr)), reject: false, commit, seen: [] };
  f.server = createHttps({ cert: pem.cert, key: pem.key }, async (req, res) => {
    let body = '';
    for await (const c of req) body += String(c);
    f.seen.push({
      method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization ?? '', body,
      ...(typeof req.headers['if-match'] === 'string' ? { ifMatch: req.headers['if-match'] } : {}),
      ...(typeof req.headers['x-forwarded-for'] === 'string' ? { xff: req.headers['x-forwarded-for'] } : {}),
    });
    // 지역은 전역의 auditor 토큰과, 전역이 넘긴 보는 사람의 자격을 둘 다 안다(계정·토큰을 함께 쓴다).
    const known = ['Bearer region-token', `Bearer ${VIEWER}`, `Bearer ${WRITER}`, 'Session sid-1'];
    if (!known.includes(req.headers.authorization ?? '') || f.reject) {
      res.writeHead(403, { 'content-type': 'application/json' }); res.end('{"code":"forbidden"}'); return;
    }
    if (req.method !== 'GET') { res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ wrote: req.url })); return; }
    if (req.url === '/api/v1/status') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ head: '7', build: { commit: f.commit } })); return; }
    if (req.url?.startsWith('/api/v1/audit')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ q: req.url })); return; }
    if (req.url === '/api/v1/events') {
      f.eventsOpened += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: snapshot\ndata: {"head":"7"}\n\n');
      streams.push(res);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"code":"no_route"}');
  });
  await new Promise<void>((r) => f.server.listen(0, '127.0.0.1', r));
  f.url = `https://127.0.0.1:${(f.server.address() as AddressInfo).port}`;
  fakes.push(f);
  return f;
}

let global: Server;
let base = '';
let a: Fake;
let b: Fake;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bary-global-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], { stdio: 'ignore' });
  pem = { cert: readFileSync(join(dir, 'c.pem'), 'utf8'), key: readFileSync(join(dir, 'k.pem'), 'utf8') };
  a = await fakeRegion('abc1234');
  b = await fakeRegion('def5678');
  const region = (name: string, api: string): Region => ({ name, api, gui: `https://${name}.example`, ca: pem.cert, token: 'region-token' });
  const relay = new RegionRelay([
    region('alpha', a.url), region('beta', b.url), region('gone', 'https://127.0.0.1:1'),
  ], { ownCommit: 'abc1234' });
  global = createApi({ global: relay, auth: new TokenAuth([
    { name: 'viewer', role: 'auditor', hash: hashToken(VIEWER) },
    { name: 'writer', role: 'admin', hash: hashToken(WRITER) },
  ]) });
  await new Promise<void>((r) => global.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(global.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  global?.closeAllConnections?.();
  await new Promise<void>((r) => global?.close(() => r()));
  for (const f of fakes) { f.server.closeAllConnections?.(); f.server.close(); }
  rmSync(dir, { recursive: true, force: true });
});

const get = (path: string): Promise<Response> => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${VIEWER}` } });

describe('지역 목록 해독', () => {
  const read = (p: string): string => (p.endsWith('.ca') ? pem.cert : 'tok');
  const ok = { name: 'dev-icn', api: 'https://10.0.0.1:8443/', gui: 'https://g.example', ca: 'x.ca', token: 't' };

  it('받는 모양 — 끝 `/` 를 떼고 파일을 읽는다', () => {
    expect(parseRegistry([ok], read)[0]).toMatchObject({ name: 'dev-icn', api: 'https://10.0.0.1:8443', token: 'tok' });
  });

  it('**모르는 키·겹치는 이름·https 아닌 주소·이상한 이름·빈 목록은 기동 거부**', () => {
    expect(() => parseRegistry([{ ...ok, extra: 1 }], read)).toThrow(/모르는 키/);
    expect(() => parseRegistry([ok, ok], read)).toThrow(/겹친다/);
    expect(() => parseRegistry([{ ...ok, api: 'http://10.0.0.1' }], read)).toThrow(/https/);
    expect(() => parseRegistry([{ ...ok, name: 'Bad Name' }], read)).toThrow(/모양/);
    expect(() => parseRegistry([], read)).toThrow(/비어/);
    expect(() => parseRegistry([{ ...ok, ca: 'not-pem' }], () => 'nope')).toThrow(/PEM/);
  });
});

describe('요약', () => {
  it('**지역 status 를 그대로 싣고 판 차이를 단다**, 못 닿은 지역은 status 없이 「모른다」', async () => {
    const r = await get('/api/v1/regions');
    expect(r.status).toBe(200);
    const body = await r.json() as { mode: string; regions: Record<string, unknown>[] };
    expect(body.mode).toBe('global');
    const by = Object.fromEntries(body.regions.map((x) => [x['name'], x]));
    expect(by['alpha']).toMatchObject({ reachable: true, status: { head: '7' }, regionBuild: 'abc1234', buildMismatch: false });
    expect(by['beta']).toMatchObject({ reachable: true, buildMismatch: true });
    expect(by['gone']).toMatchObject({ reachable: false });
    expect(by['gone']).not.toHaveProperty('status');
  });

  it('지역이 403 이면 장애가 아니라 인증 문제로 싣는다', async () => {
    b.reject = true;
    const body = await (await get('/api/v1/regions')).json() as { regions: Record<string, unknown>[] };
    expect(body.regions.find((x) => x['name'] === 'beta')).toMatchObject({ reachable: true, auth: 'rejected' });
    expect(body.regions.find((x) => x['name'] === 'beta')).toHaveProperty('lastOkAt');
    b.reject = false;
  });
});

describe('중계', () => {
  it('허용된 경로는 상태·본문·쿼리를 그대로 넘긴다 — **보는 사람의 자격으로**', async () => {
    a.seen.length = 0;
    const r = await get('/api/v1/regions/alpha/audit?limit=5');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ q: '/api/v1/audit?limit=5' });
    expect(a.seen.at(-1)).toMatchObject({ method: 'GET', auth: `Bearer ${VIEWER}` });
    expect((await get('/api/v1/regions/alpha/listeners')).status).toBe(404); // 지역의 404 를 그대로
  });

  it('**허용 목록 밖(config/export·backup)은 전역이 404** — 지역에 묻지도 않는다', async () => {
    for (const p of ['config/export', 'backup', 'config/model']) {
      const r = await get(`/api/v1/regions/alpha/${p}`);
      expect(r.status).toBe(404);
      expect((await r.json() as { code: string }).code).toBe('global_mode');
    }
  });

  it('**쓰기는 보는 사람의 자격 그대로 그 지역으로 간다** — 메서드·경로·본문·If-Match 를 넘긴다', async () => {
    a.seen.length = 0;
    const r = await fetch(`${base}/api/v1/regions/alpha/changesets/cs%201`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${WRITER}`, 'content-type': 'application/json', 'if-match': '"e7"' },
      body: JSON.stringify({ patch: [{ op: 'add' }] }),
    });
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ wrote: '/api/v1/changesets/cs%201' });
    const seen = a.seen.at(-1)!;
    expect(seen).toMatchObject({ method: 'PATCH', url: '/api/v1/changesets/cs%201', auth: `Bearer ${WRITER}`, ifMatch: '"e7"' });
    expect(JSON.parse(seen.body)).toEqual({ patch: [{ op: 'add' }] });
    expect(seen.xff).toBeDefined();
  });

  it('쓰기 범위는 전역이 먼저 거른다 — auditor 는 지역에 보내지도 않는다', async () => {
    a.seen.length = 0;
    const r = await fetch(`${base}/api/v1/regions/alpha/apply`, { method: 'POST', headers: { authorization: `Bearer ${VIEWER}` }, body: '{}' });
    expect(r.status).toBe(403);
    expect(a.seen).toEqual([]);
  });

  it('**목록에 없는 쓰기는 없다** — 405', async () => {
    const r = await fetch(`${base}/api/v1/regions/alpha/status`, { method: 'POST', headers: { authorization: `Bearer ${VIEWER}` }, body: '{}' });
    expect(r.status).toBe(405);
  });

  it('못 닿은 지역은 502 region_unreachable, 모르는 지역은 404', async () => {
    expect((await get('/api/v1/regions/gone/status')).status).toBe(502);
    expect((await get('/api/v1/regions/nope/status')).status).toBe(404);
  });

  it('전역에는 지역 경로가 없다 — `/api/v1/status` 는 404 global_mode', async () => {
    expect((await (await get('/api/v1/status')).json() as { code: string }).code).toBe('global_mode');
  });

  it('readyz 는 지역 상태와 무관하게 200 (DNS LB 가 전역을 안 뺀다)', async () => {
    const r = await fetch(`${base}/readyz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, mode: 'global', regions: 3 });
  });
});

describe('SSE — 지역마다 상류 하나', () => {
  async function readUntil(r: Response, needle: string): Promise<string> {
    const reader = r.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (!buf.includes(needle)) {
      const c = await reader.read();
      if (c.done) break;
      buf += dec.decode(c.value, { stream: true });
    }
    await reader.cancel();
    return buf;
  }

  it('**두 사람이 봐도 지역 연결은 하나**, 늦게 온 사람도 스냅샷과 그 뒤 이벤트부터 받는다', async () => {
    const before = a.eventsOpened;
    const ac1 = new AbortController();
    const one = await fetch(`${base}/api/v1/regions/alpha/events`, { headers: { authorization: `Bearer ${VIEWER}` }, signal: ac1.signal });
    const r1 = readUntil(one, 'event: health');
    await new Promise((r) => setTimeout(r, 100));
    a.push('event: health\ndata: {"b":"x"}\n\n');
    expect(await r1).toContain('event: snapshot');
    const two = await fetch(`${base}/api/v1/regions/alpha/events`, { headers: { authorization: `Bearer ${VIEWER}` } });
    const late = await readUntil(two, 'event: health');
    expect(late).toContain('event: snapshot');
    expect(late).toContain('"b":"x"');
    expect(a.eventsOpened - before).toBe(1);
    ac1.abort();
  });
});
