/**
 * GUI 풀 폼의 「백엔드로 가는 TLS」 (2026-10-31, 도그푸딩에서 잡았다).
 *
 * 모델 · CLI 에는 있었는데 GUI 에는 칸이 없어서, HTTPS 백엔드를 GUI 로 만든 풀은 평문으로 붙었다.
 * 재는 것: 모델 ↔ 폼 칸, 저장을 막는 규칙(검증기와 같다), 설정 탭이 다른 칸을 안 잃는 것, 만들기 폼의 patch.
 */
import { describe, expect, it } from 'vitest';

import { putPoolWithBackendPatch } from '../../src/web/edit.js';
import {
  UPSTREAM_TLS_OFF, caBundleChoices, poolBodyWithUpstreamTls, upstreamTlsFormOf, upstreamTlsInputOf, upstreamTlsIssue,
} from '../../src/web/upstream-tls.js';
import { decodeModel } from '../../src/model/decode.js';
import { validateModel } from '../../src/validate/model.js';

const on = (o: Partial<typeof UPSTREAM_TLS_OFF> = {}) => ({ ...UPSTREAM_TLS_OFF, on: true, ...o });

describe('모델 → 폼 칸', () => {
  it('없거나 꺼져 있으면 꺼짐', () => {
    expect(upstreamTlsFormOf({ key: 'p' })).toEqual(UPSTREAM_TLS_OFF);
    expect(upstreamTlsFormOf({ key: 'p', upstreamTls: { enabled: false } })).toEqual(UPSTREAM_TLS_OFF);
  });

  it('켜져 있으면 칸을 그대로 편다', () => {
    expect(upstreamTlsFormOf({ upstreamTls: { enabled: true, sni: 'b.test', caBundle: 'ca', verify: true } }))
      .toEqual({ on: true, sni: 'b.test', caBundle: 'ca', verify: true });
  });
});

describe('저장을 막는 규칙 — 검증기와 같다', () => {
  it('UDP 풀은 못 켠다', () => {
    expect(upstreamTlsIssue('udp', on())).toMatch(/UDP/);
    expect(upstreamTlsIssue('udp', UPSTREAM_TLS_OFF)).toBeUndefined();
  });

  it('검증은 CA 가 있어야 켠다', () => {
    expect(upstreamTlsIssue('http', on({ verify: true }))).toMatch(/CA/);
    expect(upstreamTlsIssue('http', on({ verify: true, caBundle: 'ca' }))).toBeUndefined();
  });

  it('SNI 만 있어도 된다 — 자체 서명 백엔드(검증 끔)', () => {
    expect(upstreamTlsIssue('http', on({ sni: 'web-01.test' }))).toBeUndefined();
  });
});

describe('폼 칸 → 입력', () => {
  it('꺼짐은 평문(undefined)', () => {
    expect(upstreamTlsInputOf(UPSTREAM_TLS_OFF)).toBeUndefined();
  });

  it('빈 칸은 안 싣고 공백은 깎는다', () => {
    expect(upstreamTlsInputOf(on({ sni: '  b.test ' }))).toEqual({ enabled: true, sni: 'b.test' });
  });
});

describe('설정 탭 — upstreamTls 만 바꾼다', () => {
  const pool = {
    key: 'p', protocolClass: 'http', algorithm: 'hash', hashKey: 'request_uri',
    healthCheck: { protocol: 'tcp_connect' }, upstreamTls: { enabled: true, sni: 'old.test' },
  };

  it('켜면 새 칸으로 바꾸고 나머지 칸은 그대로 둔다 — key 는 안 싣는다', () => {
    expect(poolBodyWithUpstreamTls(pool, on({ sni: 'new.test' }))).toEqual({
      protocolClass: 'http', algorithm: 'hash', hashKey: 'request_uri',
      healthCheck: { protocol: 'tcp_connect' }, upstreamTls: { enabled: true, sni: 'new.test' },
    });
  });

  it('끄면 칸을 지운다', () => {
    const body = poolBodyWithUpstreamTls(pool, UPSTREAM_TLS_OFF);
    expect('upstreamTls' in body).toBe(false);
    expect(body['hashKey']).toBe('request_uri');
  });

  it('규칙에 어긋나면 body 를 안 만든다', () => {
    expect(() => poolBodyWithUpstreamTls({ ...pool, protocolClass: 'udp' }, on())).toThrow(/UDP/);
  });
});

describe('CA 고르기', () => {
  it('자료가 있는 인증서만 — 정렬해서', () => {
    expect(caBundleChoices([
      { key: 'z', materialRef: 'store://z@1' }, { key: 'pending' }, { key: 'a', materialRef: 'store://a@1' },
    ])).toEqual(['a', 'z']);
  });
});

describe('만들기 폼의 patch 가 저장되는 모양이다', () => {
  it('SNI 만 준 HTTPS 백엔드 풀이 해독기와 검증기를 지난다', () => {
    const [p, ...backends] = putPoolWithBackendPatch({
      pool: 'barycenter', protocolClass: 'http', backend: 'web-01', host: '10.253.65.250', port: 8443,
      upstreamTls: upstreamTlsInputOf(on({ sni: 'web-01.util-icn-vtr.public.tinyuniver.se' }))!,
    });
    expect(p.body.upstreamTls).toEqual({ enabled: true, sni: 'web-01.util-icn-vtr.public.tinyuniver.se' });
    const raw = {
      listeners: [], httpRoutes: [], passthroughRoutes: [], certificates: [], tlsPolicies: [], sniBindings: [],
      pools: [{ key: p.key, ...p.body }],
      backends: backends.map((b) => ({ key: b.key, ...b.body })),
    };
    const decoded = decodeModel(raw);
    expect(decoded.ok, JSON.stringify(decoded)).toBe(true);
    if (decoded.ok) expect(validateModel(decoded.model)).toEqual([]);
  });
});
