/**
 * **헤더로 받는 원본 IP** (2026-10-18, §4.7 의 HTTP 판)
 *
 * Cloudflare 일반 프록시처럼 PROXY protocol 을 안 보내는 앞단은 원본 IP 를 HTTP 헤더로
 * 넘긴다. 그 헤더를 쓰는 자리를 열되, PROXY 수신(004)과 **같은 잠금**을 건다:
 *
 *   · 신뢰 대역 없이는 표현할 수 없다 — 헤더는 누구나 붙인다
 *   · 헤더 이름은 고르는 값이다 — 오타면 realip 이 조용히 아무 일도 안 한다
 *   · http·https 에만 — 헤더는 HTTP 를 푼 뒤에만 보인다
 *   · PROXY 수신과 같이 못 켠다 — `real_ip_header` 는 server 마다 하나다
 */
import { describe, expect, it } from 'vitest';

import { render } from '../../src/conf/render.js';
import { decodeModel } from '../../src/model/decode.js';
import { validateModel } from '../../src/validate/model.js';
import type { Model, RawListener } from '../../src/model/provisional.js';

const REF = `store://c@${'a'.repeat(32)}`;
const CF = { header: 'CF-Connecting-IP', trustedCidrs: ['173.245.48.0/20', '2400:cb00::/32'] } as const;

const model = (listeners: RawListener[]): Model => ({
  listeners: listeners as Model['listeners'],
  httpRoutes: [],
  passthroughRoutes: [],
  pools: [
    { key: 'app', protocolClass: 'http', algorithm: 'round_robin' },
    { key: 'l4', protocolClass: 'tcp', algorithm: 'round_robin' },
  ],
  backends: [
    { key: 'a', pool: 'app', host: '10.0.0.1', port: 8080, weight: 1 },
    { key: 'b', pool: 'l4', host: '10.0.0.2', port: 9000, weight: 1 },
  ],
  certificates: [{
    key: 'c', materialRef: REF,
    chainDigest: `sha256:${'a'.repeat(64)}`, keyDigest: `sha256:${'b'.repeat(64)}`,
  }],
  tlsPolicies: [{ key: 'pol', minVersion: '1.2' }],
  sniBindings: [],
});

const plain = (extra: Partial<RawListener> = {}): RawListener => ({
  key: 'plain', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true,
  http: { defaultAction: { pool: 'app' } }, ...extra,
});
const secure = (extra: Partial<RawListener> = {}): RawListener => ({
  key: 'secure', protocol: 'https', bind: '0.0.0.0', port: 443, enabled: true,
  tls: { policy: 'pol', defaultCertificate: 'c' },
  http: { defaultAction: { pool: 'app' } }, ...extra,
});

/** 해독기에 리스너 하나를 통과시키고 이슈 경로만 돌려받는다. */
function decodeIssues(listener: unknown): string[] {
  const m = { ...model([]), listeners: [listener] };
  const r = decodeModel(m);
  return r.ok ? [] : r.issues.map((i) => `${i.code} ${i.subjects.join(",")}`);
}

