/**
 * **해독기 · 렌더러 퍼징** (2026-11-03, fast-check 속성 기반 시험).
 *
 * 모델은 API 로 들어오는 바깥 JSON 이다. 손으로 고른 예시로는 「이상한 모양」 을 다 못 덮는다. 그래서 무작위 입력으로 잰다:
 *
 *   · 해독기는 **어떤 JSON 에도 던지지 않는다** — `{ ok: true, model }` 이거나 이유 목록이다. 던지면 API 가 500 을 낸다.
 *   · 해독된 모델의 렌더는 **산출물을 내거나 `ModelValidationError` 로만** 실패한다. 다른 예외는 렌더러의 버그다
 *     (검증기가 못 막은 모양이 렌더러에 닿았다는 뜻).
 *   · 대역 포함 판정은 반사적이고, 넓은 대역이 좁은 대역을 덮으면 그 안의 주소도 덮는다.
 *
 * 실패하면 fast-check 가 가장 작은 반례와 seed 를 낸다 — 그대로 다시 돌릴 수 있다.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { decodeModel } from '../../src/model/decode.js';
import { render } from '../../src/conf/render.js';
import { ModelValidationError } from '../../src/validate/model.js';
import { cidrCovers } from '../../src/validate/ip.js';

const caps = { streamRealip: false, httpLua: true, streamLua: true };

/** 그럴듯한 조각 — 아무 JSON 만으로는 해독기 첫 문을 거의 못 지난다. 실제 키 이름과 값 모양을 섞는다. */
const key = fc.stringMatching(/^[a-z][a-z0-9.-]{0,8}$/);
const host = fc.constantFrom('a.test', 'b.test', '*.c.test', 'x', '', '127.0.0.1');
const path = fc.constantFrom('/', '/api/', '/v2', '/a b', '', '/.well-known/acme-challenge/x', '/%2e');
const cidr = fc.constantFrom('10.0.0.0/8', '10.1.0.0/16', '192.0.2.7', '::1', '2001:db8::/32', '@office', 'nope', '0.0.0.0/0');
const action = fc.oneof(
  fc.record({ kind: fc.constant('proxy'), pool: key, websocket: fc.boolean() }),
  fc.record({ kind: fc.constant('redirect'), to: fc.constantFrom('https://x.test/', '$host', ''), status: fc.constantFrom(301, 302, 307, 308, 200) }),
  fc.record({ kind: fc.constant('reject'), status: fc.constantFrom(403, 404, 444, 500) }),
  fc.jsonValue(),
);
const route = fc.record({
  key, listener: key, hosts: fc.array(host, { maxLength: 3 }), priority: fc.integer({ min: -1, max: 3 }),
  pathPrefix: fc.option(path, { nil: undefined }),
  pathPrefixes: fc.option(fc.array(path, { maxLength: 3 }), { nil: undefined }),
  action,
  sourceRules: fc.option(fc.array(fc.record({
    from: fc.array(cidr, { maxLength: 3 }), action,
    address: fc.option(fc.constantFrom('visitor', 'connection', 'peer'), { nil: undefined }),
  }), { maxLength: 3 }), { nil: undefined }),
}, { requiredKeys: ['key', 'listener', 'hosts', 'priority', 'action'] });
const listener = fc.record({
  key, protocol: fc.constantFrom('http', 'https', 'tcp', 'udp', 'tls_passthrough', 'ftp'),
  bind: fc.constantFrom('0.0.0.0', '127.0.0.1', '10.0.0.5', '::', 'localhost'), port: fc.integer({ min: 0, max: 70000 }),
  enabled: fc.boolean(), http: fc.constant({ defaultAction: 'reject' }),
  hosts: fc.option(fc.array(host, { maxLength: 2 }), { nil: undefined }),
  sourceAllow: fc.option(fc.array(cidr, { maxLength: 2 }), { nil: undefined }),
}, { requiredKeys: ['key', 'protocol', 'bind', 'port', 'enabled'] });
const pool = fc.record({ key, protocolClass: fc.constantFrom('http', 'tcp', 'udp'), algorithm: fc.constantFrom('round_robin', 'least_conn', 'hash', 'x') });
const backend = fc.record({ key, pool: key, host: fc.constantFrom('10.0.0.1', 'b.test', ''), port: fc.integer({ min: 0, max: 70000 }), weight: fc.integer({ min: 0, max: 3 }) });
const nearModel = fc.record({
  listeners: fc.array(listener, { maxLength: 3 }),
  httpRoutes: fc.array(route, { maxLength: 4 }),
  passthroughRoutes: fc.constant([]),
  pools: fc.array(pool, { maxLength: 3 }),
  backends: fc.array(backend, { maxLength: 3 }),
  certificates: fc.constant([]), tlsPolicies: fc.constant([]), sniBindings: fc.constant([]),
  addressSets: fc.option(fc.array(fc.record({ key: fc.constantFrom('office', 'cf'), cidrs: fc.array(cidr, { minLength: 1, maxLength: 2 }) }), { maxLength: 2 }), { nil: undefined }),
}, { requiredKeys: ['listeners', 'httpRoutes', 'passthroughRoutes', 'pools', 'backends', 'certificates', 'tlsPolicies', 'sniBindings'] });

