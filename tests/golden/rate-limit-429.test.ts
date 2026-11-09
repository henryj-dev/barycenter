/**
 * **제한에 걸린 요청은 429 다** — 실제 엔진이 내는 응답으로 판정한다 (DESIGN.md §4.10 「응답 이름과 오류 페이지」)
 *
 * nginx 기본은 503 이다. 렌더러가 `limit_req_status 429` · `limit_conn_status 429` 를 낸다. 여기서 지키는 것:
 *
 *   1. 속도 제한(`limit_req`)과 연결 제한(`limit_conn`)에 걸리면 **429** 다 — 503 이 아니다.
 *   2. 본문은 **자체 오류 페이지**(429 문구)다 — 엔진 기본 페이지가 아니다.
 *   3. **HSTS · 사용자 응답 헤더가 그대로다** — `Retry-After` 를 server 레벨에 더해도 대체 함정에 안 걸린다.
 *   4. `Retry-After: 1` 은 **엔진이 낸 429 에만** 붙는다. 통과한 응답에도, 백엔드가 보낸 429 에도 안 붙는다.
 *
 * 백엔드는 같은 컨테이너의 두 번째 openresty 다. `/slow` 는 2 초 걸리고(연결 제한을 재려고), `/own429` 는 자기 429 를 낸다.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { dropScratch } from '../scratch.js';
import { toolsImage } from './tools-image.js';
import { render, type RenderCapabilities } from '../../src/conf/render.js';
import type { Model, RateLimit } from '../../src/model/provisional.js';

const PORT = 18951;
const BACKEND = 18952;
const V = 'f'.repeat(32);

function dockerAvailable(): boolean {
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }); return true; } catch { return false; }
}

const model = (rateLimit: RateLimit): Model => ({
  listeners: [{
    key: 'l', protocol: 'https', bind: '0.0.0.0', port: PORT, enabled: true,
    tls: { policy: 'p', defaultCertificate: 'c' },
    http: {
      defaultAction: 'reject',
      headers: { response: [{ name: 'X-Frame-Options', value: 'DENY' }] },
      rateLimit,
    },
  }],
  httpRoutes: [{ key: 'r', listener: 'l', hosts: ['a.test'], priority: 10,
    action: { kind: 'proxy', pool: 'app', websocket: false } }],
  passthroughRoutes: [],
  pools: [{ key: 'app', protocolClass: 'http', algorithm: 'round_robin' }],
  backends: [{ key: 'b', pool: 'app', host: '127.0.0.1', port: BACKEND, weight: 1 }],
  certificates: [{ key: 'c', materialRef: `store://c@${V}`,
    chainDigest: `sha256:${'0'.repeat(64)}`, keyDigest: `sha256:${'1'.repeat(64)}` }],
  tlsPolicies: [{ key: 'p', minVersion: '1.2', hsts: { maxAgeSeconds: 600 } }],
  sniBindings: [{ key: 'b', listener: 'l', hosts: ['a.test'], certificate: 'c' }],
});

const caps: RenderCapabilities = { httpLua: false, streamLua: false, streamRealip: true, sslConfCommand: true };

/** 백엔드 — `/slow` 는 2 초 뒤 200, `/own429` 는 자기 429, 나머지는 200. */
const BACKEND_CONF = `daemon on; pid logs/b.pid; error_log logs/b.log;
events {}
http { server { listen ${BACKEND};
  location /slow { content_by_lua_block { ngx.sleep(2) ngx.say("slow-ok") } }
  location /own429 { default_type text/plain; return 429 "backend-own-429"; }
  location / { default_type text/plain; return 200 "ok"; }
} }
`;

/** 한 요청 — `KEY|상태|HSTS|XFO|Retry-After|본문 표식` 한 줄. */
const ONE = `
one() {  # one <key> <path>
  curl -sk -o /tmp/body.$1 -D /tmp/hdr.$1 -H "Accept: text/html" --resolve a.test:${PORT}:127.0.0.1 "https://a.test:${PORT}$2" 2>/dev/null
  h() { tr -d '\\r' < /tmp/hdr.$1 | grep -i "^$2:" | head -1 | sed 's/^[^:]*: //'; }
  st=$(head -1 /tmp/hdr.$1 | awk '{print $2}')
  mark=$(grep -o '<p class="code">[0-9]*</p>\\|backend-own-429\\|slow-ok\\|openresty\\|^ok' /tmp/body.$1 | head -1)
  echo "$1|$st|$(h $1 strict-transport-security)|$(h $1 x-frame-options)|$(h $1 retry-after)|$mark"
}
`;

