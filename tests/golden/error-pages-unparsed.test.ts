/**
 * **URI 를 못 읽은 요청의 오류 페이지** — 실물 엔진으로 잰다 (2026-11-22, 운영 web-01).
 *
 * 인터넷 스캐너가 HTTP 가 아닌 것(`*1`, NTLM, Kafka 핸드셰이크, 명령 주입 문자열)을 보내면 nginx 는 요청 줄을 읽다가
 * 400 을 만든다. 오류 페이지는 named location(`@bary_err_html`)이다. 그런데 그 요청에는 **URI 가 없다** — nginx 는
 * URI 가 빈 요청을 named location 으로 못 보낸다(`empty URI in redirect to named location`). 오류 로그에 `[error]` 를
 * 남기고 요청을 다른 상태로 끝낸다.
 *
 * 지키는 것:
 *   · 깨진 요청 줄 · 너무 긴 요청 줄은 400 · 414 와 자체 오류 페이지를 받는다 — http 와 https 모두
 *   · SNI 를 보낸 https 에서도 400 이다(421 가드가 다시 걸리지 않는다)
 *   · 출발지 제한이 있는 리스너는 거부한 출발지에 여전히 아무것도 주지 않는다(444)
 *   · 오류 로그에 `empty URI` 가 없다
 *   · 정상 요청의 오류 페이지(404)는 그대로다
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { dropScratch } from '../scratch.js';
import { toolsImage } from './tools-image.js';
import { render } from '../../src/conf/render.js';
import type { Model } from '../../src/model/provisional.js';

const HTTPS = 18995;
const HTTP = 18996;
const DENY = 18997;
const V = 'f'.repeat(32);

function dockerAvailable(): boolean {
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }); return true; } catch { return false; }
}

const model: Model = {
  listeners: [
    { key: 'tls', protocol: 'https', bind: '0.0.0.0', port: HTTPS, enabled: true, hosts: ['a.test'],
      tls: { policy: 'p', defaultCertificate: 'c' }, http: { defaultAction: 'reject' } },
    { key: 'plain', protocol: 'http', bind: '0.0.0.0', port: HTTP, enabled: true, http: { defaultAction: 'reject' } },
    { key: 'deny', protocol: 'http', bind: '0.0.0.0', port: DENY, enabled: true, sourceAllow: ['192.0.2.0/24'],
      http: { defaultAction: 'reject' } },
  ],
  httpRoutes: [
    { key: 'nf', listener: 'plain', hosts: ['a.test'], priority: 1, pathPrefix: '/nope', action: { kind: 'reject', status: 404 } },
    { key: 'nf-tls', listener: 'tls', hosts: ['a.test'], priority: 1, pathPrefix: '/nope', action: { kind: 'reject', status: 404 } },
  ],
  passthroughRoutes: [], pools: [], backends: [],
  certificates: [{ key: 'c', materialRef: `store://c@${V}`, chainDigest: `sha256:${'0'.repeat(64)}`, keyDigest: `sha256:${'1'.repeat(64)}` }],
  tlsPolicies: [{ key: 'p', minVersion: '1.2', sniHostMismatch: 'reject_421' }],
  sniBindings: [],
};

const caps = { httpLua: true, streamLua: false, streamRealip: false, sslConfCommand: true, http2: true, sslRejectHandshake: true };

/** 날것을 보내고 상태 줄과 본문 일부를 받는다. `-` 는 응답이 없었다는 뜻이다. */
const PROBE = `
raw() { printf "$2" | socat -t2 - TCP:127.0.0.1:$1 2>/dev/null | head -c 4000 | tr -d '\\r' > /tmp/out.$3; }
tls() { printf "$1" | timeout 5 openssl s_client -quiet -connect 127.0.0.1:${HTTPS} -servername a.test 2>/dev/null | head -c 4000 | tr -d '\\r' > /tmp/out.$2; }
show() { echo "$1.status=$(head -1 /tmp/out.$1 | cut -c1-40)"; echo "$1.page=$(grep -c 'Bad request\\|Address too long\\|Page not found' /tmp/out.$1)"; }
raw ${HTTP} '*1\\r\\n$4\\r\\nPING\\r\\n' redis; show redis
raw ${HTTP} '\\x16\\x03\\x01\\x00\\xa5\\x01\\x00\\x00\\xa1random1random2\\r\\n\\r\\n' bin; show bin
raw ${HTTP} "GET /$(head -c 20000 /dev/zero | tr '\\000' a) HTTP/1.1\\r\\nHost: a.test\\r\\n\\r\\n" long; show long
tls '*1\\r\\n$4\\r\\nPING\\r\\n' tlsjunk; show tlsjunk
raw ${DENY} '*1\\r\\n\\r\\n' deny; echo "deny.status=$(head -1 /tmp/out.deny | cut -c1-40)"; echo "deny.bytes=$(wc -c < /tmp/out.deny)"
raw ${HTTP} 'GET /nope HTTP/1.1\\r\\nHost: a.test\\r\\nConnection: close\\r\\n\\r\\n' ok; show ok
tls 'GET /nope HTTP/1.1\\r\\nHost: a.test\\r\\nConnection: close\\r\\n\\r\\n' tls404; show tls404
sleep 0.3
echo "emptyuri=$(grep -c 'empty URI' /w/logs/error.log)"
echo "---errorlog---"; grep -E '\\[(error|crit|alert|emerg)\\]' /w/logs/error.log | tail -8
`;

