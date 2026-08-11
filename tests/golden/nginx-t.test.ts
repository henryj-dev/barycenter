/**
 * R17 — 렌더 산출물은 **실제 엔진에서** `nginx -t` 를 통과해야 한다.
 *
 * 문자열 단위 골든(tests/unit/render.test.ts)만으로는 부족하다. E7 이 보여준 것처럼,
 * 그럴듯해 보이는 conf 가 unknown variable 로 죽는다. 판정은 엔진이 한다.
 *
 * 도커가 필요하다:  npm run test:golden
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { render } from '../../src/conf/render.js';
import type { Model } from '../../src/model/provisional.js';

const IMAGE = process.env['BARY_ENGINE_IMAGE'] ?? 'openresty/openresty:alpine';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** 실제 엔진에서 nginx -t 를 돌린다. 통과하면 null, 아니면 stderr. */
function nginxTest(conf: string): string | null {
  const dir = mkdtempSync(join(tmpdir(), 'bary-golden-'));
  try {
    mkdirSync(join(dir, 'conf'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(join(dir, 'conf', 'nginx.conf'), conf, 'utf8');
    try {
      execFileSync(
        'docker',
        ['run', '--rm', '-v', `${dir}:/prefix`, '--entrypoint',
         '/usr/local/openresty/bin/openresty', IMAGE, '-t', '-p', '/prefix', '-c', 'conf/nginx.conf'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      return null;
    } catch (e) {
      const err = e as { stderr?: Buffer; stdout?: Buffer; message?: string };
      return (err.stderr?.toString() || err.stdout?.toString() || err.message || 'unknown').trim();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const base: Model = {
  listeners: [], httpRoutes: [], passthroughRoutes: [], pools: [], backends: [],
};

const fixtures: Array<{ name: string; model: Model }> = [
  { name: 'R16 빈 모델', model: base },
  {
    name: 'R1 TCP 포트 리매핑',
    model: {
      ...base,
      listeners: [
        { key: 'game', protocol: 'tcp', bind: '0.0.0.0', port: 999, enabled: true, defaultPool: 'a' },
        { key: 'alt', protocol: 'tcp', bind: '0.0.0.0', port: 888, enabled: true, defaultPool: 'b' },
      ],
      pools: [
        { key: 'a', protocolClass: 'tcp', algorithm: 'round_robin', sendProxyProtocol: 'v1' },
        { key: 'b', protocolClass: 'tcp', algorithm: 'source_ip_hash' },
      ],
      backends: [
        { key: 'a1', pool: 'a', host: '10.0.0.11', port: 11, weight: 2 },
        { key: 'b1', pool: 'b', host: '10.0.0.21', port: 11, weight: 1 },
      ],
    },
  },
  {
    name: 'R11 UDP dns 프리셋',
    model: {
      ...base,
      listeners: [
        { key: 'dns', protocol: 'udp', bind: '0.0.0.0', port: 8853, enabled: true,
          defaultPool: 'p', udp: { preset: 'dns' } },
      ],
      pools: [{ key: 'p', protocolClass: 'udp', algorithm: 'round_robin' }],
      backends: [
        { key: 'd1', pool: 'p', host: '10.0.1.5', port: 53, weight: 1 },
        { key: 'd2', pool: 'p', host: '10.0.1.6', port: 53, weight: 1 },
      ],
    },
  },
  {
    name: 'R4 HTTP + websocket ($connection_upgrade map)',
    model: {
      ...base,
      listeners: [{ key: 'web', protocol: 'http', bind: '0.0.0.0', port: 8080, enabled: true }],
      pools: [{ key: 'api', protocolClass: 'http', algorithm: 'source_ip_hash' }],
      backends: [
        { key: 'x', pool: 'api', host: '10.0.2.10', port: 8080, weight: 1 },
        { key: 'y', pool: 'api', host: '10.0.2.11', port: 8080, weight: 1 },
      ],
      httpRoutes: [
        { key: 'r1', listener: 'web', hosts: ['api.example.com'], priority: 10,
          action: { kind: 'proxy', pool: 'api', websocket: true } },
        { key: 'r2', listener: 'web', hosts: ['*.example.com'], priority: 5, pathPrefix: '/v1',
          action: { kind: 'proxy', pool: 'api', websocket: false } },
        { key: 'r3', listener: 'web', hosts: ['old.example.com'], priority: 1,
          action: { kind: 'redirect', to: 'https://new.example.com', status: 301 } },
        { key: 'r4', listener: 'web', hosts: ['blocked.example.com'], priority: 1,
          action: { kind: 'reject', status: 403 } },
      ],
    },
  },
  {
    name: 'R8/R9 SNI 패스스루 + 부재 SNI reject 고정',
    model: {
      ...base,
      listeners: [
        { key: 'tls', protocol: 'tls_passthrough', bind: '0.0.0.0', port: 8443, enabled: true,
          onUnmatchedSni: { pool: 'fb' }, prereadTimeoutS: 5 },
      ],
      pools: [
        { key: 'mail', protocolClass: 'tcp', algorithm: 'round_robin' },
        { key: 'wild', protocolClass: 'tcp', algorithm: 'round_robin' },
        { key: 'fb', protocolClass: 'tcp', algorithm: 'round_robin' },
      ],
      backends: [
        { key: 'm', pool: 'mail', host: '10.1.0.1', port: 443, weight: 1 },
        { key: 'w', pool: 'wild', host: '10.1.0.2', port: 443, weight: 1 },
        { key: 'f', pool: 'fb', host: '10.1.0.3', port: 443, weight: 1 },
      ],
      passthroughRoutes: [
        { key: 'p1', listener: 'tls', snis: ['mail.example.com'], priority: 10,
          action: { kind: 'proxy', pool: 'mail' } },
        { key: 'p2', listener: 'tls', snis: ['*.example.com'], priority: 5,
          action: { kind: 'proxy', pool: 'wild' } },
      ],
    },
  },
  {
    name: 'M6.2 같은 포트의 TCP + UDP (E12)',
    model: {
      ...base,
      listeners: [
        { key: 't', protocol: 'tcp', bind: '0.0.0.0', port: 9999, enabled: true, defaultPool: 'p' },
        { key: 'u', protocol: 'udp', bind: '0.0.0.0', port: 9999, enabled: true, defaultPool: 'q',
          udp: { preset: 'game_generic' } },
      ],
      pools: [
        { key: 'p', protocolClass: 'tcp', algorithm: 'round_robin' },
        { key: 'q', protocolClass: 'udp', algorithm: 'round_robin' },
      ],
      backends: [
        { key: 'p1', pool: 'p', host: '10.2.0.1', port: 11, weight: 1 },
        { key: 'q1', pool: 'q', host: '10.2.0.1', port: 11, weight: 1 },
      ],
    },
  },
  {
    name: 'R18 PROXY 수신 + $proxy_protocol_addr 해시 (stream_realip 없는 엔진)',
    model: {
      ...base,
      listeners: [
        { key: 'edge', protocol: 'tcp', bind: '0.0.0.0', port: 9000, enabled: true,
          defaultPool: 'app', acceptProxyProtocol: true },
      ],
      pools: [{ key: 'app', protocolClass: 'tcp', algorithm: 'source_ip_hash' }],
      backends: [
        { key: 'a', pool: 'app', host: '10.0.0.1', port: 443, weight: 1 },
        { key: 'b', pool: 'app', host: '10.0.0.2', port: 443, weight: 1 },
      ],
    },
  },
];

describe('R17 — 실제 엔진 nginx -t', () => {
  beforeAll(() => {
    if (!dockerAvailable()) {
      throw new Error(
        '도커가 필요하다. 골든 테스트는 렌더 산출물을 실제 엔진으로 검증한다.\n' +
          '도커를 켜거나, 단위 테스트만 돌리려면 `npm test` 를 쓴다.',
      );
    }
  });

  for (const { name, model } of fixtures) {
    it(`${name} 는 nginx -t 를 통과한다`, () => {
      const { conf } = render(model);
      const err = nginxTest(conf);
      expect(err, `렌더 산출물이 거부됐다:\n${conf}\n\n--- stderr ---\n${err}`).toBeNull();
    });
  }

  it('의도적으로 깨진 conf 는 거부된다 — 하네스가 실제로 검증하고 있음을 확인', () => {
    expect(nginxTest('events {}\nhttp { server { listen 80; not_a_directive on; } }\n')).not.toBeNull();
  });
});
