/**
 * 프록시 라우트의 요청 헤더와 경로 바꾸기 — **엔진이 실제로 그렇게 보내는가** (골든, #109)
 *
 * 렌더가 서는 것으로는 부족하다. 셋을 실제 OpenResty 에서 잰다:
 *   ① `rewritePrefix` — `/api/users?x=1` 이 업스트림에 `/v1/users?x=1` 로 가는가
 *   ② 라우트 `Host` — 업스트림이 `api.example.com` 하나만 받는가
 *   ③ 같은 이름의 리스너 헤더 — 라우트 값 **하나만** 가는가. nginx 는 같은 이름을 둘 다
 *      보내므로(실측) 렌더가 리스너 줄을 빼야 한다
 * 그리고 옵션이 없는 라우트는 옛 동작 그대로인가(경로 그대로, 클라이언트 Host, 리스너 헤더).
 *
 * 업스트림은 렌더한 설정 안에 붙인 에코 서버다. 받은 URI 와 헤더를 그대로 돌려준다.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { dropScratch } from '../scratch.js';
import { render } from '../../src/conf/render.js';
import type { Model } from '../../src/model/provisional.js';

const IMAGE = process.env['BARY_ENGINE_IMAGE'] ?? 'docker.io/openresty/openresty:alpine';
const P = 18971;     // 리스너
const ECHO = 18972;  // 업스트림 에코

function dockerAvailable(): boolean {
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }); return true; } catch { return false; }
}

const caps = { httpLua: false, streamLua: false, streamRealip: true, sslConfCommand: true };

const model: Model = {
  listeners: [{
    key: 'web', protocol: 'http', bind: '0.0.0.0', port: P, enabled: true,
    http: {
      defaultAction: 'reject',
      headers: { request: [{ name: 'X-Tenant', value: 'listener' }] },
    },
  }],
  httpRoutes: [
    { key: 'api', listener: 'web', hosts: ['a.test'], priority: 0, pathPrefix: '/api/',
      action: {
        kind: 'proxy', pool: 'echo', websocket: false, rewritePrefix: '/v1/',
        requestHeaders: [{ name: 'Host', value: 'api.example.com' }, { name: 'X-Tenant', value: 'route' }],
      } },
    { key: 'plain', listener: 'web', hosts: ['a.test'], priority: 0, pathPrefix: '/plain/',
      action: { kind: 'proxy', pool: 'echo', websocket: false } },
  ],
  passthroughRoutes: [],
  pools: [{ key: 'echo', protocolClass: 'http', algorithm: 'round_robin' }],
  backends: [{ key: 'e', pool: 'echo', host: '127.0.0.1', port: ECHO, weight: 1 }],
  certificates: [], tlsPolicies: [], sniBindings: [],
};

/** 에코 서버를 http 블록 맨 앞에 붙인다. 같은 헤더가 여럿이면 `|` 로 잇는다. */
const ECHO_SERVER = `
    server {
        listen ${ECHO};
        location / {
            content_by_lua_block {
                local function one(v) if type(v) == "table" then return table.concat(v, "|") end return v or "-" end
                local h = ngx.req.get_headers()
                ngx.say("URI=", ngx.var.request_uri)
                ngx.say("HOST=", one(h["host"]))
                ngx.say("TENANT=", one(h["x-tenant"]))
            }
        }
    }
`;

const PROBE = `
echo "--api"; curl -s -m 3 -H 'Host: a.test' 'http://127.0.0.1:${P}/api/users?x=1'
echo "--plain"; curl -s -m 3 -H 'Host: a.test' 'http://127.0.0.1:${P}/plain/users?x=1'
`;

function serve(conf: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bary-rp-'));
  chmodSync(dir, 0o777);
  try {
    mkdirSync(join(dir, 'conf'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(join(dir, 'conf', 'nginx.conf'), `daemon off;\n${conf}`, 'utf8');
    writeFileSync(join(dir, 'probe.sh'), PROBE, 'utf8');
    return execFileSync('docker', [
      'run', '--rm', '-v', `${dir}:/w:Z`, '--entrypoint', '/bin/sh', IMAGE, '-c',
      'apk add --no-cache curl >/dev/null 2>&1; ' +
      '/usr/local/openresty/bin/openresty -p /w -c conf/nginx.conf -t 2>&1 | tail -1; ' +
      '/usr/local/openresty/bin/openresty -p /w -c conf/nginx.conf & sleep 1.5; ' +
      'sh /w/probe.sh; echo "---errorlog---"; tail -3 /w/logs/error.log',
    ], { encoding: 'utf8', timeout: 180_000 });
  } finally {
    dropScratch(dir);
  }
}

describe('프록시 라우트 옵션이 실제 엔진에서 걸린다 (#109)', () => {
  let out = '';
  const section = (name: string): string => {
    const at = out.indexOf(`--${name}\n`);
    expect(at, `--${name} 이 없다:\n${out}`).toBeGreaterThan(-1);
    const rest = out.slice(at + name.length + 3);
    const end = rest.search(/\n--|\n---errorlog/);
    return end < 0 ? rest : rest.slice(0, end);
  };

  beforeAll(() => {
    if (!dockerAvailable()) throw new Error('도커가 없다 — 골든은 실물 엔진으로만 잰다');
    const conf = render(model, caps).conf.replace(/\nhttp \{\n/, `\nhttp {\n${ECHO_SERVER}`);
    expect(conf).toContain(`listen ${ECHO};`);
    out = serve(conf);
  }, 240_000);

  it('설정이 선다 (`nginx -t`)', () => {
    expect(out).toMatch(/test is successful/);
  });

  it('① 맞은 접두사를 바꿔 보낸다 — 질의 문자열은 그대로', () => {
    expect(section('api')).toContain('URI=/v1/users?x=1');
  });

  it('② 라우트의 Host 하나만 간다', () => {
    expect(section('api')).toMatch(/^HOST=api\.example\.com$/m);
  });

  it('③ 같은 이름의 리스너 헤더 대신 라우트 값 하나만 간다', () => {
    // 리스너 값이 같이 갔다면 `TENANT=listener|route` 였다.
    expect(section('api')).toMatch(/^TENANT=route$/m);
  });

  it('옵션이 없는 라우트는 옛 동작 그대로다', () => {
    const s = section('plain');
    expect(s).toContain('URI=/plain/users?x=1');
    expect(s).toContain('HOST=a.test');
    expect(s).toContain('TENANT=listener');
  });
});
