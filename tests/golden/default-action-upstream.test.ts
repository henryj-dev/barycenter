/**
 * 기본 동작 · 실패한 요청의 inflight · 백엔드 상태 표시 — 실물 엔진 (골든, 2026-11-21)
 *
 * 세 가지를 잰다.
 *
 *   1. **실패한 요청의 `in:` 이 내려간다.** 백엔드에 못 붙으면 nginx 가 502 를 만들고 `error_page` 로 내부
 *      리다이렉트한다. 리다이렉트는 `ngx.ctx` 를 비운다. 고른 peer 를 ctx 에만 두면 log 단계가 그것을 못 찾고
 *      `in:` 이 영영 안 내려간다 — **하필 실패한 요청에서** 샌다. 그러면 `least_conn` 이 그 peer 를 피하고, 드레인은
 *      quiesced 를 영영 못 본다. 풀 트래픽 카운터도 같은 이유로 그 요청을 놓쳤다.
 *   2. **기본 동작도 HTTP/1.1 과 업그레이드 헤더를 보낸다.** 라우트 없이 기본 풀로 보내는 리스너에서 웹소켓이
 *      안 열렸다 — `Upgrade` · `Connection` 이 백엔드로 안 갔다.
 *   3. **백엔드가 무엇을 줬는지 보인다.** `X-Bary-Upstream-Status` 헤더와, 엔진이 만든 오류 페이지의 한 줄.
 *      백엔드에 안 간 요청(라우트 거부)에는 둘 다 없다.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { dropScratch } from '../scratch.js';
import { toolsImage } from './tools-image.js';
import { render, upstreamName } from '../../src/conf/render.js';
import { parseTrafficDump, trafficDumpLua } from '../../src/conf/traffic.js';
import type { Model } from '../../src/model/provisional.js';

const ON = { httpLua: true, streamLua: true, streamRealip: false, sslConfCommand: true, headersMore: true };
const WEB = 18971;
const DEAD = 18972;
const LIVE = 19241;
/** 아무도 안 듣는 포트 — nginx 가 만드는 502 를 부른다. */
const CLOSED = 19242;

function dockerAvailable(): boolean {
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }); return true; } catch { return false; }
}

const model: Model = {
  listeners: [
    // 라우트 없이 기본 풀로 보낸다 — 가장 흔한 모양이다.
    { key: 'web', protocol: 'http', bind: '0.0.0.0', port: WEB, enabled: true, http: { defaultAction: { pool: 'live' } } },
    { key: 'dead', protocol: 'http', bind: '0.0.0.0', port: DEAD, enabled: true, http: { defaultAction: { pool: 'gone' } } },
  ],
  httpRoutes: [
    { key: 'deny', listener: 'web', hosts: ['a.test'], priority: 10, pathPrefix: '/deny', action: { kind: 'reject', status: 403 } },
  ],
  passthroughRoutes: [],
  pools: [
    { key: 'live', protocolClass: 'http', algorithm: 'round_robin' },
    { key: 'gone', protocolClass: 'http', algorithm: 'round_robin' },
  ],
  backends: [
    { key: 'live-1', pool: 'live', host: '127.0.0.1', port: LIVE, weight: 1 },
    { key: 'gone-1', pool: 'gone', host: '127.0.0.1', port: CLOSED, weight: 1 },
  ],
  certificates: [], tlsPolicies: [], sniBindings: [],
};

type Got = { raw: string; part: (name: string) => string };