function serverBlocks(conf: string): string[] {
  return conf.split(/\n(?=    server \{)/).filter((b) => b.includes('server {'));
}

describe('헤더 realip — 해독기', () => {
  it('헤더와 신뢰 대역을 함께 적으면 받는다', () => {
    expect(decodeIssues(plain({ realIpFromHeader: { ...CF, trustedCidrs: [...CF.trustedCidrs] } }))).toEqual([]);
  });

  it('**신뢰 대역이 없거나 비면 거부한다**', () => {
    expect(decodeIssues(plain({ realIpFromHeader: { header: 'CF-Connecting-IP' } as never })).join('\n'))
      .toContain('trustedCidrs');
    expect(decodeIssues(plain({ realIpFromHeader: { header: 'CF-Connecting-IP', trustedCidrs: [] } })).join('\n'))
      .toContain('out_of_range');
  });

  it('목록에 없는 헤더 이름은 거부한다 (오타가 realip 을 조용히 끄지 않게)', () => {
    const iss = decodeIssues(plain({
      realIpFromHeader: { header: 'X-Forwarded-Fro', trustedCidrs: ['10.0.0.0/8'] } as never,
    }));
    expect(iss.join('\n')).toContain('realIpFromHeader.header');
  });

  it('불리언·모르는 키는 거부한다', () => {
    expect(decodeIssues(plain({ realIpFromHeader: true as never })).length).toBeGreaterThan(0);
    expect(decodeIssues(plain({
      realIpFromHeader: { ...CF, trustedCidrs: ['10.0.0.0/8'], recursive: false } as never,
    })).length).toBeGreaterThan(0);
  });

  it('stream 리스너에는 그 키 자체가 없다', () => {
    const tcp = { key: 't', protocol: 'tcp', bind: '0.0.0.0', port: 9000, enabled: true,
      defaultPool: 'l4', realIpFromHeader: { header: 'X-Real-IP', trustedCidrs: ['10.0.0.0/8'] } };
    expect(decodeIssues(tcp).length).toBeGreaterThan(0);
  });
});

describe('헤더 realip — 검증기', () => {
  it('http·https 에서는 통과한다', () => {
    const m = model([
      plain({ realIpFromHeader: { ...CF, trustedCidrs: [...CF.trustedCidrs] } }),
      secure({ realIpFromHeader: { header: 'X-Forwarded-For', trustedCidrs: ['10.0.0.0/8'] } }),
    ]);
    expect(validateModel(m, { streamRealip: false })).toEqual([]);
  });

  it('**PROXY 수신과 같이 적으면 막는다** — 원본 IP 의 출처는 하나다', () => {
    const m = model([plain({
      acceptProxyProtocol: { trustedCidrs: ['10.0.0.0/8'] },
      realIpFromHeader: { ...CF, trustedCidrs: [...CF.trustedCidrs] },
    })]);
    const issues = validateModel(m, { streamRealip: true });
    expect(issues.map((i) => i.message).join('\n')).toContain('출처는 하나만');
  });

  it('stream 리스너에 적힌 값은 막는다', () => {
    const m = model([{
      key: 't', protocol: 'tcp', bind: '0.0.0.0', port: 9000, enabled: true, defaultPool: 'l4',
      realIpFromHeader: { header: 'X-Real-IP', trustedCidrs: ['10.0.0.0/8'] },
    }]);
    const issues = validateModel(m, { streamRealip: true });
    expect(issues.some((i) => i.code === 'option_not_supported' && i.message.includes('realIpFromHeader')))
      .toBe(true);
  });
});

describe('헤더 realip — 렌더', () => {
  it('**신뢰 대역 · 헤더 · recursive 가 같은 server 블록에 함께 나간다** (http·https)', () => {
    const conf = render(model([
      plain({ realIpFromHeader: { ...CF, trustedCidrs: [...CF.trustedCidrs] } }),
      secure({ realIpFromHeader: { header: 'X-Forwarded-For', trustedCidrs: ['10.0.0.0/8'] } }),
    ]), { streamRealip: false }).conf;

    const cf = serverBlocks(conf).filter((b) => b.includes('real_ip_header CF-Connecting-IP;'));
    expect(cf.length).toBeGreaterThan(0);
    for (const b of cf) {
      expect(b).toContain('set_real_ip_from 173.245.48.0/20;');
      expect(b).toContain('set_real_ip_from 2400:cb00::/32;');
      expect(b).toContain('real_ip_recursive on;');
      expect(b).not.toContain('proxy_protocol');
    }

    const xff = serverBlocks(conf).filter((b) => b.includes('real_ip_header X-Forwarded-For;'));
    expect(xff.length).toBeGreaterThan(0);
    for (const b of xff) {
      expect(b).toContain('set_real_ip_from 10.0.0.0/8;');
      expect(b).toContain('real_ip_recursive on;');
    }
  });

  it('안 적으면 realip 디렉티브가 하나도 안 나간다', () => {
    const conf = render(model([plain()]), { streamRealip: false }).conf;
    expect(conf).not.toContain('set_real_ip_from');
    expect(conf).not.toContain('real_ip_header');
  });

  it('PROXY 수신의 렌더는 그대로다 (넓히다가 원래 것을 바꾸지 않는다)', () => {
    const conf = render(model([plain({ acceptProxyProtocol: { trustedCidrs: ['10.0.0.0/8'] } })]),
      { streamRealip: false }).conf;
    expect(conf).toContain('real_ip_header proxy_protocol;');
    expect(conf).not.toContain('real_ip_recursive');
  });
});
