/**
 * 트래픽 카운터가 **실물 엔진에서** 센다 (2026-11-20, 골든).
 *
 * `nginx -t` 는 Lua 를 안 본다(E64). 문법이 맞아도 log 단계가 죽어 있으면 카운터는 영영 0 이다.
 * 그래서 요청을 흘리고 dict 를 읽는다.
 *
 * ── 무엇을 재는가
 *
 *   · http — 라우트(프록시 · 리다이렉트), 리스너 기본 동작, 풀, 백엔드 · 상태 계열 · 바이트
 *   · stream — tcp 리스너, 패스스루 라우트(SNI 로 고른다)
 *   · 업스트림이 500 을 줘서 `error_page` 가 가로챈 요청도 백엔드에 잡힌다
 *
 * 덤프는 admin 조각과 **같은 Lua**(`trafficDumpLua`)로 읽는다.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { dropScratch } from '../scratch.js';
import { toolsImage } from './tools-image.js';
import { render, upstreamName } from '../../src/conf/render.js';
import { parseTrafficDump, trafficDumpLua, type TrafficCounter } from '../../src/conf/traffic.js';
import type { Model } from '../../src/model/provisional.js';

const ON = { httpLua: true, streamLua: true, streamRealip: false, sslConfCommand: true };
const HTTP = 18961;
const TCP = 18962;
const PT = 18963;

function dockerAvailable(): boolean {
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }); return true; } catch { return false; }
}

const model: Model = {
  listeners: [
    { key: 'web:front', protocol: 'http', bind: '0.0.0.0', port: HTTP, enabled: true, http: { defaultAction: { pool: 'app' } } },
    { key: 'raw', protocol: 'tcp', bind: '0.0.0.0', port: TCP, enabled: true, defaultPool: 'echo' },
    { key: 'pt', protocol: 'tls_passthrough', bind: '0.0.0.0', port: PT, enabled: true },
  ],
  httpRoutes: [
    { key: 'api', listener: 'web:front', hosts: ['a.test'], priority: 10, pathPrefix: '/api/', action: { kind: 'proxy', pool: 'app', websocket: false } },
    { key: 'old', listener: 'web:front', hosts: ['a.test'], priority: 5, pathPrefix: '/old/', action: { kind: 'redirect', to: 'https://b.test/', status: 301 } },
  ],
  passthroughRoutes: [{ key: 'pt:s', listener: 'pt', snis: ['s.test'], priority: 1, action: { kind: 'proxy', pool: 'tls' } }],
  pools: [
    { key: 'app', protocolClass: 'http', algorithm: 'round_robin' },
    { key: 'echo', protocolClass: 'tcp', algorithm: 'round_robin' },
    { key: 'tls', protocolClass: 'tcp', algorithm: 'round_robin' },
  ],
  backends: [
    { key: 'app-1', pool: 'app', host: '127.0.0.1', port: 19201, weight: 1 },
    { key: 'echo-1', pool: 'echo', host: '127.0.0.1', port: 19202, weight: 1 },
    { key: 'tls-1', pool: 'tls', host: '127.0.0.1', port: 19203, weight: 1 },
  ],
  certificates: [], tlsPolicies: [], sniBindings: [],
};

function run(): { http: TrafficCounter[]; stream: TrafficCounter[]; raw: string } {
  const dir = mkdtempSync(join(tmpdir(), 'bary-traffic-'));
  chmodSync(dir, 0o777);
  try {
    mkdirSync(join(dir, 'conf'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    const rendered = render(model, ON).conf;
    // 슬롯을 심고(적재 경로는 e2e 가 잰다), 덤프 창구를 붙인다 — admin 조각과 같은 Lua 다.
    const httpSeed = `init_worker_by_lua_block {
      ngx.shared.bary_http:set("slot:${upstreamName('app')}:0", "127.0.0.1:19201")
    }
    server { listen 18969; location = /dump { content_by_lua_block { ${trafficDumpLua('http')} } } }`;
    const streamSeed = `init_worker_by_lua_block {
      ngx.shared.bary_stream:set("slot:${upstreamName('echo')}:0", "127.0.0.1:19202")
      ngx.shared.bary_stream:set("slot:${upstreamName('tls')}:0", "127.0.0.1:19203")
    }
    server { listen 18968; content_by_lua_block { ${trafficDumpLua('stream')} } }`;
    const conf = rendered
      .replace(/^(http \{)/m, `$1\n${httpSeed}`)
      .replace(/^(stream \{)/m, `$1\n${streamSeed}`)
      // admin 조각은 이 테스트에 없다 — include 가 빈 글롭이면 nginx 는 그냥 지나간다.
      ;
    writeFileSync(join(dir, 'conf', 'nginx.conf'), `daemon off;\nworker_processes 2;\n${conf}`, 'utf8');
    writeFileSync(join(dir, 'back.conf'), `daemon off;
error_log logs/b.log warn;
pid logs/b.pid;
events { worker_connections 64; }
http {
  access_log off;
  server { listen 19201; location /api/boom { return 500 "x"; } location / { return 200 "hello"; } }
}
stream {
  server { listen 19202; return "pong"; }
  server { listen 19203; return "tls"; }
}
`, 'utf8');
    writeFileSync(join(dir, 'probe.sh'), `
      for i in 1 2 3 4 5; do curl -s -o /dev/null -H 'Host: a.test' http://127.0.0.1:${HTTP}/api/x; done
      curl -s -o /dev/null -H 'Host: a.test' http://127.0.0.1:${HTTP}/api/boom
      curl -s -o /dev/null -H 'Host: a.test' http://127.0.0.1:${HTTP}/old/y
      curl -s -o /dev/null -H 'Host: other.test' http://127.0.0.1:${HTTP}/
      for i in 1 2 3; do echo hi | socat -t1 - TCP:127.0.0.1:${TCP} >/dev/null; done
      echo | timeout 3 openssl s_client -connect 127.0.0.1:${PT} -servername s.test >/dev/null 2>&1
      sleep 0.3
      echo "---http---"; curl -s http://127.0.0.1:18969/dump; echo
      echo "---stream---"; socat -t1 - TCP:127.0.0.1:18968 </dev/null; echo
      echo "---errorlog---"; tail -5 /w/logs/error.log
    `, 'utf8');
    const out = execFileSync('docker', [
      'run', '--rm', '-v', `${dir}:/w:Z`, '--entrypoint', '/bin/sh', toolsImage(), '-c',
      '/usr/local/openresty/bin/openresty -p /w -c back.conf & sleep 1; '
      + '/usr/local/openresty/bin/openresty -p /w -c conf/nginx.conf & sleep 1.5; '
      + 'sh /w/probe.sh',
    ], { encoding: 'utf8', timeout: 180_000 });
    if (process.env['BARY_DEBUG'] === '1') console.log(out);
    const http = out.split('---http---')[1]?.split('---stream---')[0] ?? '';
    const stream = out.split('---stream---')[1]?.split('---errorlog---')[0] ?? '';
    return { http: parseTrafficDump(http.trim()), stream: parseTrafficDump(stream.trim()), raw: out };
  } finally {
    dropScratch(dir);
  }
}

const find = (cs: TrafficCounter[], kind: TrafficCounter['kind'], id: string): TrafficCounter['values'] =>
  cs.find((c) => c.kind === kind && c.id === id)?.values ?? {};

describe('트래픽 카운터 — 실물 엔진 (골든)', () => {
  let got: ReturnType<typeof run>;
  beforeAll(() => {
    if (!dockerAvailable()) throw new Error('도커가 없다 — 골든은 실물 엔진으로만 잰다');
    got = run();
  }, 200_000);

  it('리스너는 모든 요청을 센다 — 라우트 · 리다이렉트 · 기본 동작', () => {
    const l = find(got.http, 'listener', 'web:front');
    expect(l.n, got.raw).toBe(8);
    expect(l.s2, got.raw).toBe(6); // /api/x 5 + 기본 동작 1
    expect(l.s3, got.raw).toBe(1); // /old/ 301
    expect(l.s5, got.raw).toBe(1); // /api/boom
    expect(l.bo ?? 0).toBeGreaterThan(0);
    expect(l.bi ?? 0).toBeGreaterThan(0);
  });

  it('라우트는 자기 요청만 센다', () => {
    expect(find(got.http, 'route', 'api').n, got.raw).toBe(6);
    expect(find(got.http, 'route', 'old').n, got.raw).toBe(1);
  });

  it('풀과 백엔드를 센다 — error_page 가 가로챈 500 도 백엔드에 남는다', () => {
    const peer = got.http.filter((c) => c.kind === 'backend' && c.peer === '127.0.0.1:19201');
    const total = peer.reduce((a, c) => a + (c.values.n ?? 0), 0);
    expect(total, got.raw).toBe(7);
    expect(find(got.http, 'pool', upstreamName('app')).n ?? 0, got.raw).toBeGreaterThanOrEqual(6);
  });

  it('stream — tcp 리스너와 패스스루 라우트를 센다', () => {
    expect(find(got.stream, 'listener', 'raw').n, got.raw).toBe(3);
    expect(find(got.stream, 'pool', upstreamName('echo')).n, got.raw).toBe(3);
    expect(find(got.stream, 'listener', 'pt').n, got.raw).toBe(1);
    expect(find(got.stream, 'route', 'pt:s').n, got.raw).toBe(1);
  });

  it('오류 로그에 Lua 오류가 없다', () => {
    const log = got.raw.split('---errorlog---')[1] ?? '';
    expect(log).not.toMatch(/lua entry thread aborted|runtime error/);
  });
});
