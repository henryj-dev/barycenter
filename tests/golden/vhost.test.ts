/**
 * 호스트 리스너를 **실물 nginx 로** 잰다 (ADR-VHOST, 2026-10-31).
 *
 * 렌더 문자열이 맞아 보여도 nginx 가 같은 `listen` 의 server 여럿을 어떻게 고르는지는 실행해야 안다.
 *
 * 재는 것:
 *   · HTTPS — 같은 포트의 두 호스트 리스너가 이름마다 **자기 인증서**와 **자기 응답**을 낸다
 *   · HTTPS — 모르는 이름은 핸드셰이크에서 끊긴다(어느 인증서도 안 나간다, `ssl_reject_handshake`)
 *   · HTTP  — 같은 포트의 두 호스트 리스너가 이름마다 자기 응답, 모르는 이름은 444(빈 응답)
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { render } from '../../src/conf/render.js';
import type { Model } from '../../src/model/provisional.js';
import { dropScratch } from '../scratch.js';

const IMAGE = process.env['BARY_ENGINE_IMAGE'] ?? 'docker.io/openresty/openresty:alpine';
const TLS_PORT = 18931;
const PLAIN_PORT = 18932;
const V = 'a'.repeat(32);

function dockerAvailable(): boolean {
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }); return true; } catch { return false; }
}

const cert = (key: string) => ({
  key, materialRef: `store://${key}@${V}`, chainDigest: `sha256:${'0'.repeat(64)}`, keyDigest: `sha256:${'1'.repeat(64)}`,
});
const redirect = (key: string, listener: string, host: string, to: string) => ({
  key, listener, hosts: [host], priority: 0, action: { kind: 'redirect' as const, to, status: 302 as const },
});

const model: Model = {
  listeners: [
    { key: 'ta', protocol: 'https', bind: '0.0.0.0', port: TLS_PORT, enabled: true, hosts: ['a.test'],
      tls: { policy: 'p', defaultCertificate: 'ca' }, http: { defaultAction: 'reject' }, http2: false },
    { key: 'tb', protocol: 'https', bind: '0.0.0.0', port: TLS_PORT, enabled: true, hosts: ['b.test'],
      tls: { policy: 'p', defaultCertificate: 'cb' }, http: { defaultAction: 'reject' }, http2: false },
    { key: 'pa', protocol: 'http', bind: '0.0.0.0', port: PLAIN_PORT, enabled: true, hosts: ['a.test'], http: { defaultAction: 'reject' } },
    { key: 'pb', protocol: 'http', bind: '0.0.0.0', port: PLAIN_PORT, enabled: true, hosts: ['b.test'], http: { defaultAction: 'reject' } },
  ],
  httpRoutes: [
    redirect('ra', 'ta', 'a.test', 'https://from-a/'),
    redirect('rb', 'tb', 'b.test', 'https://from-b/'),
    redirect('qa', 'pa', 'a.test', 'http://plain-a/'),
    redirect('qb', 'pb', 'b.test', 'http://plain-b/'),
  ],
  passthroughRoutes: [], pools: [], backends: [],
  certificates: [cert('ca'), cert('cb')],
  tlsPolicies: [{ key: 'p', minVersion: '1.2' }],
  sniBindings: [],
};

const PROBE = `
loc() { curl -sk -o /dev/null -D - --resolve "$1:$2:127.0.0.1" "$3://$1:$2/" 2>/dev/null | tr -d '\\r' | sed -n 's/^[Ll]ocation: //p'; }
cn() { echo | openssl s_client -connect 127.0.0.1:${TLS_PORT} -servername "$1" 2>/dev/null | openssl x509 -noout -subject 2>/dev/null | sed 's/.*CN *= *//'; }
echo "tls_a=$(loc a.test ${TLS_PORT} https)"
echo "tls_b=$(loc b.test ${TLS_PORT} https)"
echo "cn_a=$(cn a.test)"
echo "cn_b=$(cn b.test)"
echo "cn_unknown=$(cn nobody.test)"
curl -sk -o /dev/null --resolve nobody.test:${TLS_PORT}:127.0.0.1 https://nobody.test:${TLS_PORT}/ 2>/dev/null; echo "tls_unknown_exit=$?"
echo "plain_a=$(loc a.test ${PLAIN_PORT} http)"
echo "plain_b=$(loc b.test ${PLAIN_PORT} http)"
curl -s -o /dev/null --resolve nobody.test:${PLAIN_PORT}:127.0.0.1 http://nobody.test:${PLAIN_PORT}/ 2>/dev/null; echo "plain_unknown_exit=$?"
`;

function serve(conf: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bary-vhost-'));
  chmodSync(dir, 0o777);
  try {
    mkdirSync(join(dir, 'conf'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(join(dir, 'conf', 'nginx.conf'), `daemon off;\n${conf}`, 'utf8');
    writeFileSync(join(dir, 'probe.sh'), PROBE, 'utf8');
    const mk = (key: string, cn: string): string =>
      `mkdir -p /prefix/conf/certs/${key}/${V} && openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=${cn}" ` +
      `-addext "subjectAltName=DNS:${cn}" -keyout /prefix/conf/certs/${key}/${V}/privkey.pem ` +
      `-out /prefix/conf/certs/${key}/${V}/fullchain.pem >/dev/null 2>&1; `;
    return execFileSync('docker',
      ['run', '--rm', '-v', `${dir}:/prefix:Z`, '--entrypoint', '/bin/sh', IMAGE, '-c',
        'apk add --no-cache openssl curl >/dev/null 2>&1 || { echo "설치 실패 (망?)" >&2; exit 70; }; ' +
        mk('ca', 'a.test') + mk('cb', 'b.test') +
        '/usr/local/openresty/bin/openresty -p /prefix -c conf/nginx.conf & sleep 1.5; ' +
        'sh /prefix/probe.sh; echo "---errorlog---"; tail -5 /prefix/logs/error.log'],
      { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  } finally {
    dropScratch(dir);
  }
}

describe('호스트 리스너 — 실물 nginx', () => {
  let out = '';
  beforeAll(() => {
    if (!dockerAvailable()) return;
    out = serve(render(model, { streamRealip: false, httpLua: false, streamLua: false, sslRejectHandshake: true }).conf);
  }, 300_000);
  const val = (k: string): string => out.split('\n').find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim() ?? '';

  it.runIf(dockerAvailable())('HTTPS — 같은 포트에서 이름마다 자기 응답을 낸다', () => {
    expect(val('tls_a'), out).toBe('https://from-a/');
    expect(val('tls_b'), out).toBe('https://from-b/');
  });

  it.runIf(dockerAvailable())('HTTPS — 이름마다 자기 리스너의 인증서를 낸다', () => {
    expect(val('cn_a'), out).toBe('a.test');
    expect(val('cn_b'), out).toBe('b.test');
  });

  it.runIf(dockerAvailable())('HTTPS — 모르는 이름에는 어느 인증서도 안 내고 끊는다', () => {
    expect(val('cn_unknown'), out).toBe('');
    expect(val('tls_unknown_exit'), out).not.toBe('0');
  });

  it.runIf(dockerAvailable())('HTTP — 같은 포트에서 이름마다 자기 응답, 모르는 이름은 끊는다(444)', () => {
    expect(val('plain_a'), out).toBe('http://plain-a/');
    expect(val('plain_b'), out).toBe('http://plain-b/');
    expect(val('plain_unknown_exit'), out).toBe('52');
  });
});
