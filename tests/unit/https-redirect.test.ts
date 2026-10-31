/**
 * HTTPS 리스너의 평문 리다이렉트 (`httpRedirect`, 2026-10-31).
 *
 * 켜면 같은 바인드의 그 포트(보통 80)에 평문 server 를 세우고 `301 https://$host$request_uri` 로 보낸다.
 * 그 소켓은 모델에 따로 없지만 **리스너처럼 다룬다** — 검증 · 렌더 · 소켓 목록 · plan 의 소켓 변화가 같은
 * 함수(`src/model/redirect.ts`)를 본다. 실물 nginx 판정은 `tests/golden/https-redirect.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { render } from '../../src/conf/render.js';
import { decodeModel } from '../../src/model/decode.js';
import type { Model } from '../../src/model/provisional.js';
import { validateModel } from '../../src/validate/model.js';
import { socketRows } from '../../src/web/sockets-view.js';
import { checkRedirectPort, editListenerPatch, putHttpsListenerPatch } from '../../src/web/edit.js';
import { detailOfListener } from '../../src/web/listeners-view.js';

const V = 'a'.repeat(32);
const cert = (key: string) => ({
  key, materialRef: `store://${key}@${V}`, chainDigest: `sha256:${'0'.repeat(64)}`, keyDigest: `sha256:${'1'.repeat(64)}`,
});
const base = (listeners: Model['listeners']): Model => ({
  listeners, httpRoutes: [], passthroughRoutes: [],
  pools: [{ key: 'pa', protocolClass: 'http', algorithm: 'round_robin' }],
  backends: [{ key: 'ba', pool: 'pa', host: '10.0.0.1', port: 80, weight: 1 }],
  certificates: [cert('ca'), cert('cb')],
  tlsPolicies: [{ key: 'p', minVersion: '1.2' }],
  sniBindings: [],
});
const https = (key: string, over: Record<string, unknown> = {}) => ({
  key, protocol: 'https' as const, bind: '0.0.0.0', port: 443, enabled: true,
  tls: { policy: 'p', defaultCertificate: 'ca' },
  http: { defaultAction: { pool: 'pa' } },
  httpRedirect: { port: 80 },
  ...over,
}) as Model['listeners'][number];
const plain = (key: string, over: Record<string, unknown> = {}) => ({
  key, protocol: 'http' as const, bind: '0.0.0.0', port: 80, enabled: true,
  http: { defaultAction: { pool: 'pa' } }, ...over,
}) as Model['listeners'][number];
const caps = { streamRealip: false, sslRejectHandshake: true };
const codes = (m: Model) => validateModel(m, caps).map((i) => i.code);

describe('해독', () => {
  it('https 에서 { port } 를 받는다', () => {
    const d = decodeModel(base([https('a')]));
    expect(d.ok).toBe(true);
  });

  it('http 리스너에는 없다 — 모르는 키다', () => {
    const d = decodeModel(base([plain('h', { httpRedirect: { port: 8080 } })]));
    expect(d.ok).toBe(false);
  });

  it('포트가 범위 밖이거나 다른 키가 있으면 거절한다', () => {
    expect(decodeModel(base([https('a', { httpRedirect: { port: 0 } })])).ok).toBe(false);
    expect(decodeModel(base([https('a', { httpRedirect: { port: 80, status: 308 } })])).ok).toBe(false);
  });
});

describe('검증 — 리다이렉트 소켓은 리스너처럼 다룬다', () => {
  it('혼자면 문제가 없다', () => {
    expect(codes(base([https('a')]))).toEqual([]);
  });

  it('같은 포트의 호스트 없는 HTTP 리스너와는 충돌한다 — 둘 다 그 포트의 기본이 된다', () => {
    expect(codes(base([https('a'), plain('h')]))).toContain('socket_conflict');
  });

  it('호스트 리스너끼리는 80 을 나눠 쓴다(호스트가 다르면)', () => {
    expect(codes(base([https('a', { hosts: ['a.test'] }), plain('h', { hosts: ['h.test'] })]))).toEqual([]);
  });

  it('호스트가 겹치면 host_conflict 다 — 80 에서 같은 이름을 두 server 가 받는다', () => {
    expect(codes(base([https('a', { hosts: ['a.test'] }), plain('h', { hosts: ['a.test'] })]))).toContain('host_conflict');
  });

  it('HTTPS 포트와 같은 포트로는 못 연다 — 평문과 TLS 를 한 포트에 섞는다', () => {
    expect(codes(base([https('a', { httpRedirect: { port: 443 } })]))).toContain('socket_conflict');
  });

  it('리스너가 꺼지면 리다이렉트 소켓도 없다', () => {
    expect(codes(base([https('a', { enabled: false }), plain('h')]))).toEqual([]);
  });

  it('두 HTTPS 호스트 리스너가 각자 리다이렉트를 켜도 80 을 나눠 쓴다', () => {
    expect(codes(base([
      https('a', { hosts: ['a.test'] }),
      https('b', { hosts: ['b.test'], tls: { policy: 'p', defaultCertificate: 'cb' } }),
    ]))).toEqual([]);
  });
});

describe('렌더', () => {
  it('호스트 없는 리스너 — 80 의 default_server 가 ACME 를 남기고 나머지를 301 로 보낸다', () => {
    const conf = render(base([https('a')]), { ...caps, httpLua: true }).conf;
    const s = conf.slice(conf.indexOf('listen 80 default_server;'));
    const server = s.slice(0, s.indexOf('\n    }\n'));
    expect(server).toContain('location ^~ /.well-known/acme-challenge/');
    expect(server).toContain('return 301 https://$host$request_uri;');
    expect(conf).toContain('listen 443 ssl default_server;');
  });

  it('호스트 리스너 — 80 에 그 호스트의 server 와 444 기본 server 를 낸다', () => {
    const conf = render(base([https('a', { hosts: ['a.test'] })]), caps).conf;
    expect(conf).toMatch(/listen 80;\s+server_name a\.test;[\s\S]*?return 301 https:\/\/\$host\$request_uri;/);
    expect(conf).toMatch(/listen 80 default_server;[\s\S]*?return 444;/);
  });

  it('443 이 아니면 포트를 붙인다', () => {
    const conf = render(base([https('a', { port: 8443, httpRedirect: { port: 8080 } })]), caps).conf;
    expect(conf).toContain('return 301 https://$host:8443$request_uri;');
    expect(conf).toContain('listen 8080 default_server;');
  });

  it('출발지 제한을 평문 server 에도 건다', () => {
    const conf = render(base([https('a', { sourceAllow: ['10.0.0.0/8'] })]), caps).conf;
    const s = conf.slice(conf.indexOf('listen 80 default_server;'));
    const guard = /if \(\$(bary_src_deny_\w+)\)/.exec(s.slice(0, s.indexOf('\n    }\n')))?.[1];
    expect(guard, '평문 server 에 출발지 가드가 없다').toBeDefined();
    // 가드가 읽는 geo 가 있고, 그 안에 이 리스너의 대역이 있다 — 없으면 nginx -t 가 「모르는 변수」 로 실패한다.
    expect(conf).toMatch(new RegExp(`geo \\$realip_remote_addr \\$${guard} \\{[^}]*10\\.0\\.0\\.0/8 0;`));
  });

  it('리다이렉트가 없으면 렌더가 그대로다 — 안 켠 배포는 세대가 안 바뀐다', () => {
    const { httpRedirect: _r, ...noRedirect } = https('a') as Record<string, unknown>;
    const conf = render(base([noRedirect as Model['listeners'][number]]), caps).conf;
    expect(conf).not.toContain('listen 80');
    expect(conf).not.toContain('return 301');
  });
});

describe('소켓 목록 · 편집', () => {
  it('소켓 목록에 80 이 나온다 — 배포 · 방화벽이 연다', () => {
    const rows = socketRows(base([https('a')]));
    expect(rows.map((r) => `${r.listener}|${r.transport}|${r.port}`)).toEqual(['a:http|tcp|80', 'a|tcp|443']);
  });

  it('만들기 패치에 싣고, 같은 포트는 거절한다', () => {
    const [op] = putHttpsListenerPatch('a', { bind: '0.0.0.0', port: 443, pool: 'pa', policy: 'p', certificate: 'ca', httpRedirect: { port: 80 } });
    expect(op?.body.httpRedirect).toEqual({ port: 80 });
    expect(() => checkRedirectPort(443, 443)).toThrow(/같다/);
  });

  it('수정 — null 이면 지우고, 다른 칸은 그대로 둔다', () => {
    const cur = { ...https('a'), sourceAllow: ['10.0.0.0/8'] } as Record<string, unknown>;
    const [off] = editListenerPatch(cur, { bind: '0.0.0.0', port: 443, enabled: true, sourceAllow: ['10.0.0.0/8'], httpRedirect: null });
    expect(off?.body).not.toHaveProperty('httpRedirect');
    expect(off?.body['tls']).toEqual({ policy: 'p', defaultCertificate: 'ca' });
    const [on] = editListenerPatch(cur, { bind: '0.0.0.0', port: 443, enabled: true, httpRedirect: { port: 8080 } });
    expect(on?.body['httpRedirect']).toEqual({ port: 8080 });
    expect(() => editListenerPatch({ ...plain('h') } as Record<string, unknown>, { bind: '0.0.0.0', port: 80, enabled: true, httpRedirect: { port: 81 } })).toThrow(/HTTPS 리스너만/);
  });

  it('상세에 한 줄로 보인다', () => {
    expect(detailOfListener(https('a') as Record<string, unknown>).find((l) => l.label === 'HTTP 리다이렉트')?.value).toContain(':80');
  });
});
