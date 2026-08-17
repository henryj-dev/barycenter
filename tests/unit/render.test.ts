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

/**
 * **R18 을 뒤집었다 — 측정이 앞선 답을 반증했다.**
 *
 * 원래 R18 은 *"stream_realip 이 없으면 `$proxy_protocol_addr` 로 해시한다"* 였다. 근거는
 * "모듈 없이도 실 클라이언트 IP 를 준다" 였고, **그 말 자체는 참이다.** 그런데 E63 으로
 * 재보니 한 가지가 빠져 있었다:
 *
 * | 설정 | `$remote_addr` | `$proxy_protocol_addr` |
 * |---|---|---|
 * | realip 없음 | 실제 peer | **헤더가 말하는 값** |
 * | peer 를 신뢰 | 헤더 값 | 헤더 값 |
 * | peer 를 **불신** | **실제 peer** | 헤더 값 |
 *
 * `$proxy_protocol_addr` 는 **어떤 경우에도 게이팅되지 않는다.** 즉 그 값은 실 클라이언트
 * IP 이면서 동시에 **클라이언트가 정하는 값**이다. 그걸로 해시하면 공격자가 자기를 원하는
 * 백엔드로 몬다 — 열등한 대체물이 아니라 **틀린 대체물**이었다.
 *
 * 이제: 해시는 언제나 `$remote_addr` 이고, 신뢰 경계(`set_real_ip_from`)를 함께 렌더해
 * 그 변수 자체를 옳게 만든다. 엔진이 못 하면(stream + stream_realip 없음) 검증기가 막는다.
 */
describe('R18 (뒤집힘) — 신뢰 경계를 함께 렌더한다 (§4.7 · E63)', () => {
  const accepting: Model = {
    ...empty,
    listeners: [
      { key: 'edge', protocol: 'tcp', bind: '0.0.0.0', port: 9000, enabled: true,
        defaultPool: 'app', acceptProxyProtocol: { trustedCidrs: ['10.0.0.0/8'] } },
    ],
    pools: [{ key: 'app', protocolClass: 'tcp', algorithm: 'source_ip_hash' }],
    backends: [{ key: 'a', pool: 'app', host: '10.0.0.1', port: 443, weight: 1 }],
  };

  it('**해시는 언제나 `$remote_addr`** — 게이팅되지 않는 변수를 안 쓴다', () => {
    const conf = render(accepting, { streamRealip: true }).conf;
    expect(conf).toContain('hash $remote_addr consistent;');
    expect(conf).not.toContain('$proxy_protocol_addr');
  });

  it('**스위치와 잠금이 함께 나간다** — `proxy_protocol` 과 `set_real_ip_from`', () => {
    // 하나만 내면 헤더는 받는데 누구 것이든 받는다.
    const conf = render(accepting, { streamRealip: true }).conf;
    expect(conf).toContain('listen 9000 proxy_protocol;');
    expect(conf).toContain('set_real_ip_from 10.0.0.0/8;');
    expect(conf).toContain('real_ip_header proxy_protocol;');
  });

  it('신뢰 대역을 여러 개 주면 전부 렌더한다', () => {
    const many: Model = {
      ...accepting,
      listeners: [{ ...accepting.listeners[0]!, acceptProxyProtocol: {
        trustedCidrs: ['10.0.0.0/8', '192.168.0.0/16', '2001:db8::/32'],
      } } as Model['listeners'][number]],
    };
    const conf = render(many, { streamRealip: true }).conf;
    expect(conf.match(/set_real_ip_from/g)).toHaveLength(3);
    expect(conf).toContain('set_real_ip_from 2001:db8::/32;');
  });

  it('PROXY 를 수신하지 않으면 realip 을 안 낸다', () => {
    const noAccept: Model = {
      ...accepting,
      listeners: [{ key: 'edge', protocol: 'tcp', bind: '0.0.0.0', port: 9000,
        enabled: true, defaultPool: 'app' }],
    };
    const conf = render(noAccept, { streamRealip: true }).conf;
    expect(conf).not.toContain('set_real_ip_from');
    expect(conf).not.toContain('proxy_protocol');
    expect(conf).toContain('hash $remote_addr consistent;');
  });

  it('**stream 인데 모듈이 없으면 렌더가 아니라 검증에서 막힌다**', () => {
    // 처음엔 "그래도 렌더는 되고 nginx -t 가 막는다" 로 적었는데 틀렸다 —
    // `render()` 가 `validateModel` 을 자기 안에서 다시 돌리므로(fail closed) 여기서
    // 이미 던진다. **게시 전보다 저장 전에 막히는 것이 낫다.**
    expect(() => render(accepting, { streamRealip: false })).toThrow(/stream_realip/);
  });
});

