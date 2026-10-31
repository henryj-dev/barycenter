/**
 * 긴 리스너 키가 `nginx -t` 를 통과한다 (2026-11-01, web-01).
 *
 * 키로 만든 nginx 변수 이름이 46 자를 넘으면 기본 `variables_hash_bucket_size 64` 에서
 * `could not build variables_hash` 로 엔진이 설정을 거부한다. web-01 에서 `barycenter-internal` 에
 * 출발지 제한과 HTTP 리다이렉트를 함께 켜자 리다이렉트 리스너(`…:http`)의 변수가 47 자가 되어 적용이 실패했다.
 *
 * 재는 것: 키 63 자(허용 최대)인 http 리스너의 출발지 제한(geo), 그 키의 리다이렉트 리스너(`…:http`, 67 자),
 * TLS 패스스루의 SNI · SNI 없음 변수(map). 판정은 엔진이 한다.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { render } from '../../src/conf/render.js';
import type { Model } from '../../src/model/provisional.js';
import { validateModel } from '../../src/validate/model.js';
import { dropScratch } from '../scratch.js';

const IMAGE = process.env['BARY_ENGINE_IMAGE'] ?? 'docker.io/openresty/openresty:alpine';
const dockerAvailable = (): boolean => {
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }); return true; } catch { return false; }
};

function nginxTest(conf: string): string | null {
  const dir = mkdtempSync(join(tmpdir(), 'bary-longkey-'));
  chmodSync(dir, 0o777);
  try {
    mkdirSync(join(dir, 'conf'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(join(dir, 'conf', 'nginx.conf'), conf, 'utf8');
    try {
      execFileSync('docker', ['run', '--rm', '-v', `${dir}:/prefix:Z`, '--entrypoint',
        '/usr/local/openresty/bin/openresty', IMAGE, '-t', '-p', '/prefix', '-c', 'conf/nginx.conf'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
      return null;
    } catch (e) {
      const err = e as { stderr?: Buffer; message?: string };
      return (err.stderr?.toString() || err.message || 'unknown').trim();
    }
  } finally {
    dropScratch(dir);
  }
}

// 63 자 — 키 규칙의 최대. 하이픈이 있어 ident 가 다이제스트를 붙인다.
const LONG = 'a-very-long-listener-key-that-reaches-the-sixty-three-char-limit';
const LONG2 = 'a-very-long-listener-key-that-reaches-the-sixty-three-char-limiu';
const caps = { streamRealip: false, httpLua: true, streamLua: false, sslRejectHandshake: true };

const model = {
  listeners: [
    { key: LONG, protocol: 'http', bind: '0.0.0.0', port: 18971, enabled: true,
      sourceAllow: ['10.0.0.0/8'], http: { defaultAction: { pool: 'web' } } },
    // 앞 마흔 몇 자가 같은 키 — 잘린 이름이 같아도 다이제스트가 가른다.
    { key: LONG2, protocol: 'http', bind: '0.0.0.0', port: 18972, enabled: true,
      sourceAllow: ['10.0.0.0/8'], http: { defaultAction: { pool: 'web' } } },
    // 리다이렉트 리스너와 같은 모양의 키(`…:http`) — 키 규칙 밖이라 모델에는 직접 못 넣지만 렌더는 이 키로 변수를 만든다.
    { key: 'tls', protocol: 'tls_passthrough', bind: '0.0.0.0', port: 18973, enabled: true,
      onUnmatchedSni: { pool: 'tcp' }, onNoSni: { pool: 'tcp' } },
    { key: `${LONG.slice(0, 40)}-pt`, protocol: 'tls_passthrough', bind: '0.0.0.0', port: 18974, enabled: true,
      onUnmatchedSni: { pool: 'tcp' }, onNoSni: { pool: 'tcp' } },
  ],
  httpRoutes: [],
  passthroughRoutes: [],
  pools: [
    { key: 'web', protocolClass: 'http', algorithm: 'round_robin' },
    { key: 'tcp', protocolClass: 'tcp', algorithm: 'round_robin' },
  ],
  backends: [
    { key: 'w', pool: 'web', host: '127.0.0.1', port: 19001, weight: 1 },
    { key: 't', pool: 'tcp', host: '127.0.0.1', port: 19002, weight: 1 },
  ],
  certificates: [], tlsPolicies: [], sniBindings: [],
} as unknown as Model;

describe('긴 리스너 키 — 실물 nginx -t', () => {
  it('검증기가 받는 모델이다', () => {
    expect(validateModel(model, caps)).toEqual([]);
  });

  it('렌더한 변수 이름이 모두 46 자 이내다', () => {
    const conf = render(model, caps).conf;
    const names = [...new Set(conf.match(/\$[A-Za-z_][A-Za-z0-9_]*/g) ?? [])];
    expect(names.filter((n) => n.length - 1 > 46)).toEqual([]);
  });

  it('**nginx -t 를 통과한다**', () => {
    if (!dockerAvailable()) return;
    expect(nginxTest(render(model, caps).conf)).toBeNull();
  }, 120_000);
});
