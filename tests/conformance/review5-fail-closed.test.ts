/**
 * 5차 검수 반례 ⑦ — 모델은 fail closed 여야 한다 (DESIGN.md §9.1.1 blocker 4)
 *
 * 4차 검수에서 "렌더러가 잘못된 입력을 조용히 다른 의미로 바꾼다" 를 고쳤다고 적었다.
 * 5차 검수가 같은 계열을 다시 재현했다 — 네 가지 잘못된 조합이 **검증 issue 0 건**으로
 * 통과했다. `provisional` 이라는 표시는 불완전성을 설명할 뿐 조용한 수용을 정당화하지 않는다.
 *
 * 조용한 것이 왜 위험한지는 `render.ts` 를 보면 된다. 기본 풀이 없는 TCP 리스너는
 * 예외를 내지 않는다. **렌더 결과에서 그냥 빠진다.** 저장도 되고 `nginx -t` 도 통과하는데
 * 그 포트만 열리지 않는다.
 *
 * 원칙 두 줄.
 *   1. 표현할 수 있으면 언젠가 들어온다. 표현 가능한 잘못된 조합은 **거부**한다.
 *   2. 거부는 조용한 수용보다 낫다. "저장은 됐는데 동작하지 않는" 상태를 만들지 않는다.
 */
import { describe, expect, it } from 'vitest';
import { validateModel, type ModelIssueCode } from '../../src/validate/model.js';
import type { Pool, RawModel } from '../../src/model/provisional.js';

const httpPool: Pool = { key: 'ph', protocolClass: 'http', algorithm: 'round_robin' };
const tcpPool: Pool = { key: 'pt', protocolClass: 'tcp', algorithm: 'round_robin' };
const udpPool: Pool = { key: 'pu', protocolClass: 'udp', algorithm: 'round_robin' };

const backend = (pool: string, key = `b-${pool}`) => ({
  key,
  pool,
  host: '10.0.0.1',
  port: 8080,
  weight: 1,
});

/**
 * **RawModel 이다.** 여기서 만드는 것은 대부분 잘못된 모델이고, 잘못된 모델은 정의상
 * 검증된 타입으로 표현할 수 없다. 판별 유니온이 컴파일 단계에서 막는 것과 검증기가
 * 런타임에 막는 것은 **다른 층**이다 — 입력은 JSON 으로 오므로 둘 다 필요하다.
 */
const model = (over: Partial<RawModel> = {}): RawModel => ({
  listeners: [],
  httpRoutes: [],
  certificates: [], tlsPolicies: [], sniBindings: [],
  passthroughRoutes: [],
  pools: [httpPool, tcpPool, udpPool],
  backends: [backend('ph'), backend('pt'), backend('pu')],
  ...over,
});

const codes = (m: RawModel): ModelIssueCode[] => validateModel(m).map((i) => i.code).sort();

// ── 먼저 positive control ────────────────────────────────────────────────
//
// 거부만 하는 검증기는 쓸모가 없다. 정상 모델이 통과하는 것을 먼저 못박는다.

