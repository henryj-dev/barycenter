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

/**
 * 렌더 산출물로 nginx 를 **실제로 띄우고** 컨테이너 안에서 프로브를 돌린다.
 * `nginx -t` 는 문법만 본다 — 의미는 요청을 던져야 안다.
 */
function nginxProbe(conf: string, probe: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bary-runtime-'));
  try {
    mkdirSync(join(dir, 'conf'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(join(dir, 'conf', 'nginx.conf'), `daemon off;\n${conf}`, 'utf8');
    writeFileSync(join(dir, 'probe.sh'), probe, 'utf8');
    return execFileSync(
      'docker',
      ['run', '--rm', '-v', `${dir}:/prefix`, '--entrypoint', '/bin/sh', IMAGE, '-c',
       'apk add --no-cache curl >/dev/null 2>&1; ' +
       '/usr/local/openresty/bin/openresty -p /prefix -c conf/nginx.conf & sleep 1.2; ' +
       'sh /prefix/probe.sh'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString().trim();
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
    // **R18 이 뒤집힌 자리다.** 옛 케이스는 *"stream + PROXY 를 $proxy_protocol_addr 해시로
    // 렌더한 결과가 nginx -t 를 통과한다"* 였다. 통과하기는 했지만 그 설정은 **해시 키를
    // 클라이언트가 정하게** 하고 있었다(E63). 이제 그 조합은 검증기가 막으므로 렌더 자체가
    // 안 나온다 — 대신 **신뢰 경계가 붙은 http 수신**이 실제 엔진을 통과하는지 본다.
    //
    // 이게 중요한 이유: `set_real_ip_from` 과 `real_ip_header proxy_protocol` 은 realip
    // 모듈이 있어야 하는 디렉티브다. 렌더는 되는데 엔진이 거절하면 게시 전에 죽는다.
    name: 'R18(뒤집힘) PROXY 수신 + 신뢰 경계 — http realip 이 실제 엔진을 통과한다',
    model: {
      ...base,
      listeners: [
        { key: 'edge', protocol: 'http', bind: '0.0.0.0', port: 9000, enabled: true,
          acceptProxyProtocol: { trustedCidrs: ['10.0.0.0/8', '2001:db8::/32'] },
          http: { defaultAction: { pool: 'app' } } },
      ],
      pools: [{ key: 'app', protocolClass: 'http', algorithm: 'source_ip_hash' }],
      backends: [
        { key: 'a', pool: 'app', host: '10.0.0.1', port: 443, weight: 1 },
        { key: 'b', pool: 'app', host: '10.0.0.2', port: 443, weight: 1 },
      ],
    },
  },
  {
    // 4차 검수 High 묶음: 비단사 identifier · IPv6 백엔드 · map 제어어.
    // 셋 다 산출물이 `nginx -t` 에서 깨지던 것들이다.
    name: 'R20 identifier 충돌 · IPv6 백엔드 · map 제어어 SNI',
    model: {
      ...base,
      listeners: [
        { key: 'l1', protocol: 'tcp', bind: '0.0.0.0', port: 9401, enabled: true, defaultPool: 'a-b' },
        { key: 'l2', protocol: 'tcp', bind: '0.0.0.0', port: 9402, enabled: true, defaultPool: 'a_b' },
        { key: 'tls', protocol: 'tls_passthrough', bind: '0.0.0.0', port: 9403, enabled: true,
          onUnmatchedSni: 'reject' },
      ],
      pools: [
        { key: 'a-b', protocolClass: 'tcp', algorithm: 'round_robin' },
        { key: 'a_b', protocolClass: 'tcp', algorithm: 'round_robin' },
        { key: 'v6', protocolClass: 'tcp', algorithm: 'round_robin' },
      ],
      backends: [
        { key: 'x', pool: 'a-b', host: '10.0.0.1', port: 11, weight: 1 },
        { key: 'y', pool: 'a_b', host: '10.0.0.2', port: 11, weight: 1 },
        { key: 'z', pool: 'v6', host: '2001:db8::1', port: 443, weight: 1 },
      ],
      passthroughRoutes: [
        { key: 'r', listener: 'tls', snis: ['default'], priority: 1,
          action: { kind: 'proxy', pool: 'v6' } },
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

  /**
   * **멤버십 평면** (§7.3 · S1). capability 로 켜지므로 기본 픽스처에는 안 나온다 —
   * 여기서 따로 실제 엔진에 물린다.
   *
   * `balancer_by_lua_block` 은 nginx 가 **Lua 로 컴파일**하는 본문이라, 문법이 틀리면
   * `nginx -t` 가 잡는다. 렌더러가 문자열을 짜서 내는 유일한 자리이므로 여기가 아니면
   * 잡을 데가 없다.
   */
  it('**멤버십 평면 렌더가 실제 엔진을 통과한다** — 두 서브시스템 다', () => {
    const model: Model = {
      ...base,
      listeners: [
        { key: 'web', protocol: 'http', bind: '0.0.0.0', port: 8080, enabled: true,
          http: { defaultAction: { pool: 'p' } } },
        { key: 'raw', protocol: 'tcp', bind: '0.0.0.0', port: 8081, enabled: true,
          defaultPool: 'q' },
      ],
      pools: [
        { key: 'p', protocolClass: 'http', algorithm: 'round_robin' },
        { key: 'q', protocolClass: 'tcp', algorithm: 'round_robin' },
      ],
      backends: [
        { key: 'p1', pool: 'p', host: '10.2.0.1', port: 11, weight: 1 },
        { key: 'q1', pool: 'q', host: '10.2.0.2', port: 12, weight: 1 },
      ],
    };
    const { conf } = render(model, { streamRealip: false, httpLua: true, streamLua: true });
    expect(conf).toContain('lua_shared_dict bary_http 1m;');
    expect(conf).toContain('lua_shared_dict bary_stream 1m;');
    expect(conf).toContain('balancer_by_lua_block {');
    const err = nginxTest(conf);
    expect(err, `멤버십 렌더가 거부됐다:\n${conf}\n\n--- stderr ---\n${err}`).toBeNull();
  });

  /**
   * **`nginx -t` 는 밸런서의 Lua 를 안 본다** (E64).
   *
   * 처음엔 *"Lua 문법이 틀리면 거부된다"* 를 단언했다가 빨갛게 나왔다. 그리고 재보니
   * **하나도 검증하지 않는다** — `balancer_by_lua_block`·`init_by_lua_block`·
   * `init_worker_by_lua_block`·`content_by_lua_block` 넷 다 그대로 통과한다.
   * (중간에 "content_by_lua 는 잡는다" 로 잘못 읽었는데, 그 케이스만 `location` 밖에
   * 블록을 둬서 나온 **컨텍스트 오류**였다. 거부를 보고 이유를 안 읽은 탓이다.)
   *
   * **그래서 위 골든은 "블록 껍데기가 맞다" 까지만 증명한다.** 밸런서가 정말 도는지는
   * 트래픽으로만 알 수 있고, 세대 마커(`return 200`)는 Lua 와 무관하게 답하므로
   * **활성화 판정도 그걸 못 잡는다.** 멤버십 평면을 apply 에 붙일 때 활성화 증거를
   * 넓혀야 한다는 뜻이다 — 여기 적어 둔다.
   */
  it('깨진 Lua 밸런서를 `nginx -t` 는 **통과시킨다** — 게시 전 검사의 한계 (E64)', () => {
    const broken = `events {}
http {
    lua_shared_dict bary_http 1m;
    upstream u {
        server 0.0.0.1:1;
        balancer_by_lua_block {
            this is not lua ((
        }
    }
    server { listen 8080; location / { proxy_pass http://u; } }
}
`;
    expect(nginxTest(broken)).toBeNull();
  });

  it('의도적으로 깨진 conf 는 거부된다 — 하네스가 실제로 검증하고 있음을 확인', () => {
    expect(nginxTest('events {}\nhttp { server { listen 80; not_a_directive on; } }\n')).not.toBeNull();
  });
});

/**
 * R19 — 런타임 의미 골든.
 *
 * 4차 검수: 골든이 문법만 보면 "평문 HTTPS·잘못된 default Host·잘못된 우선순위" 도
 * 전부 유효한 conf 라 통과한다. E32 로 확인된 위험(모르는 Host 가 첫 테넌트로 들어감)은
 * 실제 요청으로만 확인할 수 있다.
 */
describe('R19 — 런타임 동작 골든', () => {
  beforeAll(() => {
    if (!dockerAvailable()) throw new Error('도커가 필요하다.');
  });

  const multiTenant: Model = {
    ...base,
    listeners: [{ key: 'web', protocol: 'http', bind: '0.0.0.0', port: 8080, enabled: true }],
    pools: [
      { key: 'a', protocolClass: 'http', algorithm: 'round_robin' },
      { key: 'b', protocolClass: 'http', algorithm: 'round_robin' },
    ],
    backends: [
      { key: 'ba', pool: 'a', host: '127.0.0.1', port: 9001, weight: 1 },
      { key: 'bb', pool: 'b', host: '127.0.0.1', port: 9002, weight: 1 },
    ],
    httpRoutes: [
      { key: 'r1', listener: 'web', hosts: ['tenant-a.example.com'], priority: 10,
        action: { kind: 'reject', status: 403 } },
      { key: 'r2', listener: 'web', hosts: ['tenant-b.example.com'], priority: 5,
        action: { kind: 'reject', status: 404 } },
    ],
  };

  it('모르는 Host 는 첫 테넌트가 아니라 default_server 로 간다 (E32)', () => {
    const { conf } = render(multiTenant);
    const out = nginxProbe(
      conf,
      `curl -s -o /dev/null -w '%{http_code}' --max-time 3 -H 'Host: evil.example' http://127.0.0.1:8080/ ; echo
       curl -s -o /dev/null -w '%{http_code}' --max-time 3 -H 'Host: tenant-a.example.com' http://127.0.0.1:8080/ ; echo
       curl -s -o /dev/null -w '%{http_code}' --max-time 3 -H 'Host: tenant-b.example.com' http://127.0.0.1:8080/`,
    );
    const [unknown, tenantA, tenantB] = out.split('\n').map((x) => x.trim());
    // 444 는 응답 없이 끊는 것이라 curl 은 000 을 보고한다. 어느 쪽이든 테넌트로 새지 않으면 된다.
    expect(['000', '444'], `모르는 Host 가 ${unknown} 을 받았다 — 테넌트로 샜다`).toContain(unknown);
    expect(tenantA).toBe('403');
    expect(tenantB).toBe('404');
  });
});
