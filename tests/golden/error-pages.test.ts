/**
 * **응답 이름과 오류 페이지** — 실제 엔진이 내는 응답으로 판정한다 (DESIGN.md §4.10, 2026-11-08)
 *
 * 렌더 산출물을 openresty 로 띄우고 curl 로 잰다. 네 가지를 지킨다:
 *
 *   1. `Server: barycenter/<버전>` (headers-more 가 있을 때). 없으면 `server_tokens off` 만 — 버전이 빠진다.
 *   2. nginx 가 **스스로 만든** 오류(502 · 403 · 404 · 503)는 자체 페이지가 되고 **상태 코드는 그대로**다.
 *   3. **업스트림이 보낸 오류는 그대로 통과한다** — 상태도 본문도 형식도.
 *   4. **응답 헤더가 그대로다** — HSTS · 사용자 응답 헤더가 오류 페이지에도 붙는다(`add_header` 대체 함정).
 *
 * 백엔드는 같은 컨테이너의 두 번째 openresty 다 — 자기 502 본문을 낸다. 닫힌 포트(127.0.0.1:1)는 nginx 가 만드는
 * 502 를 부른다.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { dropScratch } from '../scratch.js';
import { toolsImage } from './tools-image.js';
import { render, type RenderCapabilities } from '../../src/conf/render.js';
import { SERVED_BY_FILE, servedByFragment } from '../../src/conf/served-by.js';
import type { Model } from '../../src/model/provisional.js';

const PORT = 18991;
const BACKEND = 18992;
const V = 'e'.repeat(32);
const VERSION = '9.9.9-test';
const ALIAS = 'golden-a1';

function dockerAvailable(): boolean {
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }); return true; } catch { return false; }
}

const model: Model = {
  listeners: [{
    key: 'l', protocol: 'https', bind: '0.0.0.0', port: PORT, enabled: true,
    tls: { policy: 'p', defaultCertificate: 'c' },
    http: {
      defaultAction: 'reject',
      headers: { response: [{ name: 'X-Frame-Options', value: 'DENY' }] },
    },
  }],
  httpRoutes: [
    { key: 'own', listener: 'l', hosts: ['a.test'], priority: 10, pathPrefix: '/own',
      action: { kind: 'proxy', pool: 'live', websocket: false } },
    { key: 'dead', listener: 'l', hosts: ['a.test'], priority: 10, pathPrefix: '/dead',
      action: { kind: 'proxy', pool: 'gone', websocket: false } },
    { key: 'deny', listener: 'l', hosts: ['a.test'], priority: 10, pathPrefix: '/deny',
      action: { kind: 'reject', status: 403 } },
    { key: 'nf', listener: 'l', hosts: ['a.test'], priority: 10, pathPrefix: '/missing',
      action: { kind: 'reject', status: 404 } },
    // 출발지 규칙의 프록시 — `error_page 570 = @…` 로 named location 에 넘어간 뒤 난 502 (recursive_error_pages).
    { key: 'rule', listener: 'l', hosts: ['a.test'], priority: 10, pathPrefix: '/rule',
      action: { kind: 'reject', status: 403 },
      sourceRules: [{ from: ['0.0.0.0/0'], action: { kind: 'proxy', pool: 'gone', websocket: false } }] },
  ],
  passthroughRoutes: [],
  pools: [
    { key: 'live', protocolClass: 'http', algorithm: 'round_robin' },
    { key: 'gone', protocolClass: 'http', algorithm: 'round_robin' },
  ],
  backends: [
    { key: 'b1', pool: 'live', host: '127.0.0.1', port: BACKEND, weight: 1 },
    { key: 'b2', pool: 'gone', host: '127.0.0.1', port: 1, weight: 1 },
  ],
  certificates: [{ key: 'c', materialRef: `store://c@${V}`,
    chainDigest: `sha256:${'0'.repeat(64)}`, keyDigest: `sha256:${'1'.repeat(64)}` }],
  tlsPolicies: [{ key: 'p', minVersion: '1.2', hsts: { maxAgeSeconds: 600 } }],
  sniBindings: [{ key: 'b', listener: 'l', hosts: ['a.test'], certificate: 'c' }],
};

const base: RenderCapabilities = { httpLua: false, streamLua: false, streamRealip: true, sslConfCommand: true };

/** 백엔드 — 자기 오류 본문을 내는 두 번째 엔진. */
const BACKEND_CONF = `daemon on; pid logs/b.pid; error_log logs/b.log;
events {}
http { server { listen ${BACKEND}; location / { default_type text/plain; return 502 "backend-own-502"; } } }
`;

