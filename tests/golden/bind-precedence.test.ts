/**
 * 와일드카드 바인드와 특정 주소 바인드가 같은 포트를 나눠 쓴다 — **실물 nginx 로** 잰다 (2026-10-31).
 *
 * 규칙: 같은 nginx 컨텍스트(http 끼리, stream 끼리)면 nginx 가 와일드카드 소켓 하나만 열고, 도착 주소로
 * server 를 고른다. **특정 주소로 온 요청은 특정 주소 리스너가 받는다.** 나머지 주소는 와일드카드가 받는다.
 * 컨테이너 안에서 127.0.0.1 과 127.0.0.2 를 두 주소로 쓴다(둘 다 lo 다).
 *
 * 재는 것:
 *   · http — 0.0.0.0:P 와 127.0.0.2:P 가 함께 뜨고, 주소마다 다른 리스너가 받는다
 *   · 평문과 TLS — 0.0.0.0:P 평문과 127.0.0.2:P HTTPS 가 함께 뜬다(ssl 은 주소 단위 옵션이다)
 *   · stream tcp — 0.0.0.0:P 와 127.0.0.2:P 가 함께 뜨고, 주소마다 다른 풀로 간다
 *   · IPv6 — [::]:P 와 [::1]:P 가 함께 뜬다(특정 주소에 ipv6only 를 붙이면 기동이 실패했다), 0.0.0.0:P 도 공존
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { render } from '../../src/conf/render.js';
import type { HttpRoute, Model } from '../../src/model/provisional.js';
import { validateModel } from '../../src/validate/model.js';
import { dropScratch } from '../scratch.js';

const IMAGE = process.env['BARY_ENGINE_IMAGE'] ?? 'docker.io/openresty/openresty:alpine';
const HTTP = 18951;
const MIX = 18952;
const TCP = 18953;
const V6 = 18954;
const V = 'b'.repeat(32);

function dockerAvailable(): boolean {
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }); return true; } catch { return false; }
}

const mark = (key: string, listener: string, to: string): HttpRoute => ({
  key, listener, hosts: ['x.test'], priority: 0, action: { kind: 'redirect', to: `https://${to}/`, status: 302 },
});

const http = (key: string, bind: string, port: number) =>
  ({ key, protocol: 'http' as const, bind, port, enabled: true, http: { defaultAction: 'reject' as const } });

const caps = { streamRealip: false, httpLua: true, streamLua: false, sslRejectHandshake: true };

const model: Model = {
  listeners: [
    http('h-wild', '0.0.0.0', HTTP),
    http('h-spec', '127.0.0.2', HTTP),
    http('m-wild', '0.0.0.0', MIX),
    { key: 'm-spec', protocol: 'https', bind: '127.0.0.2', port: MIX, enabled: true, hosts: ['x.test'],
      tls: { policy: 'p', defaultCertificate: 'c' }, http: { defaultAction: 'reject' }, http2: false },
    { key: 't-wild', protocol: 'tcp', bind: '0.0.0.0', port: TCP, enabled: true, defaultPool: 'to-wild' },
    { key: 't-spec', protocol: 'tcp', bind: '127.0.0.2', port: TCP, enabled: true, defaultPool: 'to-spec' },
    http('v6-wild', '::', V6),
    http('v6-spec', '::1', V6),
    http('v4-wild', '0.0.0.0', V6),
  ],
  httpRoutes: [
    mark('r1', 'h-wild', 'h-wild'), mark('r2', 'h-spec', 'h-spec'),
    mark('r3', 'm-wild', 'm-wild'), mark('r4', 'm-spec', 'm-spec'),
    mark('r5', 'v6-wild', 'v6-wild'), mark('r6', 'v6-spec', 'v6-spec'), mark('r7', 'v4-wild', 'v4-wild'),
  ],
  passthroughRoutes: [],
  pools: [
    { key: 'to-wild', protocolClass: 'tcp', algorithm: 'round_robin' },
    { key: 'to-spec', protocolClass: 'tcp', algorithm: 'round_robin' },
  ],
  // stream 은 http 리스너로 넘긴다 — 어느 풀로 갔는지가 Location 에 드러난다.
  backends: [
    { key: 'bw', pool: 'to-wild', host: '127.0.0.1', port: HTTP, weight: 1 },
    { key: 'bs', pool: 'to-spec', host: '127.0.0.2', port: HTTP, weight: 1 },
  ],
  certificates: [{ key: 'c', materialRef: `store://c@${V}`, chainDigest: `sha256:${'0'.repeat(64)}`, keyDigest: `sha256:${'1'.repeat(64)}` }],
  tlsPolicies: [{ key: 'p', minVersion: '1.2' }],
  sniBindings: [],
};

const PROBE = `
loc() { curl -sk -g -o /dev/null -D - -H 'Host: x.test' "$2" 2>/dev/null | tr -d '\\r' | sed -n 's/^[Ll]ocation: https:\\/\\/\\([^/]*\\)\\/.*/\\1/p'; }
echo "http_any=$(loc - http://127.0.0.1:${HTTP}/)"
echo "http_spec=$(loc - http://127.0.0.2:${HTTP}/)"
echo "mix_plain=$(loc - http://127.0.0.1:${MIX}/)"
echo "mix_tls=$(curl -sk -o /dev/null -D - --resolve x.test:${MIX}:127.0.0.2 https://x.test:${MIX}/ 2>/dev/null | tr -d '\\r' | sed -n 's/^[Ll]ocation: https:\\/\\/\\([^/]*\\)\\/.*/\\1/p')"
echo "tcp_any=$(loc - http://127.0.0.1:${TCP}/)"
echo "tcp_spec=$(loc - http://127.0.0.2:${TCP}/)"
echo "v6_spec=$(loc - 'http://[::1]:${V6}/')"
echo "v6_v4=$(loc - http://127.0.0.1:${V6}/)"
`;

function serve(conf: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bary-bindprec-'));
  chmodSync(dir, 0o777);
  try {
    mkdirSync(join(dir, 'conf'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(join(dir, 'conf', 'nginx.conf'), `daemon off;\n${conf}`, 'utf8');
    writeFileSync(join(dir, 'probe.sh'), PROBE, 'utf8');
    const mk = `mkdir -p /prefix/conf/certs/c/${V} && openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=x.test" `
      + `-addext "subjectAltName=DNS:x.test" -keyout /prefix/conf/certs/c/${V}/privkey.pem `
      + `-out /prefix/conf/certs/c/${V}/fullchain.pem >/dev/null 2>&1; `;
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

