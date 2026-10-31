/**
 * nginx 변수 이름의 상한 (2026-11-01, web-01 에서 `could not build variables_hash` 로 적용이 거부됐다).
 *
 * 재는 것: 상한 안의 이름은 전과 같다(지금 설정이 안 바뀐다), 넘으면 46 자로 줄고, 잘린 앞이 같은 두 키도
 * 갈린다, 접미사가 있어도 상한을 지킨다. 그리고 그날의 모양 — 출발지 제한 + 리다이렉트 — 이 상한을 지킨다.
 */
import { describe, expect, it } from 'vitest';

import { NGINX_VAR_MAX, render, varName } from '../../src/conf/render.js';
import type { Model } from '../../src/model/provisional.js';

describe('varName', () => {
  it('상한 안이면 전과 같은 이름이다', () => {
    expect(varName('bary_src_deny_', 'web')).toBe('bary_src_deny_web');
    expect(varName('bary_src_deny_', 'barycenter-internal')).toBe('bary_src_deny_barycenter_internal_422cbc0f');
  });

  it('**그날의 이름이 상한 안으로 들어온다** — 47 자였다', () => {
    const n = varName('bary_src_deny_', 'barycenter-internal:http');
    expect(n.length).toBeLessThanOrEqual(NGINX_VAR_MAX);
    expect(n).toMatch(/^bary_src_deny_barycenter_internal_[A-Za-z0-9_]*_[0-9a-f]{8}$/);
  });

  it('63 자 키도 46 자로 준다', () => {
    const key = 'x'.repeat(63);
    expect(varName('bary_src_deny_', key)).toHaveLength(NGINX_VAR_MAX);
  });

  it('잘린 앞이 같은 두 키는 다른 이름이 된다', () => {
    const a = `${'k'.repeat(50)}-a`;
    const b = `${'k'.repeat(50)}-b`;
    expect(varName('bary_src_deny_', a)).not.toBe(varName('bary_src_deny_', b));
  });

  it('접미사가 있어도 상한을 지키고 접미사는 끝에 남는다', () => {
    const n = varName('bary_sni_', 'y'.repeat(60), '_notls');
    expect(n.length).toBeLessThanOrEqual(NGINX_VAR_MAX);
    expect(n.endsWith('_notls')).toBe(true);
  });
});

describe('렌더 — 출발지 제한 + HTTP 리다이렉트', () => {
  it('web-01 의 그 모양에서 변수 이름이 모두 상한 안이다', () => {
    const V = 'a'.repeat(32);
    const model = {
      listeners: [
        { key: 'barycenter-internal', protocol: 'https', bind: '0.0.0.0', port: 443, enabled: true,
          hosts: ['util-icn-vtr.barycenter.tinyuniver.se'], sourceAllow: ['10.0.0.0/8'],
          tls: { policy: 'modern', defaultCertificate: 'c' }, http: { defaultAction: { pool: 'barycenter' } },
          http2: false, httpRedirect: { port: 80 } },
      ],
      httpRoutes: [], passthroughRoutes: [],
      pools: [{ key: 'barycenter', protocolClass: 'http', algorithm: 'round_robin' }],
      backends: [{ key: 'web-01', pool: 'barycenter', host: '10.253.65.250', port: 8443, weight: 1 }],
      certificates: [{ key: 'c', materialRef: `store://c@${V}`, chainDigest: `sha256:${'0'.repeat(64)}`, keyDigest: `sha256:${'1'.repeat(64)}` }],
      tlsPolicies: [{ key: 'modern', minVersion: '1.2' }], sniBindings: [],
    } as unknown as Model;
    const conf = render(model, { streamRealip: false, httpLua: true, streamLua: false, sslRejectHandshake: true }).conf;
    const names = [...new Set(conf.match(/\$[A-Za-z_][A-Za-z0-9_]*/g) ?? [])].map((n) => n.slice(1));
    expect(names.some((n) => n.startsWith('bary_src_deny_barycenter_internal_'))).toBe(true);
    expect(names.filter((n) => n.length > NGINX_VAR_MAX)).toEqual([]);
  });
});
