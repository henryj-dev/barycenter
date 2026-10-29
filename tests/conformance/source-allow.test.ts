/**
 * **리스너 출발지 제한** (`sourceAllow`, 2026-10-29)
 *
 * Cloudflare 프록시 뒤의 오리진처럼 정해진 앞단만 연결해야 하는 리스너가 있다. 방화벽 말고는
 * 정할 자리가 없었다. 여기서 재는 것:
 *
 *   · 모양 — CIDR 이나 주소 하나, 비어 있을 수 없다, 중복은 거절, 존 ID 는 거절
 *   · 모든 프로토콜에 붙는다
 *   · stream 에서 PROXY 수신과 같이 못 쓴다 (stream realip 이 주소를 바꾼 뒤 `allow` 가 돈다)
 *   · 렌더 — http 계열은 `geo $realip_remote_addr` + **모든** server 블록의 `if … 444`,
 *     stream 은 `allow …; deny all;`
 *   · 안 적으면 렌더 바이트가 그대로다 (안 건드린 배포가 세대 전환을 하지 않는다)
 *
 * 실제 엔진이 막는지는 `tests/golden/source-allow.test.ts` 가 잰다.
 */
import { describe, expect, it } from 'vitest';

import { render } from '../../src/conf/render.js';
import { decodeModel } from '../../src/model/decode.js';
import { validateModel } from '../../src/validate/model.js';
import { cidrVersion } from '../../src/validate/ip.js';
import type { Model, RawListener } from '../../src/model/provisional.js';

const REF = `store://c@${'a'.repeat(32)}`;
const CF = ['173.245.48.0/20', '2400:cb00::/32'];

const model = (listeners: RawListener[], extra: Partial<Model> = {}): Model => ({
  listeners: listeners as Model['listeners'],
  httpRoutes: [],
  passthroughRoutes: [],
  pools: [
    { key: 'app', protocolClass: 'http', algorithm: 'round_robin' },
    { key: 'l4', protocolClass: 'tcp', algorithm: 'round_robin' },
    { key: 'dns', protocolClass: 'udp', algorithm: 'round_robin' },
  ],
  backends: [
    { key: 'a', pool: 'app', host: '10.0.0.1', port: 8080, weight: 1 },
    { key: 'b', pool: 'l4', host: '10.0.0.2', port: 9000, weight: 1 },
    { key: 'c', pool: 'dns', host: '10.0.0.3', port: 53, weight: 1 },
  ],
  certificates: [{
    key: 'c', materialRef: REF,
    chainDigest: `sha256:${'a'.repeat(64)}`, keyDigest: `sha256:${'b'.repeat(64)}`,
  }],
  tlsPolicies: [{ key: 'pol', minVersion: '1.2' }],
  sniBindings: [],
  ...extra,
});

const http = (extra: Partial<RawListener> = {}): RawListener => ({
  key: 'web', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true,
  http: { defaultAction: { pool: 'app' } }, ...extra,
});
const https = (extra: Partial<RawListener> = {}): RawListener => ({
  key: 'tls', protocol: 'https', bind: '0.0.0.0', port: 443, enabled: true,
  tls: { policy: 'pol', defaultCertificate: 'c' },
  http: { defaultAction: { pool: 'app' } }, ...extra,
});
const tcp = (extra: Partial<RawListener> = {}): RawListener => ({
  key: 'l4', protocol: 'tcp', bind: '0.0.0.0', port: 9000, enabled: true, defaultPool: 'l4', ...extra,
});
const udp = (extra: Partial<RawListener> = {}): RawListener => ({
  key: 'u', protocol: 'udp', bind: '0.0.0.0', port: 53, enabled: true, defaultPool: 'dns',
  udp: { preset: 'dns' }, ...extra,
});
const pass = (extra: Partial<RawListener> = {}): RawListener => ({
  key: 'pt', protocol: 'tls_passthrough', bind: '0.0.0.0', port: 8443, enabled: true,
  onUnmatchedSni: { pool: 'l4' }, ...extra,
});

/** 해독기에 리스너 하나를 통과시키고 이슈를 `코드 경로` 로 돌려받는다. */
function decodeIssues(listener: unknown): string[] {
  const r = decodeModel({ ...model([]), listeners: [listener] });
  return r.ok ? [] : r.issues.map((i) => `${i.code} ${i.subjects.join(',')}`);
}