describe('정상 모델은 통과한다', () => {
  it('http 리스너 + 라우트', () => {
    expect(
      codes(
        model({
          listeners: [{ key: 'lh', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true }],
          httpRoutes: [
            {
              key: 'r',
              listener: 'lh',
              hosts: ['a.example'],
              priority: 1,
              action: { kind: 'proxy', pool: 'ph', websocket: false },
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it('tcp 리스너 + 기본 풀', () => {
    expect(
      codes(
        model({
          listeners: [
            { key: 'lt', protocol: 'tcp', bind: '0.0.0.0', port: 9000, enabled: true, defaultPool: 'pt' },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it('udp 리스너 + 기본 풀 + 프리셋', () => {
    expect(
      codes(
        model({
          listeners: [
            {
              key: 'lu',
              protocol: 'udp',
              bind: '0.0.0.0',
              port: 53,
              enabled: true,
              defaultPool: 'pu',
              udp: { preset: 'dns' },
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it('tls_passthrough 리스너 + SNI 라우트', () => {
    expect(
      codes(
        model({
          listeners: [
            { key: 'lp', protocol: 'tls_passthrough', bind: '0.0.0.0', port: 443, enabled: true },
          ],
          certificates: [], tlsPolicies: [], sniBindings: [],
          passthroughRoutes: [
            { key: 'r', listener: 'lp', snis: ['a.example'], priority: 1, action: { kind: 'proxy', pool: 'pt' } },
          ],
        }),
      ),
    ).toEqual([]);
  });
});

// ── ⑦a 갈 곳 없는 리스너 ────────────────────────────────────────────────

describe('⑦a 라우트가 없는 리스너는 기본 풀이 있어야 한다', () => {
  it('기본 풀 없는 tcp 리스너는 거부된다 — 렌더에서 조용히 사라진다', () => {
    expect(
      codes(model({ listeners: [{ key: 'lt', protocol: 'tcp', bind: '0.0.0.0', port: 9000, enabled: true }] })),
    ).toContain<ModelIssueCode>('listener_requires_default_pool');
  });

  it('기본 풀 없는 udp 리스너도 거부된다', () => {
    expect(
      codes(
        model({
          listeners: [
            { key: 'lu', protocol: 'udp', bind: '0.0.0.0', port: 53, enabled: true, udp: { preset: 'dns' } },
          ],
        }),
      ),
    ).toContain<ModelIssueCode>('listener_requires_default_pool');
  });

  it('비활성 리스너도 마찬가지다 — 켜는 순간 구멍이 된다', () => {
    expect(
      codes(model({ listeners: [{ key: 'lt', protocol: 'tcp', bind: '0.0.0.0', port: 9000, enabled: false }] })),
    ).toContain<ModelIssueCode>('listener_requires_default_pool');
  });
});

// ── ⑦b 프로토콜이 안 맞는 참조 ──────────────────────────────────────────

describe('⑦b 라우트는 자기 프로토콜의 리스너만 가리킨다', () => {
  it('HTTP 라우트가 TCP 리스너를 가리키면 거부된다', () => {
    expect(
      codes(
        model({
          listeners: [
            { key: 'lt', protocol: 'tcp', bind: '0.0.0.0', port: 9000, enabled: true, defaultPool: 'pt' },
          ],
          httpRoutes: [
            {
              key: 'r',
              listener: 'lt',
              hosts: ['a.example'],
              priority: 1,
              action: { kind: 'proxy', pool: 'ph', websocket: false },
            },
          ],
        }),
      ),
    ).toContain<ModelIssueCode>('route_protocol_mismatch');
  });

  it('SNI 라우트가 http 리스너를 가리켜도 거부된다', () => {
    expect(
      codes(
        model({
          listeners: [{ key: 'lh', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true }],
          certificates: [], tlsPolicies: [], sniBindings: [],
          passthroughRoutes: [
            { key: 'r', listener: 'lh', snis: ['a.example'], priority: 1, action: { kind: 'proxy', pool: 'pt' } },
          ],
        }),
      ),
    ).toContain<ModelIssueCode>('route_protocol_mismatch');
  });

  it('http 리스너가 tcp 풀로 프록시하면 거부된다 — 서브시스템이 다르다', () => {
    expect(
      codes(
        model({
          listeners: [{ key: 'lh', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true }],
          httpRoutes: [
            {
              key: 'r',
              listener: 'lh',
              hosts: ['a.example'],
              priority: 1,
              action: { kind: 'proxy', pool: 'pt', websocket: false },
            },
          ],
        }),
      ),
    ).toContain<ModelIssueCode>('pool_protocol_mismatch');
  });

  it('udp 리스너가 tcp 풀을 기본으로 쓰면 거부된다', () => {
    expect(
      codes(
        model({
          listeners: [
            {
              key: 'lu',
              protocol: 'udp',
              bind: '0.0.0.0',
              port: 53,
              enabled: true,
              defaultPool: 'pt',
              udp: { preset: 'dns' },
            },
          ],
        }),
      ),
    ).toContain<ModelIssueCode>('pool_protocol_mismatch');
  });
});

// ── ⑦c 고아 백엔드 ──────────────────────────────────────────────────────

describe('⑦c 고아 백엔드는 거부된다', () => {
  it('없는 풀을 가리키는 백엔드', () => {
    expect(
      codes(
        model({
          listeners: [{ key: 'lh', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true }],
          backends: [backend('ph'), backend('없는풀', 'b-orphan')],
        }),
      ),
    ).toContain<ModelIssueCode>('orphan_backend');
  });
});

// ── ⑦d 지원하지 않는 옵션 ───────────────────────────────────────────────

describe('⑦d 엔진이 지원하지 않는 옵션 조합은 거부된다', () => {
  it('UDP 리스너의 acceptProxyProtocol (§4.7 — 엔진 미지원)', () => {
    expect(
      codes(
        model({
          listeners: [
            {
              key: 'lu',
              protocol: 'udp',
              bind: '0.0.0.0',
              port: 53,
              enabled: true,
              defaultPool: 'pu',
              acceptProxyProtocol: { trustedCidrs: ['10.0.0.0/8'] },
              udp: { preset: 'dns' },
            },
          ],
        }),
      ),
    ).toContain<ModelIssueCode>('option_not_supported');
  });

  it('http 풀의 sendProxyProtocol — http 에는 송신 디렉티브가 없다', () => {
    expect(
      codes(
        model({
          pools: [{ ...httpPool, sendProxyProtocol: 'v1' }, tcpPool, udpPool],
          listeners: [{ key: 'lh', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true }],
        }),
      ),
    ).toContain<ModelIssueCode>('option_not_supported');
  });

  it('udp 풀의 sendProxyProtocol', () => {
    expect(
      codes(
        model({
          pools: [httpPool, tcpPool, { ...udpPool, sendProxyProtocol: 'v1' }],
          listeners: [
            {
              key: 'lu', protocol: 'udp', bind: '0.0.0.0', port: 53, enabled: true,
              defaultPool: 'pu', udp: { preset: 'dns' },
            },
          ],
        }),
      ),
    ).toContain<ModelIssueCode>('option_not_supported');
  });

  it('http 가 아닌 리스너의 http 프로필', () => {
    expect(
      codes(
        model({
          listeners: [
            {
              key: 'lt', protocol: 'tcp', bind: '0.0.0.0', port: 9000, enabled: true,
              defaultPool: 'pt', http: { defaultAction: 'reject' },
            },
          ],
        }),
      ),
    ).toContain<ModelIssueCode>('option_not_supported');
  });

  it('udp 가 아닌 리스너의 udp 프로필', () => {
    expect(
      codes(
        model({
          listeners: [
            {
              key: 'lt', protocol: 'tcp', bind: '0.0.0.0', port: 9000, enabled: true,
              defaultPool: 'pt', udp: { preset: 'dns' },
            },
          ],
        }),
      ),
    ).toContain<ModelIssueCode>('option_not_supported');
  });

  it('패스스루가 아닌 리스너의 SNI 폴백', () => {
    expect(
      codes(
        model({
          listeners: [
            {
              key: 'lt', protocol: 'tcp', bind: '0.0.0.0', port: 9000, enabled: true,
              defaultPool: 'pt', onUnmatchedSni: 'reject',
            },
          ],
        }),
      ),
    ).toContain<ModelIssueCode>('option_not_supported');
  });

  it('라우트로 가르는 리스너의 기본 풀 — 어느 쪽이 이기는지 모른다', () => {
    expect(
      codes(
        model({
          listeners: [
            { key: 'lh', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true, defaultPool: 'ph' },
          ],
        }),
      ),
    ).toContain<ModelIssueCode>('option_not_supported');
  });
});
