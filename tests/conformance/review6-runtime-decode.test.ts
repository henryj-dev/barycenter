/**
 * 6차 검수 반례 ① — 런타임 타입 검증 (DESIGN.md §4.9 · §9.1.1)
 *
 * **같은 지적을 두 번 받았다.**
 *
 *   4차: `protocol: 'https'` 가 평문 `listen 443;` 으로 렌더된다.
 *   5차: provisional 모델이 잘못된 조합을 표현 가능하게 두고 검증기가 승인한다.
 *   6차: `protocol: 'https'` 가 **여전히** issue 0 건으로 통과해 평문으로 렌더된다.
 *
 * 5차 뒤에 내가 한 것은 `RawModel`(입력) / `Model`(판별 유니온) 두 층을 만들고 **의미**
 * 검증을 늘린 것이었다. 그런데 판별 유니온은 **컴파일 타임뿐이고**, `validateModel` 은
 * 이미 `RawModel` 이라고 가정한 값을 받는다. 입력이 JSON 이면 아무도 안 막는다.
 *
 * 타입은 런타임 입력을 막지 못한다. **경계에서 해독해야 한다.**
 *
 * 원칙:
 *   1. 모르는 값은 거부한다. enum 은 **아는 것만** 통과한다.
 *   2. 모르는 키도 거부한다. 조용히 무시된 설정은 "저장됐는데 동작 안 함" 이 된다.
 *   3. 강제 변환하지 않는다. `"8080"` 은 8080 이 아니라 오류다.
 */
import { describe, expect, it } from 'vitest';
import { decodeModel, parseModel } from '../../src/model/decode.js';
import { render } from '../../src/conf/render.js';

const httpPool = { key: 'ph', protocolClass: 'http', algorithm: 'round_robin' };
const tcpPool = { key: 'pt', protocolClass: 'tcp', algorithm: 'round_robin' };
const backend = (pool: string, key = `b-${pool}`) => ({ key, pool, host: '10.0.0.1', port: 8080, weight: 1 });

const base = (over: Record<string, unknown> = {}): unknown => ({
  listeners: [],
  httpRoutes: [],
  passthroughRoutes: [],
  pools: [httpPool, tcpPool],
  backends: [backend('ph'), backend('pt')],
  ...over,
});

const codes = (input: unknown): string[] => {
  const r = decodeModel(input);
  return r.ok ? [] : r.issues.map((i) => i.code);
};
const messages = (input: unknown): string => {
  const r = decodeModel(input);
  return r.ok ? '' : r.issues.map((i) => `${i.code} ${i.subjects.join('/')} ${i.message}`).join(' | ');
};

// ── positive control ─────────────────────────────────────────────────────

describe('정상 입력은 해독된다', () => {
  it('http 리스너와 라우트', () => {
    const r = decodeModel(
      base({
        listeners: [{ key: 'lh', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true }],
        httpRoutes: [{
          key: 'r', listener: 'lh', hosts: ['a.example'], priority: 1,
          action: { kind: 'proxy', pool: 'ph', websocket: false },
        }],
      }),
    );
    expect(r.ok ? 'ok' : messages(base())).toBe('ok');
  });

  it('tcp · udp · 패스스루 전부', () => {
    const r = decodeModel(
      base({
        listeners: [
          { key: 'lt', protocol: 'tcp', bind: '0.0.0.0', port: 9000, enabled: true, defaultPool: 'pt' },
          { key: 'lu', protocol: 'udp', bind: '0.0.0.0', port: 53, enabled: true, defaultPool: 'pt', udp: { preset: 'dns' } },
          { key: 'lp', protocol: 'tls_passthrough', bind: '0.0.0.0', port: 443, enabled: true, onUnmatchedSni: 'reject' },
        ],
        pools: [httpPool, tcpPool, { key: 'pu', protocolClass: 'udp', algorithm: 'round_robin' }],
        backends: [backend('ph'), backend('pt'), backend('pu')],
      }),
    );
    expect(r.ok ? 'ok' : messages(base())).toBe('ok');
  });

  it('해독 결과는 입력과 같은 값이다 — 조용히 바꾸지 않는다', () => {
    const input = base({
      listeners: [{ key: 'lt', protocol: 'tcp', bind: '10.0.0.5', port: 9000, enabled: false, defaultPool: 'pt' }],
    });
    const r = decodeModel(input);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.model.listeners[0]).toEqual({
      key: 'lt', protocol: 'tcp', bind: '10.0.0.5', port: 9000, enabled: false, defaultPool: 'pt',
    });
  });
});

