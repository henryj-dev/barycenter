/**
 * R1–R16 — 렌더러 골든 (문자열 수준)
 * 실제 엔진 `nginx -t` 통과 여부는 tests/golden/nginx-t.test.ts (R17) 에서 확인한다.
 *
 * 엔진 근거 (tests/engine 실측):
 *   E1  — stream 에 ip_hash 가 없다        → source_ip_hash 는 서브시스템별로 다르게 렌더
 *   E3  — hash $remote_addr consistent 가 stream 의 대응물
 *   E7  — $connection_upgrade 는 내장 변수가 아니다 → map 을 반드시 함께 렌더
 *   E21 — map 의 ~ 는 대소문자를 구분한다  → SNI 와일드카드는 ~* 여야 한다
 *   E26 — $ssl_preread_protocol 로 비-TLS 를 가를 수 있다 → on_no_sni 분기 가능
 */
import { describe, expect, it } from 'vitest';
import { render } from '../../src/conf/render.js';
import type { Model } from '../../src/model/provisional.js';

const empty: Model = {
  listeners: [],
  httpRoutes: [],
  passthroughRoutes: [],
  pools: [],
  backends: [],
};

/** `:999 → A:11`, `:888 → B:11` — DESIGN.md 의 최초 요구사항 */
const portRemap: Model = {
  ...empty,
  listeners: [
    { key: 'game', protocol: 'tcp', bind: '0.0.0.0', port: 999, enabled: true, defaultPool: 'pool-a' },
    { key: 'alt', protocol: 'tcp', bind: '0.0.0.0', port: 888, enabled: true, defaultPool: 'pool-b' },
  ],
  pools: [
    { key: 'pool-a', protocolClass: 'tcp', algorithm: 'round_robin' },
    { key: 'pool-b', protocolClass: 'tcp', algorithm: 'round_robin' },
  ],
  backends: [
    { key: 'a1', pool: 'pool-a', host: '10.0.0.11', port: 11, weight: 2 },
    { key: 'b1', pool: 'pool-b', host: '10.0.0.21', port: 11, weight: 1 },
  ],
};

