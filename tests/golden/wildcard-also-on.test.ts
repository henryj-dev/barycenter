/**
 * **`0.0.0.0` 리스너는 같은 포트의 특정 주소로 온 접속에도 답한다** — 실물 nginx 로 잰다 (2026-11-02, web-01).
 *
 * web-01 의 443 에 관리 화면 리스너 둘이 내부 IP 로, `counter.tinyuniver.se` 가 `0.0.0.0` 으로 묶여 있었다. nginx 는
 * 접속이 온 주소에 맞는 `listen` 이 있으면 그 주소의 server 만 고른다. 그래서 내부 IP 로 온 counter 접속은
 * 「모르는 이름」 으로 TLS 를 거절당했다(`ERR_SSL_UNRECOGNIZED_NAME_ALERT`). 렌더러가 와일드카드 리스너의 호스트
 * server 에 그 주소의 `listen` 을 함께 붙여 메운다.
 *
 * 컨테이너 안에서 127.0.0.1(아무 주소)과 127.0.0.2(특정 주소)를 두 주소로 쓴다. 재는 것:
 *   · 특정 주소로 온 `site.test` 를 와일드카드 리스너가 받는다 — 전에는 TLS 가 거절됐다
 *   · 특정 주소의 관리 이름은 그대로 특정 주소 리스너가 받고, 다른 주소에서는 안 받는다(분리가 남는다)
 *   · 특정 주소로 온 모르는 이름은 특정 주소 리스너의 기본이 거절한다 — 와일드카드의 기본이 끼어들지 않는다
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { render } from '../../src/conf/render.js';
import type { HttpRoute, HttpsListener, Model } from '../../src/model/provisional.js';
import { validateModel } from '../../src/validate/model.js';
import { dropScratch } from '../scratch.js';

const IMAGE = process.env['BARY_ENGINE_IMAGE'] ?? 'docker.io/openresty/openresty:alpine';
const P = 18961;
const V = 'c'.repeat(32);

function dockerAvailable(): boolean {
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }); return true; } catch { return false; }
}

const mark = (key: string, listener: string, host: string): HttpRoute => ({
  key, listener, hosts: [host], priority: 0, action: { kind: 'redirect', to: `https://${key}/`, status: 302 },
});
const https = (key: string, bind: string, hosts: string[]): HttpsListener => ({
  key, protocol: 'https', bind, port: P, enabled: true, hosts,
  tls: { policy: 'p', defaultCertificate: 'c' }, http: { defaultAction: 'reject' }, http2: false,
});

const caps = { streamRealip: false, httpLua: true, streamLua: false, sslRejectHandshake: true };

const model: Model = {
  listeners: [
    https('admin', '127.0.0.2', ['admin.test']),
    https('site', '0.0.0.0', ['site.test']),
  ],
  httpRoutes: [mark('admin-route', 'admin', 'admin.test'), mark('site-route', 'site', 'site.test')],
  passthroughRoutes: [],
  pools: [],
  backends: [],
  certificates: [{ key: 'c', materialRef: `store://c@${V}`, chainDigest: `sha256:${'0'.repeat(64)}`, keyDigest: `sha256:${'1'.repeat(64)}` }],
  tlsPolicies: [{ key: 'p', minVersion: '1.2' }],
  sniBindings: [],
};

// 이름 · 주소마다 Location 의 호스트를 낸다. TLS 가 거절되면 curl 종료 코드를 낸다.
const PROBE = `
hit() { out=$(curl -sk -o /dev/null -D - --resolve "$1:${P}:$2" "https://$1:${P}/" 2>/dev/null); rc=$?
  if [ $rc -ne 0 ]; then echo "rc=$rc"; else printf '%s' "$out" | tr -d '\\r' | sed -n 's/^[Ll]ocation: https:\\/\\/\\([^/]*\\)\\/.*/\\1/p'; fi; }
echo "site_spec=$(hit site.test 127.0.0.2)"
echo "site_any=$(hit site.test 127.0.0.1)"
echo "admin_spec=$(hit admin.test 127.0.0.2)"
echo "admin_any=$(hit admin.test 127.0.0.1)"
echo "unknown_spec=$(hit nope.test 127.0.0.2)"
`;

function serve(conf: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bary-alsoon-'));
  chmodSync(dir, 0o777);
  try {
    mkdirSync(join(dir, 'conf'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(join(dir, 'conf', 'nginx.conf'), `daemon off;\n${conf}`, 'utf8');
    writeFileSync(join(dir, 'probe.sh'), PROBE, 'utf8');
    const mk = `mkdir -p /prefix/conf/certs/c/${V} && openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=site.test" `
      + `-addext "subjectAltName=DNS:site.test,DNS:admin.test" -keyout /prefix/conf/certs/c/${V}/privkey.pem `
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

describe('와일드카드 리스너가 특정 주소에도 답한다 — 실물 nginx', () => {
  let out = '';
  beforeAll(() => {
    if (!dockerAvailable()) return;
    out = serve(render(model, caps).conf);
  }, 300_000);

  it('검증기가 이 모델을 받는다', () => {
    expect(validateModel(model, caps)).toEqual([]);
  });

  it('**특정 주소로 온 와일드카드 리스너의 이름을 와일드카드 리스너가 받는다** — 전에는 TLS 가 거절됐다', () => {
    if (!dockerAvailable()) return;
    expect(value(out, 'site_spec'), out).toBe('site-route');
    expect(value(out, 'site_any'), out).toBe('site-route');
  });

  it('관리 이름은 특정 주소에서만 받는다 — 분리가 남는다', () => {
    if (!dockerAvailable()) return;
    expect(value(out, 'admin_spec'), out).toBe('admin-route');
    expect(value(out, 'admin_any'), out).toMatch(/^rc=/);
  });

  it('특정 주소로 온 모르는 이름은 그 주소 리스너의 기본이 거절한다', () => {
    if (!dockerAvailable()) return;
    expect(value(out, 'unknown_spec'), out).toMatch(/^rc=/);
  });
});
