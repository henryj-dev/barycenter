/**
 * HTTP/3 (QUIC) — 실물 엔진으로 잰다 (2026-11-22). 렌더 규칙은 `tests/unit/http3.test.ts` 가 잰다.
 *
 * 여기서 재는 것:
 *   · 엔진이 그 conf 를 받는다 — `listen … quic` 이 TCP `listen … ssl` · `default_server` 와 함께 선다
 *   · 같은 포트가 **UDP 로도** 열린다(S20.udp_occupancy) — 방화벽이 열어야 하는 것이 이것이다
 *   · TCP 응답에 `Alt-Svc` 가 나간다 — 없으면 브라우저가 h3 로 안 옮긴다
 *   · 안 켜면 UDP 도 `Alt-Svc` 도 없다
 *
 * 도구 이미지의 curl 은 HTTP/3 를 못 한다(nghttp3 없음). h3 요청 자체는 여기서 안 보낸다 — 할 수 있으면 보낸다.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { render } from '../../src/conf/render.js';
import type { Model } from '../../src/model/provisional.js';
import { dropScratch } from '../scratch.js';
import { toolsImage } from './tools-image.js';

const PORT = 18943;
const V = 'a'.repeat(32);

function dockerAvailable(): boolean {
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }); return true; } catch { return false; }
}

const model = (http3: boolean): Model => ({
  listeners: [{
    key: 'l', protocol: 'https', bind: '0.0.0.0', port: PORT, enabled: true, hosts: ['a.test'],
    tls: { policy: 'p', defaultCertificate: 'c' }, http: { defaultAction: 'reject' },
    ...(http3 ? { http3: true } : {}),
  }],
  httpRoutes: [{ key: 'ok', listener: 'l', hosts: ['a.test'], priority: 10, action: { kind: 'redirect', to: 'https://x/', status: 302 } }],
  passthroughRoutes: [], pools: [], backends: [],
  certificates: [{ key: 'c', materialRef: `store://c@${V}`, chainDigest: `sha256:${'0'.repeat(64)}`, keyDigest: `sha256:${'1'.repeat(64)}` }],
  tlsPolicies: [{ key: 'p', minVersion: '1.2' }],
  sniBindings: [{ key: 'b', listener: 'l', hosts: ['a.test'], certificate: 'c' }],
});

const caps = { httpLua: false, streamLua: false, streamRealip: true, sslConfCommand: true, sslRejectHandshake: true, http2: true, http3: true };

const PROBE = `
hex=$(printf '%04X' ${PORT})
echo "udp=$(grep -c ":$hex " /proc/net/udp /proc/net/udp6 2>/dev/null | awk -F: '{s+=$2} END {print s+0}')"
echo "tcp=$(grep -c ":$hex " /proc/net/tcp 2>/dev/null)"
echo "alt=$(curl -sk -o /dev/null -D - --resolve a.test:${PORT}:127.0.0.1 "https://a.test:${PORT}/" 2>/dev/null \\
  | tr -d '\\r' | sed -n 's/^[Aa]lt-[Ss]vc: //p')"
if curl --version | grep -q HTTP3; then
  echo "h3=$(curl -sk --http3-only -o /dev/null -w '%{http_version} %{http_code}' --resolve a.test:${PORT}:127.0.0.1 "https://a.test:${PORT}/")"
else
  echo "h3=skip"
fi
`;

function serve(conf: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bary-h3-'));
  chmodSync(dir, 0o777);
  try {
    mkdirSync(join(dir, 'conf'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(join(dir, 'conf', 'nginx.conf'), `daemon off;\n${conf}`, 'utf8');
    writeFileSync(join(dir, 'probe.sh'), PROBE, 'utf8');
    return execFileSync('docker',
      ['run', '--rm', '-v', `${dir}:/prefix:Z`, '--entrypoint', '/bin/sh', toolsImage(), '-c',
        `mkdir -p /prefix/conf/certs/c/${V} && ` +
        'openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=a.test" ' +
        '-addext "subjectAltName=DNS:a.test" ' +
        `-keyout /prefix/conf/certs/c/${V}/privkey.pem ` +
        `-out /prefix/conf/certs/c/${V}/fullchain.pem >/dev/null 2>&1; ` +
        '/usr/local/openresty/bin/openresty -p /prefix -c conf/nginx.conf -t >/prefix/t.log 2>&1; echo "t=$?"; ' +
        '/usr/local/openresty/bin/openresty -p /prefix -c conf/nginx.conf & sleep 1.5; ' +
        'sh /prefix/probe.sh; echo "emerg=$(grep -c "\\[emerg\\]" /prefix/logs/error.log)"; cat /prefix/t.log'],
      { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  } finally {
    dropScratch(dir);
  }
}

describe('HTTP/3 — 실물 엔진', () => {
  let on = '';
  let off = '';

  beforeAll(() => {
    if (!dockerAvailable()) return;
    on = serve(render(model(true), caps).conf);
    off = serve(render(model(false), caps).conf);
  }, 300_000);

  const val = (out: string, k: string): string =>
    out.split('\n').find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim() ?? '';

  it.runIf(dockerAvailable())('엔진이 conf 를 받는다 — quic · ssl · default_server 가 함께 선다', () => {
    expect(val(on, 't'), on).toBe('0');
    expect(val(on, 'emerg'), on).toBe('0');
  });

  it.runIf(dockerAvailable())('**같은 포트가 UDP 로도 열린다** — 방화벽이 열어야 하는 것', () => {
    expect(Number(val(on, 'udp')), on).toBeGreaterThan(0);
    expect(Number(val(on, 'tcp')), on).toBeGreaterThan(0);
  });

  it.runIf(dockerAvailable())('TCP 응답에 Alt-Svc 가 나간다', () => {
    expect(val(on, 'alt'), on).toBe(`h3=":${PORT}"; ma=86400`);
  });

  it.runIf(dockerAvailable())('h3 로 답한다 (curl 이 HTTP/3 를 할 때만)', () => {
    const h3 = val(on, 'h3');
    if (h3 === 'skip') return;
    expect(h3, on).toBe('3 302');
  });

  it.runIf(dockerAvailable())('안 켜면 UDP 도 Alt-Svc 도 없다', () => {
    expect(val(off, 't'), off).toBe('0');
    expect(val(off, 'udp'), off).toBe('0');
    expect(val(off, 'alt'), off).toBe('');
  });
});
