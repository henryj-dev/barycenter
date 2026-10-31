/**
 * HTTPS 리스너의 평문 리다이렉트를 **실물 nginx 로** 잰다 (2026-10-31).
 *
 * 재는 것:
 *   · 평문으로 온 요청이 `301 https://<이름>:<HTTPS 포트><경로?쿼리>` 로 간다
 *   · ACME 확인 경로는 리다이렉트보다 앞서 Lua 가 답한다(토큰이 없으면 404) — http-01 은 평문으로 온다
 *   · 호스트 리스너만 있는 평문 소켓에서 모르는 이름은 끊긴다(444)
 *   · HTTPS 쪽은 그대로 동작한다
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { ACME_PREFIX, render } from '../../src/conf/render.js';
import type { Model } from '../../src/model/provisional.js';
import { dropScratch } from '../scratch.js';

const IMAGE = process.env['BARY_ENGINE_IMAGE'] ?? 'docker.io/openresty/openresty:alpine';
const TLS_PORT = 18941;
const PLAIN_PORT = 18942;
const V = 'a'.repeat(32);

function dockerAvailable(): boolean {
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }); return true; } catch { return false; }
}

const model: Model = {
  listeners: [
    { key: 'ta', protocol: 'https', bind: '0.0.0.0', port: TLS_PORT, enabled: true, hosts: ['a.test'],
      tls: { policy: 'p', defaultCertificate: 'ca' }, http: { defaultAction: 'reject' }, http2: false,
      httpRedirect: { port: PLAIN_PORT } },
  ],
  httpRoutes: [
    { key: 'ra', listener: 'ta', hosts: ['a.test'], priority: 0, action: { kind: 'redirect', to: 'https://served-over-tls/', status: 302 } },
  ],
  passthroughRoutes: [], pools: [], backends: [],
  certificates: [{ key: 'ca', materialRef: `store://ca@${V}`, chainDigest: `sha256:${'0'.repeat(64)}`, keyDigest: `sha256:${'1'.repeat(64)}` }],
  tlsPolicies: [{ key: 'p', minVersion: '1.2' }],
  sniBindings: [],
};

const PROBE = `
hdr() { curl -s -o /dev/null -D - --resolve "$1:${PLAIN_PORT}:127.0.0.1" "http://$1:${PLAIN_PORT}$2" 2>/dev/null | tr -d '\\r'; }
echo "plain_status=$(hdr a.test '/x/y?q=1' | sed -n '1s/^HTTP[^ ]* \\([0-9]*\\).*/\\1/p')"
echo "plain_location=$(hdr a.test '/x/y?q=1' | sed -n 's/^[Ll]ocation: //p')"
echo "acme_status=$(curl -s -o /dev/null -w '%{http_code}' --resolve a.test:${PLAIN_PORT}:127.0.0.1 http://a.test:${PLAIN_PORT}${ACME_PREFIX}tok)"
curl -s -o /dev/null --resolve nobody.test:${PLAIN_PORT}:127.0.0.1 http://nobody.test:${PLAIN_PORT}/ 2>/dev/null; echo "plain_unknown_exit=$?"
echo "tls_location=$(curl -sk -o /dev/null -D - --resolve a.test:${TLS_PORT}:127.0.0.1 https://a.test:${TLS_PORT}/ 2>/dev/null | tr -d '\\r' | sed -n 's/^[Ll]ocation: //p')"
`;

function serve(conf: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bary-redirect-'));
  chmodSync(dir, 0o777);
  try {
    mkdirSync(join(dir, 'conf'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(join(dir, 'conf', 'nginx.conf'), `daemon off;\n${conf}`, 'utf8');
    writeFileSync(join(dir, 'probe.sh'), PROBE, 'utf8');
    const mk = `mkdir -p /prefix/conf/certs/ca/${V} && openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=a.test" `
      + `-addext "subjectAltName=DNS:a.test" -keyout /prefix/conf/certs/ca/${V}/privkey.pem `
      + `-out /prefix/conf/certs/ca/${V}/fullchain.pem >/dev/null 2>&1; `;
    return execFileSync('docker',
      ['run', '--rm', '-v', `${dir}:/prefix:Z`, '--entrypoint', '/bin/sh', IMAGE, '-c',
        'apk add --no-cache openssl curl >/dev/null 2>&1 || { echo "설치 실패 (망?)" >&2; exit 70; }; ' + mk
        + '/usr/local/openresty/bin/openresty -p /prefix -c conf/nginx.conf & sleep 1.5; '
        + 'sh /prefix/probe.sh; echo "---errorlog---"; tail -5 /prefix/logs/error.log'],
      { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  } finally {
    dropScratch(dir);
  }
}

describe('HTTPS 리다이렉트 — 실물 nginx', () => {
  let out = '';
  beforeAll(() => {
    if (!dockerAvailable()) return;
    out = serve(render(model, { streamRealip: false, httpLua: true, streamLua: false, sslRejectHandshake: true }).conf);
  }, 300_000);
  const val = (k: string): string => out.split('\n').find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim() ?? '';

  it.runIf(dockerAvailable())('평문 요청은 같은 이름 · 경로 · 쿼리로 HTTPS 에 301 한다', () => {
    expect(val('plain_status'), out).toBe('301');
    expect(val('plain_location'), out).toBe(`https://a.test:${TLS_PORT}/x/y?q=1`);
  });

  it.runIf(dockerAvailable())('ACME 확인 경로는 리다이렉트하지 않고 Lua 가 답한다(토큰 없음 → 404)', () => {
    expect(val('acme_status'), out).toBe('404');
  });

  it.runIf(dockerAvailable())('모르는 이름은 평문 소켓에서도 끊긴다(444)', () => {
    expect(val('plain_unknown_exit'), out).toBe('52');
  });

  it.runIf(dockerAvailable())('HTTPS 쪽은 그대로 라우트를 탄다', () => {
    expect(val('tls_location'), out).toBe('https://served-over-tls/');
  });
});