describe('R19 — 명시적 default_server (E32)', () => {
  const web: Model = {
    ...empty,
    listeners: [{ key: 'web', protocol: 'http', bind: '0.0.0.0', port: 8080, enabled: true }],
    pools: [{ key: 'api', protocolClass: 'http', algorithm: 'round_robin' }],
    backends: [{ key: 'x', pool: 'api', host: '10.0.2.10', port: 8080, weight: 1 }],
    httpRoutes: [
      { key: 'r1', listener: 'web', hosts: ['api.example.com'], priority: 10,
        action: { kind: 'proxy', pool: 'api', websocket: false } },
    ],
  };

  // E32: default_server 가 없으면 모르는 Host 가 **첫 번째 server** 로 조용히 들어간다.
  // 멀티테넌트에서는 그게 테넌트 간 누수다.
  it('http 리스너마다 default_server 를 정확히 하나 낸다', () => {
    const conf = render(web).conf;
    expect(conf.match(/listen 8080 default_server;/g)).toHaveLength(1);
  });

  it('기본 동작은 444 로 끊는 것이다 — 임의 테넌트로 보내지 않는다', () => {
    expect(render(web).conf).toMatch(/default_server;[\s\S]*?return 444;/);
  });

  it('default_server 가 첫 server 블록이다 — 순서에 기대지 않지만 읽기 쉽게', () => {
    const conf = render(web).conf;
    expect(conf.indexOf('default_server')).toBeLessThan(conf.indexOf('api.example.com'));
  });

  it('일반 server 블록에는 default_server 가 붙지 않는다', () => {
    const conf = render(web).conf;
    expect(conf.match(/default_server/g)).toHaveLength(1);
  });

  it('defaultAction 을 풀로 지정하면 그리로 보낸다', () => {
    // 판별 유니온이라 `http` 프로필은 http 리스너에만 붙는다. 좁히고 나서 쓴다.
    const first = web.listeners[0]!;
    if (first.protocol !== 'http') throw new Error('픽스처가 http 리스너가 아니다');
    const m: Model = {
      ...web,
      listeners: [{ ...first, http: { defaultAction: { pool: 'api' } } }],
    };
    const conf = render(m).conf;
    expect(conf).toMatch(/default_server;[\s\S]*?proxy_pass http:\/\/pool_api;/);
  });

  it('리스너가 여러 개면 각각 하나씩', () => {
    const m: Model = {
      ...web,
      listeners: [
        web.listeners[0]!,
        { key: 'web2', protocol: 'http', bind: '0.0.0.0', port: 8081, enabled: true },
      ],
    };
    expect(render(m).conf.match(/default_server/g)).toHaveLength(2);
  });
});

