/**
 * 와일드카드 리스너가 같은 포트의 특정 주소에 **함께 붙는 규칙** (2026-11-02) — 렌더 산출물로 잰다.
 * 실물 nginx 로 재는 것은 `tests/golden/wildcard-also-on.test.ts` 다.
 */
import { describe, expect, it } from 'vitest';

import { alsoOnSockets, render, wildcardAlsoOn } from '../../src/conf/render.js';
import type { HttpRoute, HttpsListener, Model } from '../../src/model/provisional.js';

const V = 'd'.repeat(32);
const https = (key: string, bind: string, hosts: string[] | undefined, extra: Partial<HttpsListener> = {}): HttpsListener => ({
  key, protocol: 'https', bind, port: 443, enabled: true, ...(hosts === undefined ? {} : { hosts }),
  tls: { policy: 'p', defaultCertificate: 'c' }, http: { defaultAction: 'reject' }, http2: false, ...extra,
});
const route = (key: string, listener: string, host: string): HttpRoute => ({
  key, listener, hosts: [host], priority: 0, action: { kind: 'redirect', to: 'https://x/', status: 302 },
});
const modelOf = (listeners: HttpsListener[], httpRoutes: HttpRoute[] = []): Model => ({
  listeners, httpRoutes, passthroughRoutes: [], pools: [], backends: [],
  certificates: [{ key: 'c', materialRef: `store://c@${V}`, chainDigest: `sha256:${'0'.repeat(64)}`, keyDigest: `sha256:${'1'.repeat(64)}` }],
  tlsPolicies: [{ key: 'p', minVersion: '1.2' }], sniBindings: [],
});
const caps = { streamRealip: false, httpLua: true, streamLua: false, sslRejectHandshake: true };

/** server_name 이 `name` 인 server 블록 본문. */
function serverOf(conf: string, name: string): string {
  const blocks = conf.split(/\n(?=\s*server \{)/);
  // 정규식을 짓지 않는다 — 이름을 그대로 찾는다(이스케이프를 빠뜨릴 자리가 없다).
  return blocks.find((b) => b.includes(`server_name ${name};`)) ?? '';
}

describe('와일드카드 리스너의 호스트 server', () => {
  const web01 = modelOf([
    https('admin', '10.253.65.250', ['barycenter.tinyuniver.se']),
    https('counter', '0.0.0.0', ['counter.tinyuniver.se']),
    https('default', '0.0.0.0', undefined),
  ]);

  it('**같은 포트의 특정 주소도 listen 한다** — web-01 의 counter', () => {
    const conf = render(web01, caps).conf;
    const counter = serverOf(conf, 'counter.tinyuniver.se');
    expect(counter).toMatch(/listen 443 ssl;/);
    expect(counter).toMatch(/listen 10\.253\.65\.250:443 ssl;/);
  });

  it('특정 주소 리스너의 server 는 그대로다 — 와일드카드에 안 퍼진다', () => {
    const admin = serverOf(render(web01, caps).conf, 'barycenter.tinyuniver.se');
    expect(admin).toMatch(/listen 10\.253\.65\.250:443 ssl;/);
    expect(admin).not.toMatch(/listen 443 ssl;/);
  });

  it('**기본 server 에는 안 붙인다** — 그 주소의 기본은 그 주소 리스너의 것이다', () => {
    const conf = render(web01, caps).conf;
    const defaults = conf.split(/\n(?=\s*server \{)/).filter((b) => /default_server/.test(b));
    expect(defaults.length).toBeGreaterThan(0);
    for (const d of defaults) {
      // 와일드카드 기본은 와일드카드에만, 특정 주소 기본은 특정 주소에만 있다.
      expect(d.match(/listen /g)?.length, d).toBe(1);
    }
  });

  it('그 주소 리스너가 이미 맡은 호스트에는 안 붙인다 — 같은 이름이 두 server 에 생긴다', () => {
    const m = modelOf([
      https('spec', '10.0.0.5', ['same.test']),
      https('wild', '0.0.0.0', ['same.test', 'other.test']),
    ]);
    const { alsoOn } = alsoOnSockets(m.listeners[1] as HttpsListener, m.listeners as HttpsListener[], new Map());
    expect(alsoOn.map((a) => a.addr)).toEqual(['10.0.0.5']);
    const conf = render(m, caps).conf;
    const other = conf.split(/\n(?=\s*server \{)/).filter((b) => /server_name other\.test;/.test(b));
    expect(other.join('\n')).toMatch(/listen 10\.0\.0\.5:443 ssl;/);
    // same.test 는 두 블록에 나오지만, 와일드카드 쪽 블록은 10.0.0.5 를 listen 하지 않는다.
    const same = conf.split(/\n(?=\s*server \{)/).filter((b) => /server_name same\.test;/.test(b));
    expect(same.filter((b) => /listen 10\.0\.0\.5:443/.test(b))).toHaveLength(1);
  });

  it('라우트로만 이름을 맡은 호스트 없는 리스너도 맡은 것으로 본다', () => {
    const m = modelOf([https('spec', '10.0.0.5', undefined), https('wild', '0.0.0.0', ['a.test'])], [route('r', 'spec', 'a.test')]);
    const routes = new Map([['spec', m.httpRoutes]]);
    const { alsoOn } = alsoOnSockets(m.listeners[1] as HttpsListener, m.listeners as HttpsListener[], routes);
    expect([...(alsoOn[0]?.hosts ?? [])]).toEqual(['a.test']);
  });

  it('**PROXY protocol 이 다르면 안 붙이고 plan 이 크게 말한다**', () => {
    const m = modelOf([
      https('spec', '10.0.0.5', ['admin.test']),
      https('wild', '0.0.0.0', ['site.test'], { acceptProxyProtocol: { trustedCidrs: ['10.0.0.0/8'] } }),
    ]);
    expect(serverOf(render(m, caps).conf, 'site.test')).not.toMatch(/10\.0\.0\.5/);
    expect(wildcardAlsoOn(m)).toEqual([{ listener: 'wild', port: 443, addrs: [], skipped: [{ addr: '10.0.0.5', why: 'proxy_protocol' }] }]);
  });

  it('주소 계열이 다르면 안 붙인다 — 0.0.0.0 은 IPv6 주소를 안 덮는다', () => {
    const m = modelOf([https('spec', '::1', ['a.test']), https('wild', '0.0.0.0', ['b.test'])]);
    expect(wildcardAlsoOn(m)).toEqual([]);
  });

  it('plan 영향에 알릴 거리를 낸다', () => {
    expect(wildcardAlsoOn(web01)).toEqual([
      { listener: 'counter', port: 443, addrs: ['10.253.65.250'], skipped: [] },
    ]);
  });
});