/** 한 요청 — `KEY|상태|형식|Server|HSTS|XFO|본문 표식|바이트|X-Served-By|본문의 노드 이름` 한 줄. */
const PROBE = `
one() {  # one <key> <path> [accept]
  acc=\${3:-text/html}
  curl -sk -o /tmp/body -D /tmp/hdr -H "Accept: $acc" --resolve a.test:${PORT}:127.0.0.1 "https://a.test:${PORT}$2" 2>/dev/null
  h() { tr -d '\\r' < /tmp/hdr | grep -i "^$1:" | head -1 | sed 's/^[^:]*: //'; }
  st=$(head -1 /tmp/hdr | awk '{print $2}')
  mark=$(grep -o '<p class="code">[0-9]*</p>\\|backend-own-502\\|"status":[0-9]*\\|openresty' /tmp/body | head -1)
  bytes=$(wc -c < /tmp/body | tr -d ' ')
  sby=$(grep -c '<code>${ALIAS}</code>\\|"served_by":"${ALIAS}"' /tmp/body)
  echo "$1|$st|$(h content-type)|$(h server)|$(h strict-transport-security)|$(h x-frame-options)|$mark|$bytes|$(h x-served-by)|$sby"
}
one own /own
one dead /dead
one deny /deny
one nf /missing
one rule /rule
one json /dead application/json
`;

