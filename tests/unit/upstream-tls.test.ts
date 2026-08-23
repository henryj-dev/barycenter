/**
 * `upstream_tls` — **백엔드로 가는 TLS** (§4.3, 2026-08-24)
 *
 * §4.3 표에 오래 적혀만 있고 코드에 없던 필드다. 넣으면서 지킨 것 넷:
 *
 *   ① **스킴으로 켠다.** `proxy_ssl_*` 만 내고 `proxy_pass http://` 를 그대로 두면
 *      평문으로 나가고 그 지시어들은 아무 일도 안 한다 — 조용히 안 걸리는 설정이다.
 *   ② **`verify` 는 번들 없이 못 켠다.** `proxy_ssl_verify on` 은
 *      `proxy_ssl_trusted_certificate` 가 없으면 아무것도 검증하지 못한다.
 *      "켰다" 와 "걸린다" 가 갈리는 자리다.
 *   ③ **패스스루가 가리키는 풀에는 금지.** 클라이언트 TLS 바이트를 다시 TLS 로 감싸면
 *      TLS-over-TLS 가 된다 (§4.3 제약표).
 *   ④ **udp 금지.** 엔진이 안 한다.
 *
 * 자료는 새로 만들지 않는다 — `Certificate` 가 이미 SecretStore 를 가리키고 세대
 * materializer 가 `certs/<key>/<version>/fullchain.pem` 으로 굽는다(S8 이 그 결박을
 * 실측했다). 번들만을 위한 두 번째 경로를 만들면 롤백 결박도 두 벌이 된다.
 */
import { describe, expect, it } from 'vitest';
import { render } from '../../src/conf/render.js';
import { validateModel } from '../../src/validate/model.js';
import { decodeModel } from '../../src/model/decode.js';
import type { Model } from '../../src/model/provisional.js';

const CA = {
  key: 'upstream-ca',
  // 버전은 hex 16~64 자다 (`parseRef`) — 자료의 digest 에서 온다.
  materialRef: 'store://upstream-ca@0123456789abcdef',
  chainDigest: 'sha256:c',
  keyDigest: 'sha256:k',
};

const httpModel = (upstreamTls: unknown, extra: Record<string, unknown> = {}): Model => ({
  listeners: [{
    key: 'web', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true,
    http: { defaultAction: { pool: 'app' } },
  }],
  httpRoutes: [{
    key: 'r', listener: 'web', hosts: ['a.test'], priority: 10,
    action: { kind: 'proxy', pool: 'app', websocket: false },
  }],
  passthroughRoutes: [],
  pools: [{ key: 'app', protocolClass: 'http', algorithm: 'round_robin', upstreamTls }],
  backends: [{ key: 'a', pool: 'app', host: '10.0.0.1', port: 443, weight: 1 }],
  certificates: [CA], tlsPolicies: [], sniBindings: [],
  ...extra,
} as unknown as Model);

describe('스킴으로 켠다', () => {
  it('안 켜면 평문이다 — 산출물이 예전과 같다', () => {
    const conf = render(httpModel(undefined)).conf;
    expect(conf).toContain('proxy_pass http://pool_app');
    expect(conf).not.toContain('proxy_ssl');
  });

  /** **①의 검사.** 스킴을 안 바꾸면 `proxy_ssl_*` 이 아무 일도 안 한다. */
  it('켜면 `proxy_pass https://` 가 된다', () => {
    const conf = render(httpModel({ enabled: true })).conf;
    expect(conf).toContain('proxy_pass https://pool_app');
    expect(conf).not.toContain('proxy_pass http://pool_app');
  });

  it('`enabled: false` 는 안 켠 것과 같다', () => {
    const conf = render(httpModel({ enabled: false })).conf;
    expect(conf).toContain('proxy_pass http://pool_app');
    expect(conf).not.toContain('proxy_ssl');
  });

  it('기본 액션 location 도 함께 바뀐다 — 라우트만 바꾸면 반만 켜진다', () => {
    const conf = render(httpModel({ enabled: true })).conf;
    // `server_name _` 의 기본 블록에도 https 가 나가야 한다.
    expect((conf.match(/proxy_pass https:\/\/pool_app/g) ?? []).length).toBeGreaterThan(1);
  });
});

describe('SNI 와 신뢰 번들', () => {
  /**
   * `proxy_ssl_name` 을 안 주면 nginx 는 **업스트림 주소**를 SNI 로 쓴다. 멤버십
   * 평면에서 그 주소는 IP 라(슬롯이 `host:port` 다) 백엔드가 이름으로 인증서를 못 고른다.
   */
  it('sni 를 주면 `proxy_ssl_name` 이 난다', () => {
    expect(render(httpModel({ enabled: true, sni: 'backend.internal' })).conf)
      .toContain('proxy_ssl_name backend.internal;');
  });

  it('sni 를 안 주면 그 줄도 안 낸다 — 값을 지어내지 않는다', () => {
    expect(render(httpModel({ enabled: true })).conf).not.toContain('proxy_ssl_name');
  });

  it('번들을 주면 세대 경로를 가리킨다 — 버전이 들어간다', () => {
    const conf = render(httpModel({ enabled: true, caBundle: 'upstream-ca' })).conf;
    expect(conf).toContain(
      'proxy_ssl_trusted_certificate certs/upstream-ca/0123456789abcdef/fullchain.pem;');
  });

  /** **②의 검사.** 번들이 있어야 `verify` 가 뜻을 갖는다. */
  it('verify 는 번들과 함께 난다', () => {
    const conf = render(httpModel({ enabled: true, verify: true, caBundle: 'upstream-ca' })).conf;
    expect(conf).toContain('proxy_ssl_verify on;');
    expect(conf).toContain('proxy_ssl_trusted_certificate');
  });
});