/** 해독이 되면 렌더한다. 산출물이거나 검증 오류여야 한다 — 그 밖은 렌더러 버그다. */
function renderOutcome(input: unknown): 'decode-rejected' | 'rendered' | 'invalid' {
  const d = decodeModel(input);
  if (!d.ok) {
    expect(Array.isArray(d.issues) && d.issues.length > 0).toBe(true);
    return 'decode-rejected';
  }
  try {
    const out = render(d.model, caps);
    expect(typeof out.conf).toBe('string');
    return 'rendered';
  } catch (e) {
    if (e instanceof ModelValidationError) return 'invalid';
    throw e;
  }
}

describe('퍼징 — 해독기 · 렌더러', () => {
  it('**어떤 JSON 에도 해독기가 던지지 않는다**', () => {
    fc.assert(fc.property(fc.jsonValue(), (v) => { decodeModel(v); }), { numRuns: 400 });
  });

  it('**그럴듯한 모델은 렌더되거나 검증 오류로만 실패한다** — 다른 예외는 렌더러 버그다', () => {
    const seen = new Set<string>();
    fc.assert(fc.property(nearModel, (m) => { seen.add(renderOutcome(m)); }), { numRuns: 300 });
    // 무작위가 문 앞에서만 맴돌면 이 시험은 아무것도 안 잰다 — 렌더까지 간 경우가 있어야 한다.
    expect(seen.has('rendered') || seen.has('invalid'), [...seen].join(',')).toBe(true);
  });
});

describe('퍼징 — 대역 포함', () => {
  const v4 = fc.tuple(fc.nat(255), fc.nat(255), fc.nat(255), fc.nat(255)).map((o) => o.join('.'));
  const v4cidr = fc.tuple(v4, fc.integer({ min: 0, max: 32 })).map(([a, n]) => `${a}/${n}`);

  it('반사적이다 — 모든 대역은 자기를 덮는다', () => {
    fc.assert(fc.property(v4cidr, (c) => cidrCovers(c, c)), { numRuns: 300 });
  });

  it('**/0 은 모든 IPv4 를 덮고, 덮는 대역은 그 안의 주소도 덮는다**', () => {
    fc.assert(fc.property(v4cidr, v4, (c, a) => {
      expect(cidrCovers('0.0.0.0/0', a)).toBe(true);
      if (cidrCovers(c, `${a}/32`)) expect(cidrCovers(c, a)).toBe(true);
    }), { numRuns: 300 });
  });

  it('계열이 다르면 덮지 않는다', () => {
    fc.assert(fc.property(v4cidr, (c) => !cidrCovers(c, '2001:db8::1') && !cidrCovers('::/0', c)), { numRuns: 200 });
  });
});
