/**
 * **업스트림 TLS 풀의 HTTP 프로브는 TLS 로 찌른다** (2026-10-29)
 *
 * 전에는 프로브가 언제나 평문이었다. `upstreamTls` 를 켠 풀(예: `api.example.com:443`)에
 * 평문 GET 을 보냈고, 서버는 400 을 주거나 끊었다. 데이터 경로(nginx)는 TLS 로 잘
 * 붙는데 **프로브만 틀려서 산 백엔드가 트래픽에서 빠졌다.** 도그푸딩 중
 * `proxy_pass https://api.example.com/` 을 옮겨 보다가 찾았다.
 *
 * 여기서 실제 HTTPS 서버를 띄운다. 그 서버는 SNI 와 Host 가 `api.test` 일 때만 200 을 준다.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { probeBackend, probeHttp, probePlanOf } from '../../src/control/health.js';
import type { Model, Pool } from '../../src/model/provisional.js';

let server: Server;
let port = 0;
const seen: { sni?: string; host?: string }[] = [];

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bary-probe-tls-'));
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
      '-days', '1', '-subj', '/CN=api.test', '-addext', 'subjectAltName=DNS:api.test',
      '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'),
    ], { stdio: 'ignore' });
    server = createServer({ key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) },
      (q, r) => {
        const sni = (q.socket as { servername?: string | false }).servername || undefined;
        seen.push({ ...(sni === undefined ? {} : { sni }), ...(q.headers.host === undefined ? {} : { host: q.headers.host }) });
        r.writeHead(sni === 'api.test' && q.headers.host === 'api.test' ? 200 : 421);
        r.end();
      });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => { server?.close(); });

const model = (pool: Partial<Pool>): Model => ({
  listeners: [], httpRoutes: [], passthroughRoutes: [],
  pools: [{ key: 'ext', protocolClass: 'http', algorithm: 'round_robin', ...pool } as Pool],
  backends: [], certificates: [], tlsPolicies: [], sniBindings: [],
});

describe('프로브 계획 — 언제 TLS 인가', () => {
  it('upstreamTls 가 켜진 http 풀은 TLS 로, SNI 는 upstreamTls.sni 로', () => {
    const plan = probePlanOf(model({ upstreamTls: { enabled: true, sni: 'api.test' } }), 'ext');
    expect(plan.http?.tls).toEqual({ servername: 'api.test' });
  });

  it('sni 가 없으면 TLS 는 하되 SNI 를 안 보낸다', () => {
    expect(probePlanOf(model({ upstreamTls: { enabled: true } }), 'ext').http?.tls).toEqual({});
  });

  it('upstreamTls 가 없거나 꺼져 있으면 옛 동작(평문) 그대로다', () => {
    expect(probePlanOf(model({}), 'ext').http?.tls).toBeUndefined();
    expect(probePlanOf(model({ upstreamTls: { enabled: false } }), 'ext').http?.tls).toBeUndefined();
  });

  it('별도 헬스 포트·사이드카는 데이터 경로가 아니다 — 평문 그대로', () => {
    const ut = { enabled: true, sni: 'api.test' };
    expect(probePlanOf(model({ upstreamTls: ut, healthCheck: { port: 8081 } }), 'ext').http?.tls).toBeUndefined();
    expect(probePlanOf(model({ upstreamTls: ut, healthCheck: { hostOverride: '10.0.0.9' } }), 'ext').http?.tls).toBeUndefined();
  });
});

describe('실제 HTTPS 백엔드', () => {
  it('**평문 프로브는 HTTPS 백엔드를 죽었다고 본다** — 고치기 전의 동작', async () => {
    expect(await probeHttp('127.0.0.1', port, 2000, { path: '/' })).toBeDefined();
  });

  it('**TLS 프로브는 산 것으로 본다** — SNI 와 Host 가 같이 간다', async () => {
    const plan = probePlanOf(model({ upstreamTls: { enabled: true, sni: 'api.test' } }), 'ext');
    seen.length = 0;
    expect(await probeBackend(plan, '127.0.0.1', port, 2000)).toBeUndefined();
    expect(seen).toEqual([{ sni: 'api.test', host: 'api.test' }]);
  });

  it('지정한 hostHeader 가 SNI 이름보다 이긴다', async () => {
    seen.length = 0;
    const r = await probeHttp('127.0.0.1', port, 2000, { path: '/', hostHeader: 'other.test', tls: { servername: 'api.test' } });
    expect(r).toMatch(/421/);
    expect(seen).toEqual([{ sni: 'api.test', host: 'other.test' }]);
  });

  it('자체 서명 인증서도 프로브는 통과한다 — 검증은 데이터 경로의 몫이다', async () => {
    expect(await probeHttp('127.0.0.1', port, 2000, { path: '/', tls: { servername: 'api.test' } })).toBeUndefined();
  });
});
