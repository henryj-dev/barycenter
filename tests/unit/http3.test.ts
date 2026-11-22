/**
 * HTTP/3 (QUIC) — https 리스너의 `http3` (2026-11-22).
 *
 * 켜면 같은 주소:포트를 UDP 로도 연다(`listen … quic`). TCP 응답에 `Alt-Svc` 를 실어 브라우저가 h3 로 옮겨 온다.
 * 막는 것: 엔진이 못 할 때 · PROXY 수신 · TLS 1.2 까지인 정책 · 같은 소켓의 리스너가 값이 다를 때 ·
 * 같은 포트의 udp 리스너(S20.udp_conflict — 엔진은 아무 말 없이 한쪽을 버린다).
 * 실물 nginx 로 재는 것은 `tests/golden/http3.test.ts` 다.
 */
import { describe, expect, it } from 'vitest';

import { render } from '../../src/conf/render.js';
import { decodeModel } from '../../src/model/decode.js';
import type { HttpsListener, Listener, Model } from '../../src/model/provisional.js';
import { validateModel } from '../../src/validate/model.js';
import { socketRows } from '../../src/web/sockets-view.js';

const V = 'd'.repeat(32);
const https = (key: string, extra: Partial<HttpsListener> = {}): HttpsListener => ({
  key, protocol: 'https', bind: '0.0.0.0', port: 443, enabled: true,
  tls: { policy: 'p', defaultCertificate: 'c' }, http: { defaultAction: 'reject' }, http2: false, ...extra,
});
const modelOf = (listeners: Listener[], maxVersion?: '1.2' | '1.3'): Model => ({
  listeners, httpRoutes: [], passthroughRoutes: [], pools: [], backends: [],
  certificates: [{ key: 'c', materialRef: `store://c@${V}`, chainDigest: `sha256:${'0'.repeat(64)}`, keyDigest: `sha256:${'1'.repeat(64)}` }],
  tlsPolicies: [{ key: 'p', minVersion: '1.2', ...(maxVersion === undefined ? {} : { maxVersion }) }], sniBindings: [],
});
const caps = { streamRealip: false, httpLua: true, streamLua: false, sslRejectHandshake: true, http3: true };
const issues = (m: Model, c: Parameters<typeof validateModel>[1] = caps): string =>
  validateModel(m, c).map((i) => `${i.code}: ${i.message}`).join('\n');