function run(): Got {
  const dir = mkdtempSync(join(tmpdir(), 'bary-default-up-'));
  chmodSync(dir, 0o777);
  try {
    mkdirSync(join(dir, 'conf'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    const seed = `init_worker_by_lua_block {
      ngx.shared.bary_http:set("slot:${upstreamName('live')}:0", "127.0.0.1:${LIVE}")
      ngx.shared.bary_http:set("slot:${upstreamName('gone')}:0", "127.0.0.1:${CLOSED}")
    }
    server { listen 18979;
      location = /in { content_by_lua_block { ngx.print(tostring(ngx.shared.bary_http:get("in:" .. ngx.var.arg_peer))) } }
      location = /dump { content_by_lua_block { ${trafficDumpLua('http')} } }
    }`;
    const conf = render(model, ON).conf.replace(/^(http \{)/m, `$1\n${seed}`);
    writeFileSync(join(dir, 'conf', 'nginx.conf'), `daemon off;\nworker_processes 2;\n${conf}`, 'utf8');
    // 백엔드는 받은 것을 그대로 말한다 — 프로토콜 판과 두 헤더.
    writeFileSync(join(dir, 'back.conf'), `daemon off;
error_log logs/b.log warn;
pid logs/b.pid;
events { worker_connections 64; }
http {
  access_log off;
  server { listen ${LIVE};
    location /boom { return 500 "backend-own-500"; }
    location / { return 200 "proto=$server_protocol upgrade=$http_upgrade connection=$http_connection"; }
  }
}
`, 'utf8');
    writeFileSync(join(dir, 'probe.sh'), `
      W=http://127.0.0.1:${WEB}; D=http://127.0.0.1:${DEAD}
      echo "---ws---"; curl -s -H 'Upgrade: websocket' -H 'Connection: Upgrade' $W/chat
      echo; echo "---plain---"; curl -s $W/x
      echo; echo "---okhdr---"; curl -s -D - -o /dev/null $W/x | tr -d '\\r' | grep -i '^x-bary-upstream-status' || echo none
      echo "---ownhdr---"; curl -s -D - -o /dev/null $W/boom | tr -d '\\r' | grep -i '^x-bary-upstream-status' || echo none
      echo "---ownbody---"; curl -s $W/boom
      echo; echo "---denyhdr---"; curl -s -D - -o /dev/null -H 'Host: a.test' $W/deny/x | tr -d '\\r' | grep -i '^x-bary-upstream-status' || echo none
      echo "---denybody---"; curl -s -H 'Host: a.test' $W/deny/x | grep -c 'Upstream' || true
      echo "---deadcode---"; for i in 1 2 3; do curl -s -o /dev/null -w '%{http_code} ' $D/; done
      echo; echo "---deadhdr---"; curl -s -D - -o /dev/null $D/ | tr -d '\\r' | grep -i '^x-bary-upstream-status' || echo none
      echo "---deadbody---"; curl -s $D/ | grep -o 'Upstream[^<]*<code>[^<]*</code>' || echo none
      echo "---deadjson---"; curl -s -H 'Accept: application/json' $D/
      sleep 0.3
      echo; echo "---in---"; curl -s "http://127.0.0.1:18979/in?peer=127.0.0.1:${CLOSED}"
      echo; echo "---dump---"; curl -s http://127.0.0.1:18979/dump
      echo; echo "---errorlog---"; grep -E '\\[(error|crit|alert|emerg)\\]' /w/logs/error.log | grep -v 'connect() failed' | tail -5
      echo "---end---"
    `, 'utf8');
    const out = execFileSync('docker', [
      'run', '--rm', '-v', `${dir}:/w:Z`, '--entrypoint', '/bin/sh', toolsImage(), '-c',
      '/usr/local/openresty/bin/openresty -p /w -c back.conf & sleep 1; '
      + '/usr/local/openresty/bin/openresty -p /w -c conf/nginx.conf & sleep 1.5; '
      + 'sh /w/probe.sh',
    ], { encoding: 'utf8', timeout: 180_000 });
    if (process.env['BARY_DEBUG'] === '1') console.log(out);
    const part = (name: string): string => (out.split(`---${name}---`)[1]?.split('\n---')[0] ?? '').trim();
    return { raw: out, part };
  } finally {
    dropScratch(dir);
  }
}

describe('기본 동작 · 실패한 요청 · 백엔드 상태 — 실물 엔진 (골든)', () => {
  let got: Got;
  beforeAll(() => {
    if (!dockerAvailable()) throw new Error('도커가 없다 — 골든은 실물 엔진으로만 잰다');
    got = run();
  }, 200_000);

  it('실패한 요청(엔진이 만든 502 → error_page)의 `in:` 이 0 으로 돌아온다', () => {
    expect(got.part('deadcode'), got.raw).toBe('502 502 502');
    // 고친 뒤에는 0 이다. 고치기 전에는 요청마다 하나씩 쌓여 3(이상)이었다.
    expect(got.part('in'), got.raw).toBe('0');
  });

  it('풀 카운터도 실패한 요청을 센다', () => {
    const dump = parseTrafficDump(got.part('dump'));
    const pool = dump.find((c) => c.kind === 'pool' && c.id === upstreamName('gone'));
    // 502 세 번 + 헤더 · 본문 · JSON 확인 세 번 = 여섯
    expect(pool?.values.n, got.raw).toBe(6);
    expect(pool?.values.s5, got.raw).toBe(6);
  });

  it('기본 동작이 HTTP/1.1 과 업그레이드 헤더를 백엔드로 보낸다', () => {
    expect(got.part('ws'), got.raw).toBe('proto=HTTP/1.1 upgrade=websocket connection=upgrade');
    // 업그레이드를 안 물은 요청에는 Upgrade 가 안 간다.
    expect(got.part('plain'), got.raw).toBe('proto=HTTP/1.1 upgrade= connection=');
  });

  it('`X-Bary-Upstream-Status` — 백엔드에 간 응답에만 붙는다', () => {
    expect(got.part('okhdr').toLowerCase(), got.raw).toBe('x-bary-upstream-status: 200');
    expect(got.part('ownhdr').toLowerCase(), got.raw).toBe('x-bary-upstream-status: 500');
    expect(got.part('deadhdr').toLowerCase(), got.raw).toBe('x-bary-upstream-status: 502');
    expect(got.part('denyhdr'), got.raw).toBe('none');
  });

  it('백엔드가 보낸 오류 본문은 그대로다', () => {
    expect(got.part('ownbody'), got.raw).toBe('backend-own-500');
  });

  it('엔진이 만든 오류 페이지가 백엔드 상태를 한 줄로 말한다 — 백엔드에 안 간 오류에는 없다', () => {
    expect(got.part('deadbody'), got.raw).toBe('Upstream <code>502</code>');
    expect(got.part('deadjson'), got.raw).toContain('"upstream_status":"502"');
    expect(got.part('denybody'), got.raw).toBe('0');
  });

  it('오류 로그에 Lua 오류가 없다', () => {
    expect(got.part('errorlog'), got.raw).toBe('');
  });
});