describe('검증기가 막는 것들', () => {
  /** **②** — 번들 없는 `verify` 는 "켰다" 와 "걸린다" 가 갈린다. */
  it('번들 없는 verify 를 막는다', () => {
    const issues = validateModel(httpModel({ enabled: true, verify: true }));
    expect(issues.some((i) => JSON.stringify(i).includes('caBundle 이 없다')),
      JSON.stringify(issues)).toBe(true);
  });

  it('없는 인증서를 번들로 가리키면 막는다', () => {
    const issues = validateModel(httpModel({ enabled: true, caBundle: 'nope' }));
    expect(issues.some((i) => JSON.stringify(i).includes('nope'))).toBe(true);
  });

  /** 자료 없는 인증서(ACME 발급 전)는 렌더가 낼 파일이 없다. */
  it('자료 없는 인증서를 번들로 쓰면 막는다', () => {
    const m = httpModel({ enabled: true, caBundle: 'pending' }, {
      certificates: [CA, { key: 'pending' }],
    });
    const issues = validateModel(m);
    expect(issues.some((i) => JSON.stringify(i).includes('자료가 없다'))).toBe(true);
  });

  /** **④** — 엔진이 안 한다. */
  it('udp 풀은 막는다', () => {
    const m = {
      listeners: [{
        key: 'dns', protocol: 'udp', bind: '0.0.0.0', port: 53, enabled: true,
        defaultPool: 'u', udp: { preset: 'dns' },
      }],
      httpRoutes: [], passthroughRoutes: [],
      pools: [{ key: 'u', protocolClass: 'udp', algorithm: 'round_robin', upstreamTls: { enabled: true } }],
      backends: [{ key: 'b', pool: 'u', host: '10.0.0.1', port: 53, weight: 1 }],
      certificates: [], tlsPolicies: [], sniBindings: [],
    } as unknown as Model;
    const issues = validateModel(m);
    expect(issues.some((i) => JSON.stringify(i).includes('udp'))).toBe(true);
  });

  /**
   * **③ — TLS-over-TLS.** 패스스루는 클라이언트 TLS 바이트를 그대로 나른다. 그 위에
   * 다시 TLS 를 씌우면 백엔드가 두 겹을 벗겨야 하고, 아무도 그렇게 안 만든다.
   */
  it('패스스루 라우트가 가리키는 풀은 막는다', () => {
    const m = {
      listeners: [{
        key: 'tls', protocol: 'tls_passthrough', bind: '0.0.0.0', port: 443, enabled: true,
      }],
      httpRoutes: [],
      passthroughRoutes: [{
        key: 'p', listener: 'tls', snis: ['a.test'], priority: 10,
        action: { kind: 'proxy', pool: 'raw' },
      }],
      pools: [{ key: 'raw', protocolClass: 'tcp', algorithm: 'round_robin', upstreamTls: { enabled: true } }],
      backends: [{ key: 'b', pool: 'raw', host: '10.0.0.1', port: 443, weight: 1 }],
      certificates: [], tlsPolicies: [], sniBindings: [],
    } as unknown as Model;
    const issues = validateModel(m);
    expect(issues.some((i) => JSON.stringify(i).includes('TLS-over-TLS')),
      JSON.stringify(issues)).toBe(true);
  });
});

describe('stream 은 스킴이 없다 — `proxy_ssl on` 으로 켠다', () => {
  const tcpModel = (upstreamTls: unknown): Model => ({
    listeners: [{
      key: 'raw', protocol: 'tcp', bind: '0.0.0.0', port: 9000, enabled: true, defaultPool: 'app',
    }],
    httpRoutes: [], passthroughRoutes: [],
    pools: [{ key: 'app', protocolClass: 'tcp', algorithm: 'round_robin', upstreamTls }],
    backends: [{ key: 'a', pool: 'app', host: '10.0.0.1', port: 443, weight: 1 }],
    certificates: [CA], tlsPolicies: [], sniBindings: [],
  } as unknown as Model);

  it('켜면 `proxy_ssl on` 이 난다', () => {
    expect(render(tcpModel({ enabled: true })).conf).toContain('proxy_ssl on;');
  });

  it('안 켜면 안 낸다', () => {
    expect(render(tcpModel(undefined)).conf).not.toContain('proxy_ssl');
  });

  it('같은 지시어 이름을 쓴다 — 번들도 stream 에서 보인다', () => {
    const conf = render(tcpModel({ enabled: true, verify: true, caBundle: 'upstream-ca' })).conf;
    expect(conf).toContain(
      'proxy_ssl_trusted_certificate certs/upstream-ca/0123456789abcdef/fullchain.pem;');
    expect(conf).toContain('proxy_ssl_verify on;');
  });
});

describe('해독기', () => {
  it('`enabled` 는 필수다 — "켜라는 건가" 가 안 정해진 값을 안 받는다', () => {
    const out = decodeModel({
      listeners: [], httpRoutes: [], passthroughRoutes: [],
      pools: [{ key: 'p', protocolClass: 'http', algorithm: 'round_robin', upstreamTls: { sni: 'x' } }],
      backends: [], certificates: [], tlsPolicies: [], sniBindings: [],
    });
    expect(out.ok).toBe(false);
  });

  it('모르는 키를 거부한다', () => {
    const out = decodeModel({
      listeners: [], httpRoutes: [], passthroughRoutes: [],
      pools: [{
        key: 'p', protocolClass: 'http', algorithm: 'round_robin',
        upstreamTls: { enabled: true, insecureSkipVerify: true },
      }],
      backends: [], certificates: [], tlsPolicies: [], sniBindings: [],
    });
    expect(out.ok, '모르는 키가 통과했다 — "검증을 끄는" 이름이 그렇게 들어온다').toBe(false);
  });
});