describe('R1 — 포트 리매핑', () => {
  it('인바운드 포트와 백엔드 포트가 분리되어 렌더된다', () => {
    const { conf } = render(portRemap);
    expect(conf).toContain('listen 999;');
    expect(conf).toContain('listen 888;');
    expect(conf).toContain('server 10.0.0.11:11 weight=2;');
    expect(conf).toContain('server 10.0.0.21:11;');
  });

  it('stream 컨텍스트에 들어간다', () => {
    expect(render(portRemap).conf).toMatch(/stream \{/);
  });
});

describe('R2 / R3 — 결정성', () => {
  it('같은 모델은 같은 바이트를 만든다', () => {
    expect(render(portRemap).conf).toBe(render(portRemap).conf);
  });

  it('다이제스트가 내용에 대응한다', () => {
    expect(render(portRemap).digest).toBe(render(portRemap).digest);
    expect(render(portRemap).digest).not.toBe(render(empty).digest);
  });

  it('백엔드 순서만 다른 동일 집합은 같은 바이트를 만든다', () => {
    const reversed: Model = { ...portRemap, backends: [...portRemap.backends].reverse() };
    expect(render(reversed).conf).toBe(render(portRemap).conf);
  });

  it('리스너·풀 순서도 정규화된다', () => {
    const shuffled: Model = {
      ...portRemap,
      listeners: [...portRemap.listeners].reverse(),
      pools: [...portRemap.pools].reverse(),
    };
    expect(render(shuffled).conf).toBe(render(portRemap).conf);
  });
});

describe('R4 / R5 — $connection_upgrade map (E7)', () => {
  const withWs = (websocket: boolean): Model => ({
    ...empty,
    listeners: [{ key: 'web', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true }],
    pools: [{ key: 'api', protocolClass: 'http', algorithm: 'round_robin' }],
    backends: [{ key: 'x', pool: 'api', host: '10.0.2.10', port: 8080, weight: 1 }],
    httpRoutes: [
      { key: 'r1', listener: 'web', hosts: ['api.example.com'], priority: 10,
        action: { kind: 'proxy', pool: 'api', websocket } },
    ],
  });

  it('websocket 라우트가 있으면 map 을 정확히 한 번 렌더한다', () => {
    const conf = render(withWs(true)).conf;
    expect(conf.match(/map \$http_upgrade \$connection_upgrade/g)).toHaveLength(1);
    expect(conf).toContain('proxy_set_header Connection $connection_upgrade;');
  });

  it('websocket 라우트가 여러 개여도 map 은 한 번이다', () => {
    const base = withWs(true);
    const two: Model = {
      ...base,
      httpRoutes: [
        ...base.httpRoutes,
        { key: 'r2', listener: 'web', hosts: ['b.example.com'], priority: 5,
          action: { kind: 'proxy', pool: 'api', websocket: true } },
      ],
    };
    expect(render(two).conf.match(/map \$http_upgrade \$connection_upgrade/g)).toHaveLength(1);
  });

  it('websocket 라우트가 없으면 map 도 없고 참조도 없다', () => {
    const conf = render(withWs(false)).conf;
    expect(conf).not.toContain('$connection_upgrade');
  });
});

describe('R6 / R7 — source_ip_hash 는 서브시스템별로 다르다 (E1, E3)', () => {
  const withAlgo = (protocolClass: 'http' | 'tcp') => {
    const m: Model = {
      ...empty,
      listeners:
        protocolClass === 'http'
          ? [{ key: 'l', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true }]
          : [{ key: 'l', protocol: 'tcp', bind: '0.0.0.0', port: 900, enabled: true, defaultPool: 'p' }],
      pools: [{ key: 'p', protocolClass, algorithm: 'source_ip_hash' }],
      backends: [{ key: 'b', pool: 'p', host: '10.0.0.1', port: 80, weight: 1 }],
      httpRoutes:
        protocolClass === 'http'
          ? [{ key: 'r', listener: 'l', hosts: ['a.example.com'], priority: 1,
               action: { kind: 'proxy', pool: 'p', websocket: false } }]
          : [],
    };
    return render(m).conf;
  };

  it('http 풀은 ip_hash 로 렌더된다', () => {
    expect(withAlgo('http')).toContain('ip_hash;');
  });

  it('stream 풀은 hash $remote_addr consistent 로 렌더된다 — stream 엔 ip_hash 가 없다', () => {
    const conf = withAlgo('tcp');
    expect(conf).toContain('hash $remote_addr consistent;');
    expect(conf).not.toContain('ip_hash;');
  });
});

describe('R8 / R9 — SNI 패스스루 (E21, E26)', () => {
  const passthrough = (onUnmatchedSni: 'reject' | { pool: string }): Model => ({
    ...empty,
    listeners: [
      { key: 'tls', protocol: 'tls_passthrough', bind: '0.0.0.0', port: 443, enabled: true,
        onUnmatchedSni, prereadTimeoutS: 5 },
    ],
    pools: [
      { key: 'mail', protocolClass: 'tcp', algorithm: 'round_robin' },
      { key: 'wild', protocolClass: 'tcp', algorithm: 'round_robin' },
      { key: 'fallback', protocolClass: 'tcp', algorithm: 'round_robin' },
    ],
    backends: [
      { key: 'm', pool: 'mail', host: '10.1.0.1', port: 443, weight: 1 },
      { key: 'w', pool: 'wild', host: '10.1.0.2', port: 443, weight: 1 },
      { key: 'f', pool: 'fallback', host: '10.1.0.3', port: 443, weight: 1 },
    ],
    passthroughRoutes: [
      { key: 'p1', listener: 'tls', snis: ['mail.example.com'], priority: 10, action: { kind: 'proxy', pool: 'mail' } },
      { key: 'p2', listener: 'tls', snis: ['*.example.com'], priority: 5, action: { kind: 'proxy', pool: 'wild' } },
    ],
  });

  it('ssl_preread 를 켜고 preread_timeout 을 렌더한다', () => {
    const conf = render(passthrough('reject')).conf;
    expect(conf).toContain('ssl_preread on;');
    expect(conf).toContain('preread_timeout 5s;');
  });

  it('와일드카드를 대소문자 무시 정규식으로 컴파일한다 — ~ 가 아니라 ~*', () => {
    const conf = render(passthrough('reject')).conf;
    expect(conf).toMatch(/~\*\^.*example\\\.com\$/);
    expect(conf).not.toMatch(/(^|\s)~\^/m);
  });

  it('와일드카드는 한 라벨만 매치한다 — X.509 와 맞춘다 (E22.2)', () => {
    expect(render(passthrough('reject')).conf).toContain('[^.]+');
  });

  it('on_unmatched_sni 폴백을 default 로 렌더한다', () => {
    expect(render(passthrough({ pool: 'fallback' })).conf).toMatch(/default\s+pool_fallback;/);
  });

  // §4.1 — SNI 부재와 파싱 실패는 설정할 수 없다. 언제나 reject.
  it('SNI 가 비면 폴백 풀이 아니라 빈 값으로 간다 — reject 고정', () => {
    const conf = render(passthrough({ pool: 'fallback' })).conf;
    expect(conf).toMatch(/^\s*"" "";$/m);
  });

  it('reject 는 빈 값으로 렌더된다 — proxy_pass 가 실패하고 연결이 끊긴다', () => {
    expect(render(passthrough('reject')).conf).toMatch(/default "";/);
  });

  it('v0 은 $ssl_preread_protocol 분기를 만들지 않는다 — 두 경우의 동작이 같다', () => {
    // E26.1 로 구분은 가능하지만, 동작이 같은 동안 쓰지 않는 분기를 미리 만들지 않는다.
    expect(render(passthrough('reject')).conf).not.toContain('$ssl_preread_protocol');
  });
});

describe('R11 — UDP 프리셋', () => {
  const dns: Model = {
    ...empty,
    listeners: [
      { key: 'dns', protocol: 'udp', bind: '0.0.0.0', port: 8853, enabled: true,
        defaultPool: 'dns-pool', udp: { preset: 'dns' } },
    ],
    pools: [{ key: 'dns-pool', protocolClass: 'udp', algorithm: 'round_robin' }],
    backends: [
      { key: 'd1', pool: 'dns-pool', host: '10.0.1.5', port: 53, weight: 1 },
      { key: 'd2', pool: 'dns-pool', host: '10.0.1.6', port: 53, weight: 1 },
    ],
  };

  it('dns 프리셋이 proxy_responses / proxy_timeout / reuseport 로 떨어진다', () => {
    const conf = render(dns).conf;
    expect(conf).toContain('listen 8853 udp reuseport;');
    expect(conf).toContain('proxy_responses 1;');
    expect(conf).toContain('proxy_timeout 5s;');
  });
});

describe('R12 — PROXY protocol', () => {
  it('tcp 풀의 v1 은 proxy_protocol on 으로 렌더된다', () => {
    const m: Model = {
      ...portRemap,
      pools: portRemap.pools.map((p) =>
        p.key === 'pool-a' ? { ...p, sendProxyProtocol: 'v1' as const } : p,
      ),
    };
    expect(render(m).conf).toContain('proxy_protocol on;');
  });

  it('설정하지 않으면 렌더하지 않는다', () => {
    expect(render(portRemap).conf).not.toContain('proxy_protocol');
  });
});

describe('R15 / R16 — 비활성과 공백', () => {
  it('enabled=false 리스너는 산출물에서 빠진다', () => {
    const m: Model = {
      ...portRemap,
      listeners: portRemap.listeners.map((l) => (l.key === 'alt' ? { ...l, enabled: false } : l)),
    };
    const conf = render(m).conf;
    expect(conf).toContain('listen 999;');
    expect(conf).not.toContain('listen 888;');
  });

  it('빈 모델도 기동 가능한 최소 conf 를 만든다', () => {
    const conf = render(empty).conf;
    expect(conf).toContain('events {');
    expect(conf).not.toContain('undefined');
  });
});

describe('R18 — stream_realip 부재를 렌더가 흡수한다 (E0 대응)', () => {
  const acceptingListener: Model = {
    ...empty,
    listeners: [
      { key: 'edge', protocol: 'tcp', bind: '0.0.0.0', port: 9000, enabled: true,
        defaultPool: 'app', acceptProxyProtocol: true },
    ],
    pools: [{ key: 'app', protocolClass: 'tcp', algorithm: 'source_ip_hash' }],
    backends: [{ key: 'a', pool: 'app', host: '10.0.0.1', port: 443, weight: 1 }],
  };

  it('PROXY 를 수신하고 stream_realip 이 없으면 $proxy_protocol_addr 로 해시한다', () => {
    const conf = render(acceptingListener, { streamRealip: false }).conf;
    expect(conf).toContain('hash $proxy_protocol_addr consistent;');
    expect(conf).not.toContain('hash $remote_addr');
  });

  it('stream_realip 이 있으면 $remote_addr 로 해시한다 — realip 이 이미 덮어썼다', () => {
    const conf = render(acceptingListener, { streamRealip: true }).conf;
    expect(conf).toContain('hash $remote_addr consistent;');
  });

  it('PROXY 를 수신하지 않으면 모듈 유무와 무관하게 $remote_addr 다', () => {
    const noAccept: Model = {
      ...acceptingListener,
      listeners: acceptingListener.listeners.map((l) => ({ ...l, acceptProxyProtocol: false })),
    };
    expect(render(noAccept, { streamRealip: false }).conf).toContain('hash $remote_addr consistent;');
  });

  it('수신 리스너는 listen 에 proxy_protocol 을 붙인다', () => {
    expect(render(acceptingListener, { streamRealip: false }).conf).toContain(
      'listen 9000 proxy_protocol;',
    );
  });

  it('capability 를 주지 않으면 보수적으로(모듈 없음) 렌더한다', () => {
    expect(render(acceptingListener).conf).toContain('hash $proxy_protocol_addr consistent;');
  });
});