function run(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bary-errpage-'));
  chmodSync(dir, 0o777);
  try {
    mkdirSync(join(dir, 'conf'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    // 오류 로그를 info 로 연다 — 깨진 요청 줄은 info 로만 남지만 named location 실패는 error 다.
    writeFileSync(join(dir, 'conf', 'nginx.conf'), `daemon off;\nerror_log logs/error.log info;\n${render(model, caps).conf}`, 'utf8');
    writeFileSync(join(dir, 'probe.sh'), PROBE, 'utf8');
    return execFileSync('docker', ['run', '--rm', '-v', `${dir}:/w:Z`, '--entrypoint', '/bin/sh', toolsImage(), '-c',
      `mkdir -p /w/conf/certs/c/${V} && openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=a.test" `
      + `-addext "subjectAltName=DNS:a.test" -keyout /w/conf/certs/c/${V}/privkey.pem -out /w/conf/certs/c/${V}/fullchain.pem >/dev/null 2>&1; `
      + '/usr/local/openresty/bin/openresty -p /w -c conf/nginx.conf -t >/w/t.log 2>&1 || cat /w/t.log; '
      + '/usr/local/openresty/bin/openresty -p /w -c conf/nginx.conf & sleep 1.5; sh /w/probe.sh'],
    { encoding: 'utf8', timeout: 180_000 });
  } finally {
    dropScratch(dir);
  }
}

describe('URI 를 못 읽은 요청의 오류 페이지 — 실물 엔진 (골든)', () => {
  let out = '';
  beforeAll(() => {
    if (!dockerAvailable()) throw new Error('도커가 없다 — 골든은 실물 엔진으로만 잰다');
    out = run();
    if (process.env['BARY_DEBUG'] === '1') console.log(out);
  }, 200_000);
  const val = (k: string): string => out.split('\n').find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim() ?? '';

  it('깨진 요청 줄 — 400 과 자체 오류 페이지 (http)', () => {
    for (const k of ['redis', 'bin']) {
      expect(val(`${k}.status`), out).toBe('HTTP/1.1 400 Bad Request');
      expect(val(`${k}.page`), out).toBe('1');
    }
  });

  it('너무 긴 요청 줄 — 414 와 자체 오류 페이지', () => {
    expect(val('long.status'), out).toBe('HTTP/1.1 414 Request-URI Too Large');
    expect(val('long.page'), out).toBe('1');
  });

  it('SNI 를 보낸 https 의 깨진 요청 — 421 이 아니라 400', () => {
    expect(val('tlsjunk.status'), out).toBe('HTTP/1.1 400 Bad Request');
    expect(val('tlsjunk.page'), out).toBe('1');
  });

  it('거부한 출발지에는 여전히 아무것도 주지 않는다', () => {
    expect(val('deny.bytes'), out).toBe('0');
  });

  it('정상 요청의 오류 페이지는 그대로다', () => {
    expect(val('ok.status'), out).toBe('HTTP/1.1 404 Not Found');
    expect(val('ok.page'), out).toBe('1');
    expect(val('tls404.status'), out).toBe('HTTP/1.1 404 Not Found');
  });

  it('오류 로그에 empty URI 가 없다', () => {
    expect(val('emptyuri'), out).toBe('0');
  });
});
