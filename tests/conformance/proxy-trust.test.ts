/**
 * 인바운드 PROXY 의 **신뢰 경계** (DESIGN.md §4.7 · E63)
 *
 * §4.7 은 `trusted_proxy_cidrs` 를 *"필수, 비어 있을 수 없다. 없으면 source IP 스푸핑"*
 * 이라고 적어 뒀는데, 구현은 **불리언 하나**였다. 문서만 읽으면 있다고 믿게 되는 상태라
 * §4.7 자체가 거짓이었다.
 *
 * 엔진으로 재고 나서야 얼마나 나쁜지가 분명해졌다(E63):
 *
 *   realip 없음   `$proxy_protocol_addr` = **헤더가 말하는 값**
 *   peer 불신     `$remote_addr` 는 안 바뀌지만 `$proxy_protocol_addr` 는 **여전히 헤더 값**
 *
 * 그리고 렌더러는 그 변수로 소스IP 해시를 계산하고 있었다 — **클라이언트가 자기를 원하는
 * 백엔드로 몰 수 있었다.** "실 클라이언트 기준" 이 아니라 "공격자 기준" 이었던 셈이다.
 *
 * 여기서 고정하는 것: **안전하지 않은 설정을 표현할 수 없다.**
 */
import { describe, expect, it } from 'vitest';

import { decodeModel } from '../../src/model/decode.js';
import { render } from '../../src/conf/render.js';
import type { Model } from '../../src/model/provisional.js';

const empty: Model = {
  listeners: [], httpRoutes: [], passthroughRoutes: [], certificates: [], tlsPolicies: [], sniBindings: [], pools: [], backends: [],
};

const withListener = (accept: unknown): unknown => ({
  ...empty,
  listeners: [{
    key: 'edge', protocol: 'http', bind: '0.0.0.0', port: 8080, enabled: true,
    acceptProxyProtocol: accept,
  }],
});

const codes = (input: unknown): string[] => {
  const r = decodeModel(input);
  return r.ok ? [] : r.issues.map((i) => i.code);
};

describe('신뢰 경계 없이는 켤 수 없다 (§4.7)', () => {
  it('**옛 불리언 모양을 거부한다** — 관대하게 받으면 그게 기본값이 된다', () => {
    expect(codes(withListener(true))).toContain('invalid_type');
    // 그리고 무엇으로 바꿔야 하는지 말해 준다. 거부만 하고 길을 안 알려주면
    // 사용자는 그 기능을 그냥 안 쓰거나 잘못 쓴다.
    const r = decodeModel(withListener(true));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.message).join()).toMatch(/trustedCidrs/);
  });

  it('`false` 도 거부한다 — 끄려면 필드를 안 쓴다', () => {
    // `false` 를 받아 주면 "켜기" 와 "끄기" 가 같은 필드의 두 값이 되고, 그러면
    // 실수로 `true` 를 쓰는 길이 다시 열린다.
    expect(codes(withListener(false))).toContain('invalid_type');
  });

  it('**빈 목록을 거부한다** — 아무도 안 믿을 거면 켜지 않는다', () => {
    expect(codes(withListener({ trustedCidrs: [] }))).toContain('out_of_range');
  });

  it('`trustedCidrs` 가 없으면 거부한다', () => {
    expect(codes(withListener({}))).toContain('missing_field');
  });

  it('모르는 필드를 조용히 무시하지 않는다 — 오타가 설정을 날린다', () => {
    expect(codes(withListener({ trustedCidrs: ['10.0.0.0/8'], trustedCidr: ['x'] })))
      .toContain('unknown_field');
  });

  it('제대로 주면 통과한다', () => {
    expect(codes(withListener({ trustedCidrs: ['10.0.0.0/8'] }))).toEqual([]);
  });
});

describe('스위치와 잠금은 함께 나간다', () => {
  const model: Model = {
    ...empty,
    listeners: [{
      key: 'edge', protocol: 'http', bind: '0.0.0.0', port: 8080, enabled: true,
      acceptProxyProtocol: { trustedCidrs: ['10.0.0.0/8'] },
      http: { defaultAction: { pool: 'api' } },
    }],
    pools: [{ key: 'api', protocolClass: 'http', algorithm: 'source_ip_hash' }],
    backends: [{ key: 'x', pool: 'api', host: '10.0.2.10', port: 8080, weight: 1 }],
  };

  it('`proxy_protocol` 을 냈으면 `set_real_ip_from` 도 낸다', () => {
    const conf = render(model).conf;
    expect(conf).toContain('proxy_protocol');
    expect(conf).toContain('set_real_ip_from 10.0.0.0/8;');
    expect(conf).toContain('real_ip_header proxy_protocol;');
  });

  it('**해시가 게이팅되지 않는 변수를 안 쓴다**', () => {
    // 이 한 줄이 이 파일의 요점이다.
    expect(render(model).conf).not.toContain('$proxy_protocol_addr');
  });

  it('PROXY 를 안 받는 리스너에는 realip 이 안 붙는다', () => {
    const off: Model = {
      ...model,
      listeners: [{
        key: 'edge', protocol: 'http', bind: '0.0.0.0', port: 8080, enabled: true,
        http: { defaultAction: { pool: 'api' } },
      }],
    };
    expect(render(off).conf).not.toContain('set_real_ip_from');
  });
});