// ── ① 모르는 enum 값 ────────────────────────────────────────────────────

describe('① 모르는 enum 값은 거부된다 — 4차·6차에서 두 번 재현된 반례', () => {
  const listener = (over: Record<string, unknown>) =>
    base({ listeners: [{ key: 'l', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true, ...over }] });

  it("protocol: 'https' — 렌더러가 TLS 를 못 내는데 타입에 있으면 평문이 된다", () => {
    expect(codes(listener({ protocol: 'https', defaultPool: 'pt' }))).toContain('invalid_enum');
  });

  it("protocol: 'bogus'", () => {
    expect(codes(listener({ protocol: 'bogus', defaultPool: 'pt' }))).toContain('invalid_enum');
  });

  it("algorithm: 'least_conn' — v0 에 없다", () => {
    expect(codes(base({ pools: [{ ...httpPool, algorithm: 'least_conn' }] }))).toContain('invalid_enum');
  });

  it("protocolClass: 'https'", () => {
    expect(codes(base({ pools: [{ ...httpPool, protocolClass: 'https' }] }))).toContain('invalid_enum');
  });

  it('udp preset 이 모르는 값', () => {
    expect(
      codes(base({ listeners: [{ key: 'lu', protocol: 'udp', bind: '0.0.0.0', port: 53, enabled: true, defaultPool: 'pt', udp: { preset: '없음' } }] })),
    ).toContain('invalid_enum');
  });

  it('HTTP 액션의 kind 와 status', () => {
    const route = (action: unknown) =>
      base({
        listeners: [{ key: 'lh', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true }],
        httpRoutes: [{ key: 'r', listener: 'lh', hosts: ['a.example'], priority: 1, action }],
      });
    expect(codes(route({ kind: 'rewrite', pool: 'ph' }))).toContain('invalid_enum');
    expect(codes(route({ kind: 'redirect', to: '/x', status: 418 }))).toContain('invalid_enum');
    expect(codes(route({ kind: 'reject', status: 500 }))).toContain('invalid_enum');
  });

  it('sendProxyProtocol 이 v2 (엔진이 v1 만 낸다)', () => {
    expect(codes(base({ pools: [{ ...tcpPool, sendProxyProtocol: 'v2' }] }))).toContain('invalid_enum');
  });
});

// ── ② 타입과 필수 필드 ──────────────────────────────────────────────────

