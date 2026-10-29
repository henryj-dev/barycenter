/**
 * **주소 집합** (#114) — 리스너가 `@이름` 으로 대역 목록을 참조한다.
 *
 * 재는 것:
 *   · 집합의 모양 — 대역만, 비어 있을 수 없음, 중복 거절, 다른 집합 참조 거절, source 는 목록 안
 *   · 참조의 모양 — `@이름` 은 받고, 이상한 `@` 는 거절
 *   · 검증 — 없는 집합을 참조하면 막는다 (세 자리 모두)
 *   · 렌더 — 펼친 결과가 직접 적은 것과 **같은 바이트**다. 겹치는 대역은 접는다
 *   · 안 쓰면 아무것도 안 바뀐다
 */
import { describe, expect, it } from 'vitest';

import { render } from '../../src/conf/render.js';
import { decodeModel } from '../../src/model/decode.js';
import { expandAddressSets, referencedSets } from '../../src/model/address-sets.js';
import { validateModel } from '../../src/validate/model.js';
import type { Model } from '../../src/model/provisional.js';

const CF = ['173.245.48.0/20', '2400:cb00::/32'];

const base = (listener: Record<string, unknown>, sets?: unknown[]): Record<string, unknown> => ({
  listeners: [{
    key: 'web', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true,
    http: { defaultAction: { pool: 'app' } }, ...listener,
  }],
  httpRoutes: [], passthroughRoutes: [],
  pools: [{ key: 'app', protocolClass: 'http', algorithm: 'round_robin' }],
  backends: [{ key: 'a', pool: 'app', host: '10.0.0.1', port: 8080, weight: 1 }],
  certificates: [], tlsPolicies: [], sniBindings: [],
  ...(sets === undefined ? {} : { addressSets: sets }),
});

function issues(m: unknown): string[] {
  const r = decodeModel(m);
  if (!r.ok) return r.issues.map((i) => i.code);
  return validateModel(r.model).map((i) => i.code);
}

function conf(m: unknown): string {
  const r = decodeModel(m);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return render(r.model as Model).conf;
}

describe('집합의 모양', () => {
  it('받는다', () => {
    expect(issues(base({}, [{ key: 'cloudflare', cidrs: CF, source: 'cloudflare' }]))).toEqual([]);
  });
  it.each([
    [{ key: 'x', cidrs: [] }, 'out_of_range'],
    [{ key: 'x', cidrs: ['cloudflare'] }, 'invalid_value'],
    [{ key: 'x', cidrs: ['@other'] }, 'invalid_value'],
    [{ key: 'x', cidrs: ['10.0.0.0/8', '10.0.0.0/8'] }, 'duplicate'],
    [{ key: 'x', cidrs: CF, source: 'aws' }, 'invalid_enum'],
  ])('%j 는 막는다 (%s)', (set, code) => {
    expect(issues(base({}, [set]))).toContain(code);
  });
});

describe('참조', () => {
  it('세 자리에서 `@이름` 을 받는다', () => {
    const sets = [{ key: 'cloudflare', cidrs: CF }];
    expect(issues(base({ sourceAllow: ['@cloudflare', '203.0.113.7'] }, sets))).toEqual([]);
    expect(issues(base({ realIpFromHeader: { header: 'CF-Connecting-IP', trustedCidrs: ['@cloudflare'] } }, sets))).toEqual([]);
    expect(issues(base({ acceptProxyProtocol: { trustedCidrs: ['@cloudflare'] } }, sets))).toEqual([]);
  });

  it.each(['@', '@-x', '@a b', 'cloudflare'])('sourceAllow 의 %s 는 모양에서 막는다', (ref) => {
    expect(issues(base({ sourceAllow: [ref] }, [{ key: 'cloudflare', cidrs: CF }]))).toContain('invalid_value');
  });

  it('**없는 집합을 참조하면 막는다** — 세 자리 모두', () => {
    expect(issues(base({ sourceAllow: ['@nope'] }))).toEqual(['unknown_address_set']);
    expect(issues(base({ realIpFromHeader: { header: 'CF-Connecting-IP', trustedCidrs: ['@nope'] } })))
      .toEqual(['unknown_address_set']);
    expect(issues(base({ acceptProxyProtocol: { trustedCidrs: ['@nope'] } }))).toEqual(['unknown_address_set']);
  });

  it('referencedSets 는 세 자리를 모아 정렬한다', () => {
    const r = decodeModel(base({
      sourceAllow: ['@b', '10.0.0.0/8'],
      realIpFromHeader: { header: 'CF-Connecting-IP', trustedCidrs: ['@a', '@b'] },
    }, [{ key: 'a', cidrs: CF }, { key: 'b', cidrs: ['10.1.0.0/16'] }]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(referencedSets(r.model.listeners[0]!)).toEqual(['a', 'b']);
  });
});

describe('렌더 — 펼친 결과는 직접 적은 것과 같다', () => {
  it('sourceAllow', () => {
    const viaSet = conf(base({ sourceAllow: ['@cloudflare'] }, [{ key: 'cloudflare', cidrs: CF }]));
    const direct = conf(base({ sourceAllow: CF }));
    expect(viaSet).toBe(direct);
  });

  it('realIpFromHeader 의 신뢰 대역', () => {
    const viaSet = conf(base({ realIpFromHeader: { header: 'CF-Connecting-IP', trustedCidrs: ['@cloudflare'] } },
      [{ key: 'cloudflare', cidrs: CF }]));
    expect(viaSet).toBe(conf(base({ realIpFromHeader: { header: 'CF-Connecting-IP', trustedCidrs: CF } })));
    expect(viaSet).toContain('set_real_ip_from 173.245.48.0/20;');
  });

  it('stream 의 allow 도 펼친다', () => {
    const m = (sa: string[], sets?: unknown[]): Record<string, unknown> => ({
      ...base({}, sets),
      listeners: [{ key: 'l4', protocol: 'tcp', bind: '0.0.0.0', port: 9000, enabled: true, defaultPool: 't', sourceAllow: sa }],
      pools: [{ key: 't', protocolClass: 'tcp', algorithm: 'round_robin' }],
      backends: [{ key: 'b', pool: 't', host: '10.0.0.2', port: 9000, weight: 1 }],
    });
    expect(conf(m(['@cloudflare'], [{ key: 'cloudflare', cidrs: CF }]))).toBe(conf(m(CF)));
  });

  it('겹치는 대역은 한 번만 나간다', () => {
    const c = conf(base({ sourceAllow: ['@cloudflare', '173.245.48.0/20'] }, [{ key: 'cloudflare', cidrs: CF }]));
    expect(c.match(/173\.245\.48\.0\/20 0;/g)?.length).toBe(1);
  });

  it('참조가 없으면 같은 모델 객체를 돌려준다 — 렌더 바이트가 이 기능 전과 같다', () => {
    const r = decodeModel(base({ sourceAllow: CF }, [{ key: 'unused', cidrs: ['10.0.0.0/8'] }]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(expandAddressSets(r.model)).toBe(r.model);
  });

  it('집합 필드가 없는 모델은 키가 안 생긴다 — 옛 리비전 스냅샷과 같은 모양', () => {
    const r = decodeModel(base({}));
    expect(r.ok).toBe(true);
    if (r.ok) expect('addressSets' in r.model).toBe(false);
  });
});