const servers = (conf: string): string[] => conf.split(/\n(?=\s*server \{)/).filter((b) => /^\s*server \{/.test(b));

describe('해독', () => {
  it('https 에서 받는다', () => {
    const d = decodeModel(modelOf([https('web', { http3: true })]));
    expect(d.ok).toBe(true);
    if (d.ok) expect((d.model.listeners[0] as HttpsListener).http3).toBe(true);
  });

  it('https 가 아니면 모르는 키다', () => {
    const m = modelOf([{ key: 'plain', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true, http: { defaultAction: 'reject' }, http3: true } as unknown as Listener]);
    expect(decodeModel(m).ok).toBe(false);
  });
});

describe('검증', () => {
  it('맞게 켜면 문제가 없다', () => {
    expect(issues(modelOf([https('web', { http3: true })]))).toBe('');
  });

  it('**엔진이 못 하면 막는다** — 켰는데 h3 가 안 나오면 원인이 어디에도 안 보인다', () => {
    expect(issues(modelOf([https('web', { http3: true })]), { ...caps, http3: false })).toMatch(/http3 를 요구하는데 엔진이 못 낸다/);
    // 안 켰으면 엔진이 못 해도 상관없다.
    expect(issues(modelOf([https('web')]), { ...caps, http3: false })).toBe('');
  });

  it('PROXY protocol 수신과 함께 못 쓴다 — QUIC 에는 그 헤더가 없다', () => {
    const l = https('web', { http3: true, acceptProxyProtocol: { trustedCidrs: ['10.0.0.0/8'] } });
    expect(issues(modelOf([l]))).toMatch(/PROXY protocol 을 받는다 — http3/);
  });

  it('TLS 1.2 까지인 정책과 함께 못 쓴다 — QUIC 은 TLS 1.3 만 쓴다', () => {
    expect(issues(modelOf([https('web', { http3: true })], '1.2'))).toMatch(/TLS 1\.3 이 필요하다/);
    expect(issues(modelOf([https('web', { http3: true })], '1.3'))).toBe('');
  });

  it('**같은 소켓을 나눠 쓰는 리스너는 값이 같아야 한다** — 섞이면 h3 로는 안 되는 이름이 생긴다', () => {
    const m = modelOf([https('a', { hosts: ['a.test'], http3: true }), https('b', { hosts: ['b.test'] })]);
    expect(issues(m)).toMatch(/socket_conflict: .*http3 는 소켓 단위다/);
    const same = modelOf([https('a', { hosts: ['a.test'], http3: true }), https('b', { hosts: ['b.test'], http3: true })]);
    expect(issues(same)).toBe('');
  });

  it('**같은 포트의 udp 리스너와 다툰다** (S20.udp_conflict) — 엔진은 아무 말 없이 한쪽을 버린다', () => {
    const udp = { key: 'dns', protocol: 'udp', bind: '0.0.0.0', port: 443, enabled: true, defaultPool: 'u', udp: { preset: 'dns' } } as unknown as Listener;
    const m: Model = { ...modelOf([https('web', { http3: true }), udp]), pools: [{ key: 'u', protocolClass: 'udp', algorithm: 'round_robin' }] };
    expect(issues(m)).toMatch(/socket_conflict: udp\/443 /);
    // h3 를 안 켰으면 공존한다 — tcp 와 udp 는 다른 소켓이다.
    const off: Model = { ...m, listeners: [https('web'), udp] };
    expect(issues(off)).not.toMatch(/socket_conflict/);
  });
});

describe('렌더', () => {
  it('**기본 server 가 QUIC 도 맡는다** — 모르는 SNI 가 h3 로 와도 TCP 와 같은 곳에 닿는다', () => {
    const conf = render(modelOf([https('web', { http3: true })]), caps).conf;
    const d = servers(conf).find((b) => /default_server/.test(b)) ?? '';
    expect(d).toMatch(/listen 443 ssl default_server;/);
    expect(d).toMatch(/listen 443 quic default_server;/);
    expect(d).toContain('add_header Alt-Svc "h3=\\":443\\"; ma=86400" always;');
  });

  it('호스트 server 도 QUIC 을 listen 하고 Alt-Svc 를 싣는다', () => {
    const conf = render(modelOf([https('web', { hosts: ['app.test'], http3: true })]), caps).conf;
    const host = servers(conf).find((b) => b.includes('server_name app.test;')) ?? '';
    expect(host).toMatch(/listen 443 ssl;/);
    expect(host).toMatch(/listen 443 quic;/);
    expect(host).toMatch(/add_header Alt-Svc .*always;/);
    // 호스트만 있는 소켓의 기본 server(인증서 없이 끊는 것)도 QUIC 을 맡는다.
    const synth = servers(conf).find((b) => /ssl_reject_handshake on;/.test(b)) ?? '';
    expect(synth).toMatch(/listen 443 quic default_server;/);
  });

  it('**안 켜면 렌더 바이트가 그대로다** — quic 도 Alt-Svc 도 없다', () => {
    const conf = render(modelOf([https('web', { hosts: ['app.test'] })]), caps).conf;
    expect(conf).not.toMatch(/quic|Alt-Svc/);
  });

  it('특정 주소 포트는 주소를 그대로 쓴다', () => {
    const conf = render(modelOf([https('web', { bind: '10.0.0.5', port: 8443, http3: true })]), caps).conf;
    expect(conf).toMatch(/listen 10\.0\.0\.5:8443 quic default_server;/);
    expect(conf).toContain('h3=\\":8443\\"');
  });

  it('와일드카드가 특정 주소에 함께 붙을 때 — **그 주소 소켓도 h3 일 때만** QUIC 을 붙인다', () => {
    const both = render(modelOf([
      https('spec', { bind: '10.0.0.5', hosts: ['s.test'], http3: true }),
      https('wild', { hosts: ['w.test'], http3: true }),
    ]), caps).conf;
    const w = servers(both).find((b) => b.includes('server_name w.test;')) ?? '';
    expect(w).toMatch(/listen 10\.0\.0\.5:443 ssl;/);
    expect(w).toMatch(/listen 10\.0\.0\.5:443 quic;/);

    const onlyWild = render(modelOf([
      https('spec', { bind: '10.0.0.5', hosts: ['s.test'] }),
      https('wild', { hosts: ['w.test'], http3: true }),
    ]), caps).conf;
    const w2 = servers(onlyWild).find((b) => b.includes('server_name w.test;')) ?? '';
    expect(w2).toMatch(/listen 10\.0\.0\.5:443 ssl;/);
    expect(w2).not.toMatch(/10\.0\.0\.5:443 quic/);
  });
});

describe('소켓 목록', () => {
  it('h3 리스너는 tcp 와 udp 두 줄이다 — 방화벽이 이 목록을 본다', () => {
    const rows = socketRows(modelOf([https('web', { http3: true })]));
    expect(rows.filter((r) => r.listener === 'web').map((r) => r.transport)).toEqual(['tcp', 'udp']);
    expect(socketRows(modelOf([https('web')])).map((r) => r.transport)).toEqual(['tcp']);
  });
});

describe('화면 — 만들기 · 설정이 http3 를 적는다', () => {
  it('만들기: 켜면 본문에 `http3: true` 를 얹고, 안 켜면 원래 만들기 길을 쓴다', async () => {
    const { plainSwitches, switchedBody } = await import('../../gui/src/lib/forms/listener-create.js');
    expect(plainSwitches({ enabled: true, http3: false })).toBe(true);
    expect(plainSwitches({ enabled: true, http3: true })).toBe(false);
    const body = switchedBody([{ key: 'web', body: { protocol: 'https' } }], { enabled: true, http3: true }).body;
    expect(body['http3']).toBe(true);
    expect(switchedBody([{ key: 'web', body: { protocol: 'https' } }], { enabled: true }).body).not.toHaveProperty('http3');
  });

  it('두 폼에 스위치가 있고, 설정 폼은 바꾼 때만 키를 만진다', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const gui = (p: string): string => readFileSync(join(import.meta.dirname, '../../gui/src', p), 'utf8');
    expect(gui('lib/forms/HttpListenerForm.svelte')).toContain('<FormRow label="HTTP/3" help={H3_HELP}>');
    const edit = gui('lib/listener/ListenerForm.svelte');
    expect(edit).toContain('<FormRow label="HTTP/3" help={H3_HELP}>');
    expect(edit).toContain("if (http3 !== (model['http3'] === true))");
  });
});