describe('R20 — 4차 검수 구현 High', () => {
  const stream = (poolKey: string, host: string): Model => ({
    ...empty,
    listeners: [{ key: 'l', protocol: 'tcp', bind: '0.0.0.0', port: 900, enabled: true, defaultPool: poolKey }],
    pools: [{ key: poolKey, protocolClass: 'tcp', algorithm: 'round_robin' }],
    backends: [{ key: 'b', pool: poolKey, host, port: 443, weight: 1 }],
  });

  // E34: bracket 없으면 `invalid port in upstream`
  it('IPv6 백엔드에 대괄호를 씌운다', () => {
    expect(render(stream('p', '2001:db8::1')).conf).toContain('server [2001:db8::1]:443;');
  });

  it('IPv4 와 DNS 이름은 그대로', () => {
    expect(render(stream('p', '10.0.0.1')).conf).toContain('server 10.0.0.1:443;');
    expect(render(stream('p', 'backend.example.com')).conf).toContain('server backend.example.com:443;');
  });

  // identifier 변환이 비단사면 서로 다른 풀이 같은 upstream 이름을 갖는다 → nginx -t 실패
  it('a-b 와 a_b 는 서로 다른 upstream 이름을 갖는다', () => {
    const m: Model = {
      ...empty,
      listeners: [
        { key: 'l1', protocol: 'tcp', bind: '0.0.0.0', port: 901, enabled: true, defaultPool: 'a-b' },
        { key: 'l2', protocol: 'tcp', bind: '0.0.0.0', port: 902, enabled: true, defaultPool: 'a_b' },
      ],
      pools: [
        { key: 'a-b', protocolClass: 'tcp', algorithm: 'round_robin' },
        { key: 'a_b', protocolClass: 'tcp', algorithm: 'round_robin' },
      ],
      backends: [
        { key: 'x', pool: 'a-b', host: '10.0.0.1', port: 11, weight: 1 },
        { key: 'y', pool: 'a_b', host: '10.0.0.2', port: 11, weight: 1 },
      ],
    };
    const names = [...render(m).conf.matchAll(/upstream (\S+) \{/g)].map((x) => x[1]);
    expect(new Set(names).size, `upstream 이름이 겹쳤다: ${names.join(', ')}`).toBe(2);
  });

  // E33: map 의 제어어는 인용해도 제어어다. 앵커 정규식으로만 리터럴 매칭이 된다.
  it('map 제어어와 겹치는 SNI 는 앵커 정규식으로 낸다', () => {
    const m: Model = {
      ...empty,
      listeners: [
        { key: 'tls', protocol: 'tls_passthrough', bind: '0.0.0.0', port: 443, enabled: true,
          onUnmatchedSni: 'reject' },
      ],
      pools: [{ key: 'p', protocolClass: 'tcp', algorithm: 'round_robin' }],
      backends: [{ key: 'b', pool: 'p', host: '10.0.0.1', port: 443, weight: 1 }],
      passthroughRoutes: [
        { key: 'r', listener: 'tls', snis: ['default'], priority: 1, action: { kind: 'proxy', pool: 'p' } },
      ],
    };
    const conf = render(m).conf;
    expect(conf).toContain('~^default$ pool_p;');
    // 제어어가 그대로 키로 나가면 default 절이 중복되어 nginx -t 가 실패한다
    expect(conf).not.toMatch(/^\s*default pool_p;$/m);
  });

  it('일반 호스트는 정규식으로 바꾸지 않는다', () => {
    const m: Model = {
      ...empty,
      listeners: [
        { key: 'tls', protocol: 'tls_passthrough', bind: '0.0.0.0', port: 443, enabled: true,
          onUnmatchedSni: 'reject' },
      ],
      pools: [{ key: 'p', protocolClass: 'tcp', algorithm: 'round_robin' }],
      backends: [{ key: 'b', pool: 'p', host: '10.0.0.1', port: 443, weight: 1 }],
      passthroughRoutes: [
        { key: 'r', listener: 'tls', snis: ['mail.example.com'], priority: 1, action: { kind: 'proxy', pool: 'p' } },
      ],
    };
    expect(render(m).conf).toContain('mail.example.com pool_p;');
  });
});

describe('R21 — 호스트 매칭이 X.509 계약과 엔진 동작에 맞는가', () => {
  const httpWith = (hosts: string[][]): Model => ({
    ...empty,
    listeners: [{ key: 'web', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true }],
    pools: [{ key: 'p', protocolClass: 'http', algorithm: 'round_robin' }],
    backends: [{ key: 'b', pool: 'p', host: '10.0.0.1', port: 80, weight: 1 }],
    httpRoutes: hosts.map((h, i) => ({
      key: `r${i}`, listener: 'web', hosts: h, priority: 10 - i,
      action: { kind: 'proxy' as const, pool: 'p', websocket: false },
    })),
  });

  // E22.2: nginx 의 *.example.com 은 다중 라벨을 삼킨다.
  // E35: 앵커 정규식은 한 라벨만 매치한다 — 패스스루와 같은 계약이어야 한다.
  it('HTTP 와일드카드도 1라벨 앵커 정규식으로 낸다', () => {
    const conf = render(httpWith([['*.example.com']])).conf;
    expect(conf).toContain('server_name ~^[^.]+\\.example\\.com$;');
    expect(conf).not.toContain('server_name *.example.com;');
  });

  it('정확일치는 그대로 낸다', () => {
    expect(render(httpWith([['api.example.com']])).conf).toContain('server_name api.example.com;');
  });

  // E36: 겹치는 server_name 은 경고만 나고 첫 블록이 이긴다 → 모델이 막아야 한다
  it('호스트가 부분적으로 겹치는 라우트는 저장이 거부된다', () => {
    expect(() => render(httpWith([['a.test', 'b.test'], ['b.test', 'c.test']]))).toThrow();
  });

  it('여러 호스트를 가진 라우트는 호스트마다 server 블록을 낸다', () => {
    const conf = render(httpWith([['a.test', 'b.test']])).conf;
    expect(conf).toContain('server_name a.test;');
    expect(conf).toContain('server_name b.test;');
  });
});

/**
 * **R22 도 뒤집혔다.** 원래 규칙은 *"한 풀을 PROXY 수신 리스너와 일반 리스너가 함께 쓰면
 * 거부한다"* 였고, 이유는 *"일반 리스너에서는 `$proxy_protocol_addr` 가 비어 모든
 * 클라이언트가 한 peer 로 몰린다"* 였다.
 *
 * 그 실패 모드는 **사라졌다** — 이제 해시가 언제나 `$remote_addr` 라 어느 리스너로 와도
 * 값이 있다. 대신 더 앞의 질문이 규칙이 됐다: **신뢰 경계를 걸 수 있는 엔진인가.**
 */
describe('R22 (뒤집힘) — stream 에서 PROXY 를 받으려면 stream_realip 이 있어야 한다', () => {
  const shared: Model = {
    ...empty,
    listeners: [
      { key: 'edge', protocol: 'tcp', bind: '0.0.0.0', port: 9000, enabled: true,
        defaultPool: 'shared', acceptProxyProtocol: { trustedCidrs: ['10.0.0.0/8'] } },
      { key: 'direct', protocol: 'tcp', bind: '0.0.0.0', port: 9001, enabled: true,
        defaultPool: 'shared' },
    ],
    pools: [{ key: 'shared', protocolClass: 'tcp', algorithm: 'source_ip_hash' }],
    backends: [{ key: 'b', pool: 'shared', host: '10.0.0.1', port: 443, weight: 1 }],
  };

  it('모듈이 없으면 거부된다 — 신뢰 경계를 걸 수 없기 때문이다', () => {
    expect(() => render(shared, { streamRealip: false })).toThrow(/stream_realip/);
  });

  it('**풀 공유 자체는 이제 문제가 아니다** — 두 리스너 다 `$remote_addr` 를 쓴다', () => {
    // 옛 규칙이 막던 조합이다. 막던 이유(빈 변수)가 사라졌으므로 통과가 옳다.
    const conf = render(shared, { streamRealip: true }).conf;
    expect(conf).toContain('hash $remote_addr consistent;');
    // 신뢰 경계는 **PROXY 를 받는 리스너에만** 붙는다.
    expect(conf.match(/set_real_ip_from/g)).toHaveLength(1);
  });

  it('**http 리스너는 모듈 유무와 무관하다** — http_realip 은 별개다', () => {
    const web: Model = {
      ...empty,
      listeners: [{ key: 'web', protocol: 'http', bind: '0.0.0.0', port: 8080, enabled: true,
        acceptProxyProtocol: { trustedCidrs: ['172.16.0.0/12'] },
        http: { defaultAction: { pool: 'api' } } }],
      pools: [{ key: 'api', protocolClass: 'http', algorithm: 'round_robin' }],
      backends: [{ key: 'x', pool: 'api', host: '10.0.2.10', port: 8080, weight: 1 }],
    };
    const conf = render(web, { streamRealip: false }).conf;
    expect(conf).toContain('set_real_ip_from 172.16.0.0/12;');
  });
});
