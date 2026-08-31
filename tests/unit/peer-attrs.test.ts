/**
 * peer 별 속성 채널 (`docs/adr-membership-attrs.md` ②)
 *
 * `soft_max_conns` 와 `is_backup` 은 nginx 에서 `server` 줄에 붙는 값인데, 멤버십 평면이
 * 켜지면 **그 줄이 없다** — upstream 에 자리표시 하나만 남고 peer 는 dict 에 산다.
 * 그래서 속성은 슬롯과 **나란히** 간다.
 *
 * 이 파일은 채널만 잰다. 밸런서가 그것을 읽는 것은 다음 조각이다 — 지금 상태를
 * "된다" 고 적지 않는다.
 */
import { describe, expect, it } from 'vitest';

import { attrsOf, slotsOf } from '../../src/control/membership.js';
import { parseModel } from '../../src/model/decode.js';
import type { Model } from '../../src/model/provisional.js';

const CAPS = { httpLua: true, streamLua: true, streamRealip: false, sslConfCommand: true };

function modelOf(backends: unknown[], algorithm = 'round_robin'): Model {
  const r = parseModel({
    pools: [{ key: 'app', protocolClass: 'http', algorithm }],
    backends,
    listeners: [{
      key: 'front', protocol: 'http', bind: '0.0.0.0', port: 8080, enabled: true,
      http: { defaultAction: { pool: 'app' } },
    }],
    httpRoutes: [], passthroughRoutes: [],
    certificates: [], tlsPolicies: [], sniBindings: [],
  });
  if (!r.ok) throw new Error(`모델이 안 선다: ${JSON.stringify(r.issues)}`);
  return r.model;
}

const be = (key: string, host: string, extra: Record<string, unknown> = {}): unknown =>
  ({ key, pool: 'app', host, port: 80, weight: 1, ...extra });

describe('속성 채널', () => {
  it('**속성이 없으면 아무것도 안 낸다** — 안 쓰는 배포에 키를 안 만든다', () => {
    const attrs = attrsOf(modelOf([be('a', '10.0.0.1'), be('b', '10.0.0.2')]), CAPS);
    expect(attrs.http).toEqual({});
    expect(attrs.stream).toEqual({});
  });

  it('속성이 있는 peer 만 실린다', () => {
    const m = modelOf([be('a', '10.0.0.1', { softMaxConns: 100 }), be('b', '10.0.0.2')]);
    const attrs = attrsOf(m, CAPS);
    const [name] = Object.keys(attrs.http);
    expect(name, '속성이 실린 upstream 이 없다').toBeDefined();
    expect(attrs.http[name!]).toEqual({ '10.0.0.1:80': { softMaxConns: 100 } });
  });

  it('`isBackup` 도 같은 길로 간다', () => {
    const m = modelOf([be('a', '10.0.0.1'), be('b', '10.0.0.2', { isBackup: true })]);
    const attrs = attrsOf(m, CAPS);
    const [name] = Object.keys(attrs.http);
    expect(attrs.http[name!]).toEqual({ '10.0.0.2:80': { isBackup: true } });
  });

  /**
   * **이름을 두 번 계산하지 않는다.**
   *
   * 슬롯이 D18 에서 정확히 이것으로 물렸다 — 이름 규칙을 두 자리에서 만들었더니 서로의
   * upstream 에 실렸고, 그러면 밸런서가 빈 슬롯을 보고 **그 풀의 모든 요청을 끊는다.**
   * 속성이 엉뚱한 이름에 실리는 것도 밖에서 안 보인다.
   */
  it('속성의 upstream 이름이 슬롯의 것과 같다', () => {
    const m = modelOf([be('a', '10.0.0.1', { softMaxConns: 5 })]);
    expect(Object.keys(attrsOf(m, CAPS).http)).toEqual(Object.keys(slotsOf(m, CAPS).http));
  });

  it('슬롯에 없는 peer 의 속성은 안 싣는다 — 회수는 upstream 단위다', () => {
    // `b` 는 다른 풀이라 이 upstream 의 슬롯에 없다. 속성만 남으면 아무도 안 지운다.
    const r = parseModel({
      pools: [
        { key: 'app', protocolClass: 'http', algorithm: 'round_robin' },
        { key: 'other', protocolClass: 'http', algorithm: 'round_robin' },
      ],
      backends: [
        { key: 'a', pool: 'app', host: '10.0.0.1', port: 80, weight: 1, softMaxConns: 3 },
        { key: 'b', pool: 'other', host: '10.0.0.9', port: 80, weight: 1, softMaxConns: 7 },
      ],
      listeners: [{
        key: 'front', protocol: 'http', bind: '0.0.0.0', port: 8080, enabled: true,
        http: { defaultAction: { pool: 'app' } },
      }],
      httpRoutes: [], passthroughRoutes: [],
      certificates: [], tlsPolicies: [], sniBindings: [],
    });
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    for (const [, peers] of Object.entries(attrsOf(r.model, CAPS).http)) {
      expect(Object.keys(peers)).not.toContain('10.0.0.9:80');
    }
  });
});