describe('② 타입이 다르면 거부된다 — 강제 변환하지 않는다', () => {
  const listener = (over: Record<string, unknown>) =>
    base({ listeners: [{ key: 'l', protocol: 'tcp', bind: '0.0.0.0', port: 9000, enabled: true, defaultPool: 'pt', ...over }] });

  it("port 가 문자열 '9000'", () => {
    expect(codes(listener({ port: '9000' }))).toContain('invalid_type');
  });

  it("enabled 가 문자열 'true'", () => {
    expect(codes(listener({ enabled: 'true' }))).toContain('invalid_type');
  });

  it('port 가 범위 밖이거나 정수가 아니다', () => {
    expect(codes(listener({ port: 0 }))).toContain('out_of_range');
    expect(codes(listener({ port: 65536 }))).toContain('out_of_range');
    expect(codes(listener({ port: 8080.5 }))).toContain('out_of_range');
    expect(codes(listener({ port: Number.NaN }))).toContain('out_of_range');
  });

  it('필수 필드가 없다', () => {
    const r = decodeModel(base({ listeners: [{ protocol: 'tcp', bind: '0.0.0.0', port: 9000, enabled: true, defaultPool: 'pt' }] }));
    expect(r.ok ? [] : r.issues.map((i) => i.code)).toContain('missing_field');
  });

  it('tcp·udp 리스너에 기본 풀이 없으면 타입 단계에서 막힌다', () => {
    expect(codes(base({ listeners: [{ key: 'l', protocol: 'tcp', bind: '0.0.0.0', port: 9000, enabled: true }] })))
      .toContain('missing_field');
  });

  it('udp 리스너에 udp 프로필이 없다 — 조용히 custom/600s 가 되면 안 된다', () => {
    expect(codes(base({ listeners: [{ key: 'lu', protocol: 'udp', bind: '0.0.0.0', port: 53, enabled: true, defaultPool: 'pt' }] })))
      .toContain('missing_field');
  });

  it('모델 자체가 객체가 아니다', () => {
    expect(codes(null)).toContain('invalid_type');
    expect(codes('모델')).toContain('invalid_type');
    expect(codes([])).toContain('invalid_type');
  });

  it('컬렉션이 배열이 아니다', () => {
    expect(codes(base({ listeners: {} }))).toContain('invalid_type');
  });
});

// ── ③ 모르는 키 ────────────────────────────────────────────────────────

describe('③ 모르는 키는 거부된다 — 조용히 무시된 설정이 제일 위험하다', () => {
  it('리스너의 오타 난 키', () => {
    expect(
      codes(base({ listeners: [{ key: 'l', protocol: 'tcp', bind: '0.0.0.0', port: 9000, enabled: true, defaultPool: 'pt', defaultPoool: 'pt' }] })),
    ).toContain('unknown_field');
  });

  it('풀의 모르는 키', () => {
    expect(codes(base({ pools: [{ ...httpPool, sticky: true }] }))).toContain('unknown_field');
  });

  it('모델의 모르는 컬렉션', () => {
    expect(codes(base({ certificates: [] }))).toContain('unknown_field');
  });

  it('프로토콜에 없는 필드는 **그 프로토콜에서** 모르는 키다', () => {
    // http 리스너에 SNI 폴백을 넣으면 판별 유니온상 존재하지 않는 필드다.
    expect(
      codes(base({ listeners: [{ key: 'lh', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true, onUnmatchedSni: 'reject' }] })),
    ).toContain('unknown_field');
  });
});

// ── ④ 렌더까지 이어진다 ─────────────────────────────────────────────────

describe('④ 해독하지 않은 값은 렌더에 도달하지 못한다', () => {
  it("render 가 protocol:'https' 를 평문으로 내지 않는다 — 4차·6차 반례", () => {
    const bad = base({
      listeners: [{ key: 'l', protocol: 'https', bind: '0.0.0.0', port: 443, enabled: true, defaultPool: 'pt' }],
    });
    expect(() => render(bad as never)).toThrow();
  });

  it('parseModel 이 성공하면 그 값으로 렌더된다', () => {
    const r = parseModel(
      base({ listeners: [{ key: 'lt', protocol: 'tcp', bind: '0.0.0.0', port: 9000, enabled: true, defaultPool: 'pt' }] }),
    );
    expect(r.ok ? 'ok' : r.issues.map((i) => i.message).join('|')).toBe('ok');
    if (r.ok) expect(render(r.model).conf).toContain('listen 9000');
  });

  it('parseModel 은 해독과 의미 검증을 **둘 다** 한다', () => {
    // 타입은 맞지만 참조가 깨졌다 → 의미 검증이 잡는다.
    const r = parseModel(
      base({ listeners: [{ key: 'lt', protocol: 'tcp', bind: '0.0.0.0', port: 9000, enabled: true, defaultPool: '없는풀' }] }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.code)).toContain('unknown_pool');
  });
});
