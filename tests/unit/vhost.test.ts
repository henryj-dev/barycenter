/**
 * 호스트 리스너 — 한 소켓을 서비스마다 나눠 쓴다 (ADR-VHOST, 2026-10-31).
 *
 * 전에는 리스너가 소켓(주소:포트) 하나라서 `0.0.0.0:443` 을 쓰는 리스너가 하나뿐이었다. 사이트마다 인증서 ·
 * 출발지 제한 · 기본 동작을 따로 둘 수 없었다. 이제 http · https 리스너에 `hosts`(server_name)를 두면
 * 같은 소켓을 함께 쓴다.
 *
 * 재는 것 (실물 nginx 판정은 `tests/golden/vhost.test.ts`):
 *   · 검증기 — 같은 소켓 공유 허용, 그 밖의 겹침은 여전히 충돌, 호스트 겹침, 라우트가 호스트 밖, 엔진 능력
 *   · 렌더 — 호스트마다 server, 기본 동작이 `location /`, 소켓의 기본 server 를 만든다, 호스트 없는 리스너는 그대로
 */
import { describe, expect, it } from 'vitest';

import { render } from '../../src/conf/render.js';
import type { Model } from '../../src/model/provisional.js';
import { validateModel } from '../../src/validate/model.js';

const V = 'a'.repeat(32);
const cert = (key: string) => ({
  key, materialRef: `store://${key}@${V}`, chainDigest: `sha256:${'0'.repeat(64)}`, keyDigest: `sha256:${'1'.repeat(64)}`,
});
const base = (over: Partial<Model> = {}): Model => ({
  listeners: [], httpRoutes: [], passthroughRoutes: [],
  pools: [{ key: 'pa', protocolClass: 'http', algorithm: 'round_robin' }, { key: 'pb', protocolClass: 'http', algorithm: 'round_robin' }],
  backends: [
    { key: 'ba', pool: 'pa', host: '10.0.0.1', port: 80, weight: 1 },
    { key: 'bb', pool: 'pb', host: '10.0.0.2', port: 80, weight: 1 },
  ],
  certificates: [cert('ca'), cert('cb')],
  tlsPolicies: [{ key: 'p', minVersion: '1.2' }],
  sniBindings: [],
  ...over,
});
const https = (key: string, hosts: string[] | undefined, certificate: string, pool: string) => ({
  key, protocol: 'https' as const, bind: '0.0.0.0', port: 443, enabled: true,
  tls: { policy: 'p', defaultCertificate: certificate },
  http: { defaultAction: { pool } },
  ...(hosts === undefined ? {} : { hosts }),
});
const caps = { streamRealip: false, sslRejectHandshake: true };
const codes = (m: Model, c = caps) => validateModel(m, c).map((i) => i.code);

describe('검증 — 소켓 공유', () => {
  it('호스트가 다른 호스트 리스너 둘은 같은 0.0.0.0:443 을 함께 쓴다', () => {
    expect(codes(base({ listeners: [https('a', ['a.test'], 'ca', 'pa'), https('b', ['b.test'], 'cb', 'pb')] }))).toEqual([]);
  });

  it('호스트 없는 리스너 둘은 여전히 충돌이다 — 둘 다 default_server 가 된다', () => {
    expect(codes(base({ listeners: [https('a', undefined, 'ca', 'pa'), https('b', undefined, 'cb', 'pb')] }))).toContain('socket_conflict');
  });

  it('호스트 없는 리스너 하나 + 호스트 리스너는 함께 쓴다 — 앞의 것이 그 소켓의 기본이다', () => {
    expect(codes(base({ listeners: [https('a', undefined, 'ca', 'pa'), https('b', ['b.test'], 'cb', 'pb')] }))).toEqual([]);
  });

  it('평문과 TLS 를 한 포트에 섞지 않는다', () => {
    const plain = { key: 'h', protocol: 'http' as const, bind: '0.0.0.0', port: 443, enabled: true, hosts: ['h.test'], http: { defaultAction: { pool: 'pa' } } };
    const issues = validateModel(base({ listeners: [https('a', ['a.test'], 'ca', 'pa'), plain] }), caps);
    expect(issues.find((i) => i.code === 'socket_conflict')?.message).toContain('평문');
  });

  it('와일드카드와 특정 주소는 소켓을 나눠 쓴다 — 충돌이 아니고, 특정 주소로 온 요청은 그쪽이 받는다', () => {
    const b = { ...https('b', ['b.test'], 'cb', 'pb'), bind: '10.0.0.9' };
    const issues = validateModel(base({ listeners: [https('a', ['a.test'], 'ca', 'pa'), b] }), caps);
    expect(issues.filter((i) => i.code === 'socket_conflict')).toEqual([]);
  });

  it('PROXY 수신이 어긋나면 충돌이다 — 소켓 단위 옵션이다', () => {
    const b = { ...https('b', ['b.test'], 'cb', 'pb'), acceptProxyProtocol: { trustedCidrs: ['10.0.0.0/8'] } };
    const issues = validateModel(base({ listeners: [https('a', ['a.test'], 'ca', 'pa'), b] }), caps);
    expect(issues.find((i) => i.code === 'socket_conflict')?.message).toContain('PROXY');
  });
});

