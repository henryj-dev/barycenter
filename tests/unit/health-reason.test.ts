/**
 * 헬스 판정의 이유가 **무엇을 물었는지와 고칠 길**을 말한다 (2026-11-20).
 *
 * 운영에서 백엔드 셋이 `302 다 (2xx 가 아니다)` · `404 다 (2xx 가 아니다)` 로 트래픽에서 빠졌다. 그 문장으로는
 * 어느 주소 · 경로 · Host 를 물었는지, 무엇을 고쳐야 하는지 모른다. 풀 · 백엔드 개요가 이 문장을 그대로 보인다.
 */
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { probeHttp, probeTcp, statusReason } from '../../src/control/health.js';

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/moved') { res.writeHead(302, { location: '/login' }); res.end(); return; }
    if (req.url === '/secret') { res.writeHead(401); res.end(); return; }
    if (req.url === '/ok') { res.writeHead(200); res.end('ok'); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('HTTP 프로브의 이유', () => {
  it('3xx — 물은 주소와 Host, 따라가지 않는다는 것, 고칠 길을 말한다', async () => {
    const why = await probeHttp('127.0.0.1', port, 1000, { path: '/moved', hostHeader: 'app.test' });
    expect(why).toBe(`GET http://127.0.0.1:${port}/moved (Host: app.test) 가 302 로 답했다 — 2xx 를 기대한다. `
      + '리다이렉트는 따라가지 않는다 — 헬스 경로를 2xx 를 주는 곳으로 바꾸거나, 기대 상태에 302 를 넣는다');
  });

  it('404 · 401 — 경로가 없다 · 인증이 필요하다', async () => {
    expect(await probeHttp('127.0.0.1', port, 1000, { path: '/' })).toMatch(new RegExp(`^GET http://127\\.0\\.0\\.1:${port}/ 가 404 로 답했다 .*그 경로가 없다`));
    expect(await probeHttp('127.0.0.1', port, 1000, { path: '/secret' })).toMatch(/401 로 답했다 .*인증이 필요한 경로다/);
  });

  it('기대 상태를 적었으면 그것을 말하고 덧붙이지 않는다', () => {
    expect(statusReason('GET http://h:1/x', 302, [200, 204])).toBe('GET http://h:1/x 가 302 로 답했다 — 200, 204 를 기대한다');
  });

  it('맞으면 이유가 없다', async () => {
    expect(await probeHttp('127.0.0.1', port, 1000, { path: '/ok' })).toBeUndefined();
  });

  it('연결 실패도 어디에 붙으려 했는지 말한다', async () => {
    const closed = await new Promise<number>((r) => {
      const s = createServer();
      s.listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => r(p)); });
    });
    expect(await probeHttp('127.0.0.1', closed, 1000, { path: '/' })).toMatch(new RegExp(`^GET http://127\\.0\\.0\\.1:${closed}/ 에 연결하지 못했다: .*ECONNREFUSED`));
    expect(await probeTcp('127.0.0.1', closed, 1000)).toMatch(new RegExp(`^TCP 127\\.0\\.0\\.1:${closed} 에 연결하지 못했다: .*ECONNREFUSED`));
  });
});

describe('화면 — 풀 · 백엔드 개요가 「정상이 아닌 이유」 를 단다', () => {
  const gui = (p: string): string => readFileSync(join(import.meta.dirname, '../../gui/src', p), 'utf8');

  it('개요가 풀 · 백엔드에 이유 블록을 붙인다', () => {
    expect(gui('lib/detail/CellOverview.svelte')).toContain("{#if kind === 'pool' || kind === 'backend'}<HealthProblems {kind} /><HealthHistory {kind} />{/if}");
  });

  it('이유 블록은 `problemsOf` 하나에서 읽고, 정상이면 안 그린다', () => {
    const src = gui('lib/detail/HealthProblems.svelte');
    expect(src).toContain('problemsOf(desk, kind, key)');
    expect(src).toContain('{#if groups.length > 0}');
  });

  it('비정상 줄은 검사 방법과 프로버의 말을 함께 싣는다', () => {
    const src = gui('lib/detail/facts.ts');
    expect(src).toContain('`헬스체크(${healthCheckText(pool)})가 실패했어요.');
    expect(src).toContain('` 프로버: ${t.detail}`');
  });
});