describe('해시 풀에는 backup 을 못 둔다 (§4.3.1)', () => {
  /**
   * 해시는 키에서 자리를 정하는데 backup 은 *"다른 게 다 죽었을 때만"* 이다. 함께 두면
   * 해시가 backup 을 고를 수 있고 그건 backup 이 아니다. **막지 않으면 「표현은 되는데
   * 안 지켜지는」 설정**이 된다 — `source_ip_hash` 가 한 번 그랬다.
   */
  for (const algorithm of ['hash', 'source_ip_hash']) {
    it(`${algorithm} + isBackup 은 거절한다`, () => {
      const r = parseModel({
        pools: [{
          key: 'app', protocolClass: 'http', algorithm,
          ...(algorithm === 'hash' ? { hashKey: 'remote_addr' } : {}),
        }],
        backends: [
          { key: 'a', pool: 'app', host: '10.0.0.1', port: 80, weight: 1 },
          { key: 'b', pool: 'app', host: '10.0.0.2', port: 80, weight: 1, isBackup: true },
        ],
        listeners: [{
          key: 'front', protocol: 'http', bind: '0.0.0.0', port: 8080, enabled: true,
          http: { defaultAction: { pool: 'app' } },
        }],
        httpRoutes: [], passthroughRoutes: [],
        certificates: [], tlsPolicies: [], sniBindings: [],
      });
      expect(r.ok, 'isBackup 이 해시 풀에서 통과했다').toBe(false);
      expect(JSON.stringify(r.ok ? [] : r.issues)).toMatch(/isBackup/);
    });
  }

  it('round_robin 에서는 통과한다 — 막는 것은 해시뿐이다', () => {
    expect(() => modelOf([
      be('a', '10.0.0.1'), be('b', '10.0.0.2', { isBackup: true }),
    ])).not.toThrow();
  });
});

describe('안 받는 값', () => {
  const bad = (extra: Record<string, unknown>): string => {
    const r = parseModel({
      pools: [{ key: 'app', protocolClass: 'http', algorithm: 'round_robin' }],
      backends: [be('a', '10.0.0.1', extra)],
      listeners: [{
        key: 'front', protocol: 'http', bind: '0.0.0.0', port: 8080, enabled: true,
        http: { defaultAction: { pool: 'app' } },
      }],
      httpRoutes: [], passthroughRoutes: [],
      certificates: [], tlsPolicies: [], sniBindings: [],
    });
    return r.ok ? '' : JSON.stringify(r.issues);
  };

  it('`softMaxConns: 0` 을 안 받는다 — 그건 상한이 아니라 드레인이다', () => {
    expect(bad({ softMaxConns: 0 })).toMatch(/softMaxConns/);
  });

  it('모르는 필드를 안 받는다', () => {
    expect(bad({ maxConns: 10 })).toMatch(/unknown_field/);
  });
});