const value = (out: string, k: string): string | undefined =>
  new RegExp(`^${k}=(.*)$`, 'm').exec(out)?.[1];

describe('와일드카드와 특정 주소 — 실물 nginx', () => {
  let out = '';
  beforeAll(() => {
    if (!dockerAvailable()) return;
    out = serve(render(model, caps).conf);
  }, 300_000);

  it('검증기가 이 모델을 받는다 — 같은 컨텍스트의 섞임은 충돌이 아니다', () => {
    expect(validateModel(model, caps)).toEqual([]);
  });

  it('http: 특정 주소로 온 요청은 특정 주소 리스너가, 나머지는 와일드카드가 받는다', () => {
    if (!dockerAvailable()) return;
    expect(value(out, 'http_spec'), out).toBe('h-spec');
    expect(value(out, 'http_any'), out).toBe('h-wild');
  });

  it('평문 와일드카드와 TLS 특정 주소가 한 포트에 함께 뜬다', () => {
    if (!dockerAvailable()) return;
    expect(value(out, 'mix_plain'), out).toBe('m-wild');
    expect(value(out, 'mix_tls'), out).toBe('m-spec');
  });

  it('stream tcp: 주소마다 다른 풀로 간다', () => {
    if (!dockerAvailable()) return;
    expect(value(out, 'tcp_spec'), out).toBe('h-spec');
    expect(value(out, 'tcp_any'), out).toBe('h-wild');
  });

  it('IPv6: [::] 와 [::1] 이 함께 뜨고 [::1] 이 이긴다 — 0.0.0.0 도 공존한다', () => {
    if (!dockerAvailable()) return;
    expect(value(out, 'v6_spec'), out).toBe('v6-spec');
    expect(value(out, 'v6_v4'), out).toBe('v4-wild');
  });
});
