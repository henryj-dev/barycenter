/**
 * 제안 #8 — **엔진이 실제로 받는가** (골든)
 *
 * 렌더가 서는 것과 nginx 가 받는 것은 다르다. 이 저장소가 반복해서 물린 자리다:
 * `real_ip_header` 를 stream 에 냈다가 *"directive is not allowed here"* 로 기동이
 * 깨졌고, 단위 테스트는 전부 초록이었다.
 *
 * 그래서 두 가지를 잰다.
 *
 *   ① `nginx -t` 가 통과하는가 — 디렉티브가 그 컨텍스트에서 허용되는가
 *   ② **`client_max_body_size` 가 실제로 물리는가** — 413 이 나오는가
 *
 * ②가 중요하다. 이 값은 기본 1m 이라 "적었는데 안 먹는다" 가 가장 자주 나는 자리이고,
 * conf 에 글자가 있는 것으로는 그걸 증명하지 못한다.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { dropScratch } from '../scratch.js';
import { render } from '../../src/conf/render.js';
import type { Model, ProxyLimits } from '../../src/model/provisional.js';

const IMAGE = process.env['BARY_ENGINE_IMAGE'] ?? 'docker.io/openresty/openresty:alpine';
const PORT = 18931;

function dockerAvailable(): boolean {
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }); return true; } catch { return false; }
}

const caps = { httpLua: false, streamLua: false, streamRealip: true, sslConfCommand: true };

const model = (limits: ProxyLimits): Model => ({
  listeners: [{
    key: 'l', protocol: 'http', bind: '0.0.0.0', port: PORT, enabled: true,
    http: { defaultAction: { pool: 'app' }, limits },
  }],
  httpRoutes: [],
  passthroughRoutes: [],
  pools: [{ key: 'app', protocolClass: 'http', algorithm: 'round_robin' }],
  // 백엔드는 안 뜬다 — `client_max_body_size` 는 **업스트림에 닿기 전에** 물리므로
  // 413 판정에는 필요 없다. 오히려 없는 편이 "413 이 우리 것" 이라는 증거가 된다.
  backends: [{ key: 'a', pool: 'app', host: '127.0.0.1', port: 19999, weight: 1 }],
  certificates: [], tlsPolicies: [], sniBindings: [],
});

/** conf 를 실제 nginx 에 물려 띄우고 프로브를 돌린다. */
function serve(conf: string, probe: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bary-limits-'));
  chmodSync(dir, 0o777);
  try {
    mkdirSync(join(dir, 'conf'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(join(dir, 'conf', 'nginx.conf'), `daemon off;\n${conf}`, 'utf8');
    writeFileSync(join(dir, 'probe.sh'), probe, 'utf8');
    return execFileSync('docker', [
      'run', '--rm', '-v', `${dir}:/w:Z`, '--entrypoint', '/bin/sh', IMAGE, '-c',
      // **`curl` 은 이 이미지에 없다.** 없으면 프로브가 조용히 빈 문자열을 내고,
      // 그 침묵은 "413 이 안 났다" 와 구분되지 않는다 — 실제로 한 번 그렇게 물렸다.
      'apk add --no-cache curl >/dev/null 2>&1; ' +
      '/usr/local/openresty/bin/openresty -p /w -c conf/nginx.conf & sleep 1.5; ' +
      'sh /w/probe.sh; echo "---errorlog---"; tail -3 /w/logs/error.log',
    ], { encoding: 'utf8', timeout: 180_000 });
  } finally {
    dropScratch(dir);
  }
}

/** `nginx -t` 만. 디렉티브가 그 컨텍스트에서 허용되는지. */
function configTest(conf: string): { ok: boolean; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'bary-limits-t-'));
  chmodSync(dir, 0o777);
  try {
    mkdirSync(join(dir, 'conf'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(join(dir, 'conf', 'nginx.conf'), conf, 'utf8');
    const out = execFileSync('docker', [
      'run', '--rm', '-v', `${dir}:/w`, '--entrypoint', '/bin/sh', IMAGE, '-c',
      'openresty -p /w -c /w/conf/nginx.conf -t 2>&1 || true',
    ], { encoding: 'utf8', timeout: 120_000 });
    return { ok: /syntax is ok/.test(out) && /test is successful/.test(out), out };
  } finally {
    dropScratch(dir);
  }
}

describe('프록시 한계값이 실제 엔진에 선다 (제안 #8)', () => {
  beforeAll(() => {
    if (!dockerAvailable()) throw new Error('도커가 없다 — 골든은 실물 엔진으로만 잰다');
  }, 180_000);

  it('네 디렉티브가 server 컨텍스트에서 통과한다', () => {
    const conf = render(model({
      connectTimeoutMs: 5000, readTimeoutMs: 120_000,
      sendTimeoutMs: 90_000, clientMaxBodyBytes: 1_048_576,
    }), caps).conf;
    const r = configTest(conf);
    expect(r.ok, r.out).toBe(true);
  }, 180_000);

  it('ms 표기도 받는다 — 초로 안 떨어지는 값을 반올림하지 않는 것이 전제다', () => {
    const conf = render(model({ connectTimeoutMs: 1500, readTimeoutMs: 2500 }), caps).conf;
    expect(conf).toContain('proxy_connect_timeout 1500ms;');
    const r = configTest(conf);
    expect(r.ok, r.out).toBe(true);
  }, 180_000);

  it('**`client_max_body_size` 가 실제로 물린다** — 413 이 나온다', () => {
    // 1k 로 좁히고 2k 를 보낸다. conf 에 글자가 있는 것과 엔진이 거절하는 것은 다르다.
    const conf = render(model({ clientMaxBodyBytes: 1024 }), caps).conf;
    const out = serve(conf, `
      head -c 2048 /dev/zero | tr '\\0' 'x' > /tmp/big
      echo "code=$(curl -s -o /dev/null -w '%{http_code}' --data-binary @/tmp/big http://127.0.0.1:${PORT}/)"
    `);
    expect(out).toContain('code=413');
  }, 180_000);

  it('**`0` 은 검사를 끈다** — 같은 본문이 413 이 아니다', () => {
    /**
     * `0` 이 "안 적음" 과 다르다는 것의 실물 증거다. 안 적으면 nginx 기본 1m 이고,
     * `0` 은 상한 자체를 없앤다 — 두 상태를 표현할 수 있어야 큰 업로드를 받는 배포가
     * 이 제품을 쓸 수 있다.
     */
    const conf = render(model({ clientMaxBodyBytes: 0 }), caps).conf;
    const out = serve(conf, `
      head -c 2048 /dev/zero | tr '\\0' 'x' > /tmp/big
      echo "code=$(curl -s -o /dev/null -w '%{http_code}' --data-binary @/tmp/big http://127.0.0.1:${PORT}/)"
    `);
    expect(out).not.toContain('code=413');
  }, 180_000);
});
