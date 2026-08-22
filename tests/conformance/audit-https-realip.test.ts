/**
 * 검수 2026-08-22 · S-02 — **https 의 PROXY 수신에도 신뢰 경계가 걸린다**
 *
 * `realipNodes` 가 `protocol === 'http'` 일 때만 `real_ip_header proxy_protocol` 을 냈다.
 * 그런데 **https 도 http 컨텍스트**다. 그래서 https 리스너에는 `set_real_ip_from` 만
 * 나갔고, nginx 의 기본 `real_ip_header` 는 `X-Real-IP` 다 — PROXY 헤더의 주소가
 * `$remote_addr` 에 안 올라가고, 대신 신뢰 대역 안의 앞단이 넘긴 **HTTP 헤더**가 올라간다.
 *
 * 앞단이 그 헤더를 정리하지 않으면 클라이언트가 자기 IP 를 정한다. `ip_hash` peer 선택과
 * `$proxy_add_x_forwarded_for` 가 전부 그 값을 믿는다 — 렌더러 주석이 "막았다" 고 적어 둔
 * 바로 그 상태다.
 *
 * 같은 혼동이 검증기에도 있었다. `validateModel` 은 https + PROXY 에 `stream_realip` 을
 * 요구했는데 https 는 stream 이 아니다. OpenResty 에는 `stream_realip` 이 없으므로
 * **https 의 PROXY 수신이 아예 저장 불가**였다.
 */
import { describe, expect, it } from 'vitest';

import { render } from '../../src/conf/render.js';
import { validateModel } from '../../src/validate/model.js';
import type { Model } from '../../src/model/provisional.js';

const REF = `store://c@${'a'.repeat(32)}`;

/** http · https 를 나란히 둔다 — 둘이 같은 대접을 받는지가 요점이다. */
const model = (): Model => ({
  listeners: [
    {
      key: 'plain', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true,
      acceptProxyProtocol: { trustedCidrs: ['10.0.0.0/8'] },
      http: { defaultAction: { pool: 'app' } },
    },
    {
      key: 'secure', protocol: 'https', bind: '0.0.0.0', port: 443, enabled: true,
      acceptProxyProtocol: { trustedCidrs: ['10.0.0.0/8'] },
      tls: { policy: 'pol', defaultCertificate: 'c' },
      http: { defaultAction: { pool: 'app' } },
    },
  ],
  httpRoutes: [],
  passthroughRoutes: [],
  pools: [{ key: 'app', protocolClass: 'http', algorithm: 'round_robin' }],
  backends: [{ key: 'a', pool: 'app', host: '10.0.0.1', port: 8080, weight: 1 }],
  certificates: [{
    key: 'c', materialRef: REF,
    chainDigest: `sha256:${'a'.repeat(64)}`, keyDigest: `sha256:${'b'.repeat(64)}`,
  }],
  tlsPolicies: [{ key: 'pol', minVersion: '1.2' }],
  sniBindings: [],
});

/** `listen ... ssl` 을 담은 server 블록만 잘라 낸다. */
function serverBlocks(conf: string): string[] {
  return conf.split(/\n(?=    server \{)/).filter((b) => b.includes('server {'));
}

describe('https 의 PROXY 신뢰 경계 (검수 S-02)', () => {
  it('https 는 PROXY 주소를 remote_addr 로 올린다', () => {
    const conf = render(model(), { streamRealip: true }).conf;

    // **PROXY 를 켠 server 블록마다** 둘이 함께 나가야 한다. 하나만 나가면
    // 스위치는 켜졌는데 잠금이 없는 상태다.
    const withProxy = serverBlocks(conf).filter((b) => b.includes('proxy_protocol'));
    expect(withProxy.length).toBeGreaterThan(0);
    for (const block of withProxy) {
      expect(block).toContain('set_real_ip_from 10.0.0.0/8;');
      expect(block).toContain('real_ip_header proxy_protocol;');
    }
  });

  it('https 의 PROXY 수신은 stream_realip 을 요구하지 않는다', () => {
    // https 는 http 컨텍스트다 — stream 모듈과 무관하다.
    const issues = validateModel(model(), { streamRealip: false });
    expect(issues.map((i) => i.message).join('\n')).not.toContain('stream_realip');
    expect(issues).toEqual([]);
  });

  it('그래도 stream 리스너의 PROXY 수신은 여전히 stream_realip 을 요구한다', () => {
    // 넓히다가 원래 막던 것까지 열면 안 된다.
    const m = model();
    m.listeners = [{
      key: 'tcp-front', protocol: 'tcp', bind: '0.0.0.0', port: 9000, enabled: true,
      acceptProxyProtocol: { trustedCidrs: ['10.0.0.0/8'] },
      defaultPool: 'app',
    }];
    m.pools = [{ key: 'app', protocolClass: 'tcp', algorithm: 'round_robin' }];
    m.certificates = [];
    m.tlsPolicies = [];

    const issues = validateModel(m, { streamRealip: false });
    expect(issues.map((i) => i.message).join('\n')).toContain('stream_realip');
  });
});