/** `servedBy` 가 있으면 노드가 세대에 쓰는 조각(`admin/served-by.map`)을 같은 자리에 둔다. */
function serve(conf: string, servedBy?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bary-errpage-'));
  chmodSync(dir, 0o777);
  try {
    mkdirSync(join(dir, 'conf'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(join(dir, 'conf', 'nginx.conf'), `daemon off;\n${conf}`, 'utf8');
    writeFileSync(join(dir, 'conf', 'backend.conf'), BACKEND_CONF, 'utf8');
    if (servedBy !== undefined) {
      mkdirSync(join(dir, 'conf', 'admin'), { recursive: true });
      writeFileSync(join(dir, 'conf', SERVED_BY_FILE), servedByFragment(servedBy), 'utf8');
    }
    writeFileSync(join(dir, 'probe.sh'), PROBE, 'utf8');
    return execFileSync('docker',
      ['run', '--rm', '-v', `${dir}:/prefix:Z`, '--entrypoint', '/bin/sh', toolsImage(), '-c',
        `mkdir -p /prefix/conf/certs/c/${V} && ` +
        'openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=a.test" ' +
        '-addext "subjectAltName=DNS:a.test" ' +
        `-keyout /prefix/conf/certs/c/${V}/privkey.pem ` +
        `-out /prefix/conf/certs/c/${V}/fullchain.pem >/dev/null 2>&1; ` +
        '/usr/local/openresty/bin/openresty -p /prefix -c conf/backend.conf; ' +
        '/usr/local/openresty/bin/openresty -p /prefix -c conf/nginx.conf & sleep 1.5; ' +
        'sh /prefix/probe.sh; echo "---errorlog---"; grep -v "connect() failed" /prefix/logs/error.log | tail -3'],
      { encoding: 'utf8', timeout: 180_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } finally {
    dropScratch(dir);
  }
}

type Row = {
  status: string; type: string; server: string; hsts: string; xfo: string; mark: string; bytes: number;
  servedBy: string; servedInBody: number;
};
const rows = (out: string): Map<string, Row> => new Map(out.split('\n').filter((l) => l.includes('|')).map((l) => {
  const [k, status, type, server, hsts, xfo, mark, bytes, servedBy, sby] = l.split('|');
  return [k!, { status: status!, type: type!, server: server!, hsts: hsts!, xfo: xfo!, mark: mark!, bytes: Number(bytes),
    servedBy: servedBy!, servedInBody: Number(sby) }];
}));

describe('응답 이름과 오류 페이지 — 엔진이 내는 응답으로 판정한다', () => {
  let out = '';
  let plain = '';
  let r = new Map<string, Row>();
  let p = new Map<string, Row>();
  let named = '';
  let n = new Map<string, Row>();
  let namedPlain = '';
  let np = new Map<string, Row>();

  beforeAll(() => {
    if (!dockerAvailable()) return;
    out = serve(render(model, { ...base, headersMore: true, serverVersion: VERSION }).conf);
    plain = serve(render(model, base).conf);
    r = rows(out);
    p = rows(plain);
    // 같은 렌더 결과 + 노드 조각. 렌더 입력에는 노드 이름이 없다 — digest 가 노드마다 같다.
    named = serve(render(model, { ...base, headersMore: true, serverVersion: VERSION }).conf, ALIAS);
    namedPlain = serve(render(model, base).conf, ALIAS);
    n = rows(named);
    np = rows(namedPlain);
  }, 600_000);

  it.runIf(dockerAvailable())('노드 조각이 없으면 `X-Served-By` 도 본문의 노드 이름도 없다 (기본은 끈다)', () => {
    for (const [k, row] of r) {
      expect(row.servedBy, `${k}\n${out}`).toBe('');
      expect(row.servedInBody, `${k}\n${out}`).toBe(0);
    }
  });

  it.runIf(dockerAvailable())('노드 조각이 있으면 모든 응답에 `X-Served-By: <별칭>` — 업스트림 오류 · 정상 응답 포함', () => {
    for (const k of ['own', 'dead', 'deny', 'nf', 'rule', 'json']) {
      expect(n.get(k)?.servedBy, `${k}\n${named}`).toBe(ALIAS);
    }
    expect(named).not.toMatch(/\[emerg\]|\[alert\]/);
  });

  it.runIf(dockerAvailable())('엔진이 만든 오류 페이지 · JSON 에 노드 이름이 붙는다 — 업스트림 본문은 손대지 않는다', () => {
    for (const k of ['dead', 'deny', 'nf', 'rule', 'json']) {
      expect(n.get(k)?.servedInBody, `${k}\n${named}`).toBe(1);
    }
    expect(n.get('own')?.servedInBody, named).toBe(0);
    expect(n.get('own')?.mark, named).toBe('backend-own-502');
  });

  it.runIf(dockerAvailable())('headers-more 가 없으면 헤더는 없고 오류 페이지에만 나간다', () => {
    expect(np.get('dead')?.servedBy, namedPlain).toBe('');
    expect(np.get('dead')?.servedInBody, namedPlain).toBe(1);
  });

  it.runIf(dockerAvailable())('`Server: barycenter/<버전>` — 정상 응답과 오류 응답 모두', () => {
    for (const k of ['own', 'dead', 'deny', 'nf', 'rule', 'json']) {
      expect(r.get(k)?.server, `${k}\n${out}`).toBe(`barycenter/${VERSION}`);
    }
  });

  it.runIf(dockerAvailable())('headers-more 가 없다고 하면 `server_tokens off` 만 — 엔진 이름은 남고 버전은 빠진다', () => {
    expect(p.get('dead')?.server, plain).toBe('openresty');
    expect(p.get('dead')?.mark, plain).toBe('<p class="code">502</p>');
  });

  it.runIf(dockerAvailable())('nginx 가 만든 502 · 403 · 404 는 자체 페이지가 되고 **상태 코드는 그대로**다', () => {
    const want: [string, string][] = [['dead', '502'], ['deny', '403'], ['nf', '404'], ['rule', '502']];
    for (const [k, code] of want) {
      const row = r.get(k);
      expect(row?.status, `${k}\n${out}`).toBe(code);
      expect(row?.type, `${k}\n${out}`).toBe('text/html; charset=utf-8');
      expect(row?.mark, `${k}\n${out}`).toBe(`<p class="code">${code}</p>`);
      // 페이지당 수 KB — 자체 포함이라 이것이 전부다.
      expect(row?.bytes, `${k}\n${out}`).toBeLessThan(6000);
    }
  });

  it.runIf(dockerAvailable())('**업스트림이 보낸 오류는 그대로 통과한다** — 상태 · 본문 · 형식', () => {
    const own = r.get('own');
    expect(own?.status, out).toBe('502');
    expect(own?.mark, out).toBe('backend-own-502');
    expect(own?.type, out).toBe('text/plain');
  });

  it.runIf(dockerAvailable())('`Accept: application/json` 이면 짧은 JSON — 상태는 그대로', () => {
    const j = r.get('json');
    expect(j?.status, out).toBe('502');
    expect(j?.type, out).toBe('application/json');
    expect(j?.mark, out).toBe('"status":502');
  });

  it.runIf(dockerAvailable())('**HSTS · 사용자 응답 헤더가 오류 페이지에도 그대로다** — named location 이 add_header 를 안 갖는다', () => {
    for (const k of ['own', 'dead', 'deny', 'nf', 'rule', 'json']) {
      expect(r.get(k)?.hsts, `${k}\n${out}`).toBe('max-age=600');
      expect(r.get(k)?.xfo, `${k}\n${out}`).toBe('DENY');
    }
  });

  it.runIf(dockerAvailable())('엔진 기본 오류 페이지(엔진 이름이 든 본문)가 어디에도 안 나간다', () => {
    for (const [k, row] of r) expect(row.mark, `${k}\n${out}`).not.toBe('openresty');
    expect(out).not.toMatch(/\[emerg\]|\[alert\]|could not find named location/);
  });
});