function confOf(listeners: RawListener[], extra: Partial<Model> = {}): string {
  const m = model(listeners, extra);
  expect(validateModel(m)).toEqual([]);
  return render(m).conf;
}

/** `server {` 로 시작하는 블록들. 들여쓰기 4칸이 http·stream 안의 server 다. */
function serverBlocks(conf: string): string[] {
  return conf.split(/\n(?=    server \{)/).filter((b) => b.trimStart().startsWith('server {'));
}

describe('cidrVersion — nginx 의 allow·geo 가 읽는 모양', () => {
  it.each([
    ['173.245.48.0/20', 4], ['2400:cb00::/32', 6], ['203.0.113.7', 4], ['::1', 6],
    ['0.0.0.0/0', 4], ['::/0', 6], ['10.0.0.1/8', 4],
  ])('%s 를 받는다', (s, v) => { expect(cidrVersion(s)).toBe(v); });

  it.each([
    '10.0.0.0/33', '::/129', '10.0.0.0/08', '10.0.0.0/', 'fe80::1%eth0', 'fe80::1%eth0/64',
    'example.com', '10.0.0.0/8/8', '', '01.2.3.4/8',
  ])('%s 는 안 받는다', (s) => { expect(cidrVersion(s)).toBe(0); });
});

describe('해독', () => {
  it('모든 프로토콜에 붙는다', () => {
    for (const l of [http(), https(), tcp(), udp(), pass()]) {
      expect(decodeIssues({ ...l, sourceAllow: CF }), l.protocol).toEqual([]);
    }
  });

  it('**비어 있을 수 없다** — 「제한 없음」은 필드 생략, 「아무도」는 enabled: false', () => {
    expect(decodeIssues(http({ sourceAllow: [] }))).toEqual([expect.stringMatching(/^out_of_range/)]);
  });

  it('CIDR 이 아닌 값은 그 위치로 짚는다', () => {
    const r = decodeModel({ ...model([]), listeners: [http({ sourceAllow: ['10.0.0.0/8', 'cloudflare'] })] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues).toEqual([expect.objectContaining({ code: 'invalid_value' })]);
    expect(JSON.stringify(r.issues)).toContain('sourceAllow[1]');
  });

  it('중복은 거절한다 — 조용히 접으면 적은 것과 저장된 것이 달라진다', () => {
    expect(decodeIssues(http({ sourceAllow: ['10.0.0.0/8', '10.0.0.0/8'] })))
      .toEqual([expect.stringMatching(/^duplicate/)]);
  });

  it('문자열 배열이 아니면 거절한다', () => {
    expect(decodeIssues(http({ sourceAllow: '10.0.0.0/8' as unknown as string[] })))
      .toEqual([expect.stringMatching(/^invalid_type/)]);
  });
});

describe('검증 — stream 에서 PROXY 수신과는 같이 못 쓴다', () => {
  const pp = { trustedCidrs: ['10.0.0.0/8'] };

  it.each([['tcp', tcp], ['tls_passthrough', pass]] as const)(
    '%s 는 sourceAllow + acceptProxyProtocol 을 막는다', (_, mk) => {
      const issues = validateModel(model([mk({ sourceAllow: CF, acceptProxyProtocol: pp })]), { streamRealip: true });
      expect(issues.map((i) => i.code)).toContain('option_not_supported');
      expect(issues.some((i) => /sourceAllow/.test(i.message))).toBe(true);
    });

  it('http 는 PROXY 수신과 같이 쓸 수 있다 — `$realip_remote_addr` 가 바뀌기 전 주소다', () => {
    expect(validateModel(model([http({ sourceAllow: CF, acceptProxyProtocol: pp })]))).toEqual([]);
  });
});

describe('렌더 — http 계열', () => {
  it('geo 는 http 블록에, **바뀌기 전** 주소(`$realip_remote_addr`)로 판다', () => {
    const conf = confOf([http({ sourceAllow: CF })]);
    expect(conf).toContain('geo $realip_remote_addr $bary_src_deny_web {');
    expect(conf).toMatch(/default 1;\s+173\.245\.48\.0\/20 0;\s+2400:cb00::\/32 0;/);
    // geo 가 그것을 쓰는 server 블록보다 앞이다.
    expect(conf.indexOf('geo $realip_remote_addr')).toBeLessThan(conf.indexOf('server {'));
  });

  it('`allow` 를 안 낸다 — access 단계라 realip 뒤 주소를 보고, rewrite 의 return 보다 늦다', () => {
    const conf = confOf([http({ sourceAllow: CF })]);
    const httpPart = conf.slice(conf.indexOf('http {'), conf.indexOf('stream {') < 0 ? undefined : conf.indexOf('stream {'));
    expect(httpPart).not.toMatch(/^\s*allow /m);
  });

  it('**모든** server 블록에 가드가 선다 — default_server 와 호스트 블록, redirect 라우트까지', () => {
    const conf = confOf([http({ sourceAllow: CF })], {
      httpRoutes: [
        { key: 'r1', listener: 'web', hosts: ['a.example.com'], priority: 0, action: { kind: 'proxy', pool: 'app', websocket: false } },
        { key: 'r2', listener: 'web', hosts: ['b.example.com'], priority: 0, action: { kind: 'redirect', to: 'https://x.example.com', status: 302 } },
      ],
    });
    const servers = serverBlocks(conf).filter((b) => /listen 80[ ;]/.test(b));
    expect(servers.length).toBe(3);
    for (const b of servers) expect(b).toMatch(/if \(\$bary_src_deny_web\) \{\s+return 444;/);
  });

  it('가드는 server 레벨이다 — location 안이 아니다', () => {
    const conf = confOf([http({ sourceAllow: CF })]);
    const b = serverBlocks(conf).find((x) => /listen 80[ ;]/.test(x))!;
    expect(b.indexOf('if ($bary_src_deny_web)')).toBeLessThan(b.indexOf('location'));
  });

  it('https 도 같다 — 리스너마다 변수가 갈린다', () => {
    const conf = confOf([http({ sourceAllow: ['10.0.0.0/8'] }), https({ sourceAllow: CF })]);
    expect(conf).toContain('$bary_src_deny_web');
    expect(conf).toContain('$bary_src_deny_tls');
    const tlsServer = serverBlocks(conf).find((x) => /listen 443/.test(x))!;
    expect(tlsServer).toContain('if ($bary_src_deny_tls)');
    expect(tlsServer).not.toContain('$bary_src_deny_web');
  });

  it('realIpFromHeader 와 같이 쓴다 — Cloudflare 대역만 받고 방문자 IP 를 꺼낸다', () => {
    const conf = confOf([http({
      sourceAllow: CF, realIpFromHeader: { header: 'CF-Connecting-IP', trustedCidrs: CF },
    })]);
    expect(conf).toContain('real_ip_header CF-Connecting-IP;');
    expect(conf).toContain('geo $realip_remote_addr $bary_src_deny_web');
  });
});

describe('렌더 — stream', () => {
  it.each([['tcp', tcp], ['udp', udp], ['tls_passthrough', pass]] as const)(
    '%s 는 allow 들 + deny all', (_, mk) => {
      const conf = confOf([mk({ sourceAllow: CF })]);
      const stream = conf.slice(conf.indexOf('stream {'));
      expect(stream).toMatch(/allow 173\.245\.48\.0\/20;\s+allow 2400:cb00::\/32;\s+deny all;/);
      expect(stream).not.toContain('geo ');
    });

  it('패스스루는 preread 보다 앞에 막는다 — 막을 연결의 ClientHello 를 읽을 이유가 없다', () => {
    const conf = confOf([pass({ sourceAllow: CF })]);
    expect(conf.indexOf('deny all;')).toBeLessThan(conf.indexOf('ssl_preread on;'));
  });
});

describe('안 적으면 아무것도 안 바뀐다', () => {
  it('렌더 바이트가 그대로다 — 안 건드린 배포가 세대 전환을 하지 않는다', () => {
    const before = confOf([http(), tcp(), pass(), udp()]);
    expect(before).not.toContain('bary_src_deny');
    expect(before).not.toMatch(/^\s*(allow|deny) /m);
  });

  it('제한이 없는 리스너는 다른 리스너의 제한에 안 걸린다', () => {
    const conf = confOf([http({ sourceAllow: CF }), http({ key: 'open', port: 8080 })]);
    const open = serverBlocks(conf).find((x) => /listen 8080/.test(x))!;
    expect(open).not.toContain('bary_src_deny');
  });
});