describe('검증 — 호스트', () => {
  it('같은 소켓에서 호스트가 겹치면 막는다', () => {
    expect(codes(base({ listeners: [https('a', ['x.test'], 'ca', 'pa'), https('b', ['X.test'], 'cb', 'pb')] }))).toContain('host_conflict');
  });

  it('호스트 없는 리스너의 라우트 호스트와도 겹치면 막는다', () => {
    const m = base({
      listeners: [https('a', undefined, 'ca', 'pa'), https('b', ['r.test'], 'cb', 'pb')],
      httpRoutes: [{ key: 'r', listener: 'a', hosts: ['r.test'], priority: 0, action: { kind: 'proxy', pool: 'pa', websocket: false } }],
      sniBindings: [{ key: 's', listener: 'a', hosts: ['r.test'], certificate: 'ca' }],
    });
    expect(codes(m)).toContain('host_conflict');
  });

  it('호스트 리스너의 라우트는 그 리스너의 호스트 안에서만 산다', () => {
    const m = base({
      listeners: [https('a', ['a.test'], 'ca', 'pa')],
      httpRoutes: [{ key: 'r', listener: 'a', hosts: ['other.test'], priority: 0, action: { kind: 'proxy', pool: 'pa', websocket: false } }],
    });
    expect(codes(m)).toContain('route_host_outside_listener');
  });

  it('호스트 모양이 아니면 막는다', () => {
    expect(codes(base({ listeners: [https('a', ['not a host'], 'ca', 'pa')] }))).toContain('invalid_value');
  });

  it('호스트 리스너만 있는 HTTPS 소켓은 ssl_reject_handshake 가 있어야 한다', () => {
    expect(codes(base({ listeners: [https('a', ['a.test'], 'ca', 'pa')] }), { streamRealip: false, sslRejectHandshake: false }))
      .toContain('option_not_supported');
  });
});

describe('렌더', () => {
  const conf = render(base({ listeners: [https('a', ['a.test'], 'ca', 'pa'), https('b', ['b.test'], 'cb', 'pb')] }), { ...caps, httpLua: false }).conf;

  it('호스트마다 server 가 하나씩 있고, 소켓은 같다', () => {
    expect(conf).toMatch(/server_name a\.test;/);
    expect(conf).toMatch(/server_name b\.test;/);
    expect(conf.match(/listen 443 ssl;/g)).toHaveLength(2);
  });

  it('호스트마다 자기 리스너의 인증서를 낸다', () => {
    const a = conf.slice(conf.indexOf('server_name a.test;'));
    expect(a.slice(0, a.indexOf('server_name', 20))).toContain('/ca/');
    const b = conf.slice(conf.indexOf('server_name b.test;'));
    expect(b).toContain('/cb/');
  });

  it('기본 server 는 렌더러가 하나 만들고, 인증서 없이 끊는다', () => {
    expect(conf.match(/default_server/g)).toHaveLength(1);
    const d = conf.slice(conf.indexOf('default_server'));
    expect(d.slice(0, 200)).toContain('ssl_reject_handshake on;');
  });

  it('호스트 리스너의 기본 동작이 그 server 의 location / 다', () => {
    const a = conf.slice(conf.indexOf('server_name a.test;'), conf.indexOf('server_name b.test;'));
    expect(a).toMatch(/location \/ \{[\s\S]*proxy_pass http:\/\/[^;]*pa/);
  });

  it('호스트 없는 리스너만 있는 설정은 전과 같다 — 기본 server 를 따로 만들지 않는다', () => {
    const old = render(base({ listeners: [https('a', undefined, 'ca', 'pa')] }), { ...caps, httpLua: false }).conf;
    expect(old).not.toContain('ssl_reject_handshake');
    expect(old.match(/default_server/g)).toHaveLength(1);
  });
});