function serve(conf: string, probe: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bary-rl429-'));
  chmodSync(dir, 0o777);
  try {
    mkdirSync(join(dir, 'conf'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(join(dir, 'conf', 'nginx.conf'), `daemon off;\n${conf}`, 'utf8');
    writeFileSync(join(dir, 'conf', 'backend.conf'), BACKEND_CONF, 'utf8');
    writeFileSync(join(dir, 'probe.sh'), ONE + probe, 'utf8');
    return execFileSync('docker',
      ['run', '--rm', '-v', `${dir}:/prefix:Z`, '--entrypoint', '/bin/sh', toolsImage(), '-c',
        `mkdir -p /prefix/conf/certs/c/${V} && ` +
        'openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=a.test" ' +
        '-addext "subjectAltName=DNS:a.test" ' +
        `-keyout /prefix/conf/certs/c/${V}/privkey.pem ` +
        `-out /prefix/conf/certs/c/${V}/fullchain.pem >/dev/null 2>&1; ` +
        '/usr/local/openresty/bin/openresty -p /prefix -c conf/backend.conf; ' +
        '/usr/local/openresty/bin/openresty -p /prefix -c conf/nginx.conf & sleep 1.5; ' +
        'sh /prefix/probe.sh; echo "---errorlog---"; grep -v "limiting " /prefix/logs/error.log | tail -3'],
      { encoding: 'utf8', timeout: 180_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } finally {
    dropScratch(dir);
  }
}

type Row = { status: string; hsts: string; xfo: string; retry: string; mark: string };
const rows = (out: string): Row[] => out.split('\n').filter((l) => l.includes('|')).map((l) => {
  const [, status, hsts, xfo, retry, mark] = l.split('|');
  return { status: status!, hsts: hsts!, xfo: xfo!, retry: retry!, mark: mark! };
});

describe('제한에 걸린 요청은 429 다 — 엔진이 내는 응답으로 판정한다', () => {
  let req: Row[] = [];
  let conn: Row[] = [];
  let reqOut = '';
  let connOut = '';

  beforeAll(() => {
    if (!dockerAvailable()) throw new Error('도커가 없다 — 골든은 실물 엔진으로만 잰다');
    // 초당 1 개에 여덟 번. 첫 번째만 통과한다(burst 없음). 마지막은 백엔드의 429 다.
    reqOut = serve(render(model({ requestsPerSecond: 1 }), caps).conf, `
      for i in 1 2 3 4 5 6 7 8; do one r$i /; done
      sleep 1.2; one own /own429
    `);
    req = rows(reqOut);
    // 연결 하나. 느린 요청이 연결을 잡고 있는 동안 두 번째가 온다.
    connOut = serve(render(model({ maxConnections: 1 }), caps).conf, `
      one slow /slow > /tmp/slow.row &
      sleep 0.5; one c2 /
      wait; cat /tmp/slow.row
    `);
    conn = rows(connOut);
  }, 360_000);

  it('속도 제한에 걸리면 429 다 — 503 이 아니다', () => {
    const limited = req.slice(0, 8);
    expect(limited[0]?.status, reqOut).toBe('200');
    expect(limited.filter((r) => r.status === '429').length, reqOut).toBeGreaterThan(0);
    expect(req.some((r) => r.status === '503'), reqOut).toBe(false);
  });

  it('연결 제한에 걸려도 429 다', () => {
    expect(conn.find((r) => r.mark === 'slow-ok')?.status, connOut).toBe('200');
    expect(conn.filter((r) => r.status === '429').length, connOut).toBe(1);
    expect(conn.some((r) => r.status === '503'), connOut).toBe(false);
  });

  it('429 본문은 자체 오류 페이지다 — 엔진 기본 페이지가 아니다', () => {
    for (const r of [...req, ...conn].filter((x) => x.status === '429' && x.mark !== 'backend-own-429')) {
      expect(r.mark, `${reqOut}\n${connOut}`).toBe('<p class="code">429</p>');
    }
  });

  it('**HSTS · 사용자 응답 헤더가 429 에도 그대로다**', () => {
    for (const r of [...req, ...conn]) {
      expect(r.hsts, `${reqOut}\n${connOut}`).toBe('max-age=600');
      expect(r.xfo, `${reqOut}\n${connOut}`).toBe('DENY');
    }
  });

  it('`Retry-After: 1` 은 엔진이 낸 429 에만 붙는다 — 통과한 응답 · 백엔드의 429 에는 없다', () => {
    for (const r of [...req, ...conn]) {
      const engine429 = r.status === '429' && r.mark === '<p class="code">429</p>';
      expect(r.retry, `${reqOut}\n${connOut}`).toBe(engine429 ? '1' : '');
    }
    const own = req.find((r) => r.mark === 'backend-own-429');
    expect(own?.status, reqOut).toBe('429');
    expect(own?.retry, reqOut).toBe('');
  });
});
