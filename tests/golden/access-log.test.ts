/**
 * 액세스 로그가 **실물 엔진에서** 적힌다 (2026-11-22, 골든).
 *
 * `nginx -t` 는 Lua 를 안 본다(E64). 게다가 log 단계의 Lua 는 `pcall` 로 감쌌다 — 깨져도 요청은 멀쩡하고
 * 고리만 빈다. 그래서 요청을 흘리고 고리를 읽어 칸을 하나씩 본다.
 *
 * 덤프는 admin 조각과 **같은 Lua**(`accessDumpLua`)로 읽는다.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { dropScratch } from '../scratch.js';
import { toolsImage } from './tools-image.js';
import { render, upstreamName } from '../../src/conf/render.js';
import { accessDumpLua, parseAccessDump, type AccessDump } from '../../src/conf/access-log.js';
import type { Model } from '../../src/model/provisional.js';

const ON = { httpLua: true, streamLua: true, streamRealip: false, sslConfCommand: true };
const HTTP = 18971;
const TCP = 18972;
const PT = 18973;

function dockerAvailable(): boolean {
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }); return true; } catch { return false; }
}

const model: Model = {
  listeners: [
    { key: 'web', protocol: 'http', bind: '0.0.0.0', port: HTTP, enabled: true, http: { defaultAction: 'reject' } },
    { key: 'raw', protocol: 'tcp', bind: '0.0.0.0', port: TCP, enabled: true, defaultPool: 'echo' },
    { key: 'pt', protocol: 'tls_passthrough', bind: '0.0.0.0', port: PT, enabled: true },
  ],
  httpRoutes: [
    { key: 'api', listener: 'web', hosts: ['a.test'], priority: 10, pathPrefix: '/api/', action: { kind: 'proxy', pool: 'app', websocket: false } },
  ],
  passthroughRoutes: [{ key: 'pt:s', listener: 'pt', snis: ['s.test'], priority: 1, action: { kind: 'proxy', pool: 'tls' } }],
  pools: [
    { key: 'app', protocolClass: 'http', algorithm: 'round_robin' },
    { key: 'echo', protocolClass: 'tcp', algorithm: 'round_robin' },
    { key: 'tls', protocolClass: 'tcp', algorithm: 'round_robin' },
  ],
  backends: [
    { key: 'app-1', pool: 'app', host: '127.0.0.1', port: 19211, weight: 1 },
    { key: 'echo-1', pool: 'echo', host: '127.0.0.1', port: 19212, weight: 1 },
    { key: 'tls-1', pool: 'tls', host: '127.0.0.1', port: 19213, weight: 1 },
  ],
  certificates: [], tlsPolicies: [], sniBindings: [],
};

type Got = { http: AccessDump | undefined; httpAfter: AccessDump | undefined; stream: AccessDump | undefined; raw: string };

function run(): Got {
  const dir = mkdtempSync(join(tmpdir(), 'bary-access-'));
  chmodSync(dir, 0o777);
  try {
    mkdirSync(join(dir, 'conf'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    const rendered = render(model, ON).conf;
    const httpSeed = `init_worker_by_lua_block {
      ngx.shared.bary_http:set("slot:${upstreamName('app')}:0", "127.0.0.1:19211")
    }
    server { listen 18979; location = /dump { content_by_lua_block {
      local after = ngx.var.arg_after
      ${accessDumpLua('http')}
    } } }`;
    const streamSeed = `init_worker_by_lua_block {
      ngx.shared.bary_stream:set("slot:${upstreamName('echo')}:0", "127.0.0.1:19212")
      ngx.shared.bary_stream:set("slot:${upstreamName('tls')}:0", "127.0.0.1:19213")
    }
    server { listen 18978; content_by_lua_block {
      local sock = assert(ngx.req.socket())
      local after = sock:receive("*l")
      ${accessDumpLua('stream')}
    } }`;
    const conf = rendered
      .replace(/^(http \{)/m, `$1\n${httpSeed}`)
      .replace(/^(stream \{)/m, `$1\n${streamSeed}`);
    writeFileSync(join(dir, 'conf', 'nginx.conf'), `daemon off;\nworker_processes 2;\n${conf}`, 'utf8');
    writeFileSync(join(dir, 'back.conf'), `daemon off;
error_log logs/b.log warn;
pid logs/b.pid;
events { worker_connections 64; }
http {
  access_log off;
  server { listen 19211; location /api/boom { return 503 "x"; } location / { return 200 "hello"; } }
}
stream {
  server { listen 19212; return "pong"; }
  server { listen 19213; return "tls"; }
}
`, 'utf8');
    writeFileSync(join(dir, 'probe.sh'), `
      curl -s -o /dev/null -H 'Host: a.test' -A 'probe/1' -e 'https://ref.test/p?secret=1' -H 'X-Forwarded-For: 203.0.113.9' 'http://127.0.0.1:${HTTP}/api/x?token=abc'
      curl -s -o /dev/null -H 'Host: a.test' http://127.0.0.1:${HTTP}/api/boom
      curl -s -o /dev/null -H 'Host: other.test' http://127.0.0.1:${HTTP}/nothing
      echo hi | socat -t1 - TCP:127.0.0.1:${TCP} >/dev/null
      echo | timeout 3 openssl s_client -connect 127.0.0.1:${PT} -servername s.test >/dev/null 2>&1
      sleep 0.3
      echo "---http---"; curl -s 'http://127.0.0.1:18979/dump?after=0'; echo
      echo "---after---"; curl -s 'http://127.0.0.1:18979/dump?after=2'; echo
      echo "---stream---"; printf '0\\n' | socat -t1 - TCP:127.0.0.1:18978; echo
      echo "---errorlog---"; tail -5 /w/logs/error.log
    `, 'utf8');
    const out = execFileSync('docker', [
      'run', '--rm', '-v', `${dir}:/w:Z`, '--entrypoint', '/bin/sh', toolsImage(), '-c',
      '/usr/local/openresty/bin/openresty -p /w -c back.conf & sleep 1; '
      + '/usr/local/openresty/bin/openresty -p /w -c conf/nginx.conf & sleep 1.5; '
      + 'sh /w/probe.sh',
    ], { encoding: 'utf8', timeout: 180_000 });
    if (process.env['BARY_DEBUG'] === '1') console.log(out);
    const part = (a: string, b: string): string => out.split(a)[1]?.split(b)[0]?.trim() ?? '';
    return {
      http: parseAccessDump(part('---http---', '---after---')),
      httpAfter: parseAccessDump(part('---after---', '---stream---')),
      stream: parseAccessDump(part('---stream---', '---errorlog---')),
      raw: out,
    };
  } finally {
    dropScratch(dir);
  }
}

describe('액세스 로그 — 실물 엔진 (골든)', () => {
  let got: Got;
  beforeAll(() => {
    if (!dockerAvailable()) throw new Error('도커가 없다 — 골든은 실물 엔진으로만 잰다');
    got = run();
  }, 200_000);

  it('http — 요청마다 한 줄, 순번 차례로', () => {
    expect(got.http, got.raw).toBeDefined();
    expect(got.http!.seq, got.raw).toBe(3);
    expect(got.http!.boot).not.toBe('-');
    expect(got.http!.entries.map((e) => e.q)).toEqual([1, 2, 3]);
  });

  it('http — 프록시한 요청의 칸. 쿼리는 빠진다', () => {
    const e = got.http!.entries[0]!;
    expect(e, got.raw).toMatchObject({
      l: 'web', r: 'api', p: upstreamName('app'), m: 'GET', h: 'a.test', u: '/api/x', s: 200, us: 200,
      ua: '127.0.0.1:19211', ag: 'probe/1', rf: 'https://ref.test/p', xf: '203.0.113.9', c: '127.0.0.1', pr: 'HTTP/1.1',
    });
    expect(e.id).toMatch(/^[0-9a-f]{32}$/);
    expect(e.t).toBeGreaterThan(1_700_000_000);
    expect(e.bi ?? 0).toBeGreaterThan(0);
    expect(e.bo ?? 0).toBeGreaterThan(0);
    expect(typeof e.d).toBe('number');
    expect(typeof e.uh).toBe('number');
    expect(JSON.stringify(got.http)).not.toContain('token=abc');
    expect(JSON.stringify(got.http)).not.toContain('secret=1');
  });

  it('http — 백엔드가 준 503 · 맞는 라우트가 없는 요청', () => {
    expect(got.http!.entries[1], got.raw).toMatchObject({ r: 'api', s: 503, us: 503 });
    const miss = got.http!.entries[2]!;
    expect(miss, got.raw).toMatchObject({ l: 'web', h: 'other.test' });
    expect(miss.r).toBeUndefined();
    expect(miss.us).toBeUndefined();
    expect(miss.ua).toBeUndefined();
  });

  it('after 뒤의 줄만 준다', () => {
    expect(got.httpAfter!.entries.map((e) => e.q), got.raw).toEqual([3]);
  });

  it('stream — tcp 리스너와 패스스루 라우트', () => {
    const s = got.stream!;
    expect(s.entries.length, got.raw).toBe(2);
    expect(s.entries[0], got.raw).toMatchObject({ l: 'raw', p: upstreamName('echo'), ua: '127.0.0.1:19212', tr: 'tcp' });
    expect(s.entries[1], got.raw).toMatchObject({ l: 'pt', r: 'pt:s', sni: 's.test', ua: '127.0.0.1:19213' });
  });

  it('오류 로그에 Lua 오류가 없다', () => {
    const log = got.raw.split('---errorlog---')[1] ?? '';
    expect(log).not.toMatch(/lua entry thread aborted|runtime error/);
  });
});
