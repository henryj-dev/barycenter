/**
 * 제안 #6 — **레이트리밋과 커넥션 제한** (2026-08-23)
 *
 * `limit_req`·`limit_conn` 은 리버스 프록시에 사실상 필수인데 모델에 없었다.
 *
 * ── 자리가 둘로 갈린다 (다른 이유로)
 *
 * 제안 #7 은 nginx 의 **대체** 규칙 때문에 갈렸다. 여기는 다르다: zone **선언**은
 * `http` 블록에만 있을 수 있고, **적용**은 server/location 이다. 하나가 다른 하나를
 * 참조하므로 이름이 서로 맞아야 한다.
 *
 *   `limit_req_zone`  → http   (선언. 공유 메모리를 잡는다)
 *   `limit_req`       → server (적용)
 *
 * zone 이름은 **리스너 키에서 판다.** 별도 리소스로 만들면 "이 zone 을 누가 쓰나" 가
 * 모델에 또 하나의 참조 그래프가 되고, 그 대가에 비해 얻는 것이 없다 — 지금 쓰는 쪽이
 * 리스너 하나뿐이다.
 *
 * ── 키는 고정이다
 *
 * `$binary_remote_addr` 만 쓴다. 사용자가 키를 고르게 하면 nginx 변수 표면이 통째로
 * 열리고(§4.9 가 화이트리스트로 좁혀 둔 그것), 얻는 것은 "누구를 세는가" 의 변형뿐이다.
 * realip 뒤라 PROXY protocol 을 쓰는 배포에서도 **진짜 클라이언트**를 센다.
 */
import { describe, expect, it } from 'vitest';

import { render } from '../../src/conf/render.js';
import { decodeModel } from '../../src/model/decode.js';
import type { Model } from '../../src/model/provisional.js';

const ON = { streamRealip: false, httpLua: true, streamLua: true };

const base = (rateLimit?: unknown, key = 'web'): Model => ({
  listeners: [{
    key, protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true,
    http: { defaultAction: { pool: 'app' }, ...(rateLimit === undefined ? {} : { rateLimit }) },
  }] as Model['listeners'],
  httpRoutes: [], passthroughRoutes: [],
  pools: [{ key: 'app', protocolClass: 'http', algorithm: 'round_robin' }],
  backends: [{ key: 'a', pool: 'app', host: '10.0.0.1', port: 80, weight: 1 }],
  certificates: [], tlsPolicies: [], sniBindings: [],
});

describe('레이트리밋·커넥션 제한 (제안 #6)', () => {
  it('**안 적으면 렌더 바이트가 한 글자도 안 바뀐다**', () => {
    const conf = render(base(), ON).conf;
    expect(conf).not.toContain('limit_req');
    expect(conf).not.toContain('limit_conn');
  });

  it('zone 선언은 http 블록에, 적용은 server 에 — 이름이 맞는다', () => {
    const conf = render(base({ requestsPerSecond: 10, burst: 20 }), ON).conf;
    expect(conf).toContain('limit_req_zone $binary_remote_addr zone=bary_req_web:10m rate=10r/s;');
    expect(conf).toContain('limit_req zone=bary_req_web burst=20;');

    // 선언이 적용보다 **앞**이어야 한다 — nginx 는 모르는 zone 을 참조하면 기동을 거부한다.
    expect(conf.indexOf('limit_req_zone')).toBeLessThan(conf.indexOf('limit_req zone='));
    // 그리고 선언은 upstream 과 같은 층(http)이다.
    expect(conf.indexOf('limit_req_zone')).toBeLessThan(conf.indexOf('server {'));
  });

  it('`nodelay` 는 적어야 나온다 — 기본은 지연이다', () => {
    // `nodelay` 는 burst 를 즉시 통과시킨다. 켜고 끄는 차이가 부하 형태를 바꾸므로
    // 기본값을 우리가 고르지 않는다.
    expect(render(base({ requestsPerSecond: 5, burst: 10 }), ON).conf)
      .toContain('limit_req zone=bary_req_web burst=10;');
    expect(render(base({ requestsPerSecond: 5, burst: 10, nodelay: true }), ON).conf)
      .toContain('limit_req zone=bary_req_web burst=10 nodelay;');
  });

  it('`burst` 없이도 선다', () => {
    expect(render(base({ requestsPerSecond: 1 }), ON).conf).toContain('limit_req zone=bary_req_web;');
  });

  it('커넥션 제한은 자기 zone 을 쓴다 — req 와 conn 은 다른 zone 타입이다', () => {
    const conf = render(base({ maxConnections: 100 }), ON).conf;
    expect(conf).toContain('limit_conn_zone $binary_remote_addr zone=bary_conn_web:10m;');
    expect(conf).toContain('limit_conn bary_conn_web 100;');
    // 레이트리밋을 안 적었으면 그쪽 zone 은 없다.
    expect(conf).not.toContain('limit_req_zone');
  });

  it('둘 다 적으면 zone 이 둘 난다', () => {
    const conf = render(base({ requestsPerSecond: 10, maxConnections: 100 }), ON).conf;
    expect(conf).toContain('limit_req_zone');
    expect(conf).toContain('limit_conn_zone');
  });

  it('zone 크기를 정할 수 있다 — 차면 nginx 가 503 을 낸다', () => {
    const conf = render(base({ requestsPerSecond: 10, zoneKb: 1024 }), ON).conf;
    expect(conf).toContain('zone=bary_req_web:1m ');
  });

  it('**리스너 키가 nginx 식별자가 아니어도 선다** — zone 이름을 판다', () => {
    /**
     * `ident` 는 문자를 바꾸면서 **다이제스트를 붙인다.** 단사성을 지키기 위해서다 —
     * `a-b` 와 `a_b` 가 같은 zone 이름이 되면 두 리스너가 한 zone 을 나눠 쓰고,
     * 그건 "왜 옆 리스너 트래픽에 내가 막히나" 가 된다.
     */
    const conf = render(base({ requestsPerSecond: 10 }, 'web-edge.1'), ON).conf;
    const m = /zone=(bary_req_web_edge_1_[0-9a-f]{8}):/.exec(conf);
    expect(m, conf.slice(0, 400)).not.toBeNull();
    expect(conf).toContain(`limit_req zone=${m![1]};`);
  });

  it('**두 리스너가 zone 을 안 나눠 쓴다** — 이름이 서로 다르다', () => {
    const two = base({ requestsPerSecond: 10 });
    two.listeners = [
      two.listeners[0]!,
      { ...two.listeners[0]!, key: 'other', port: 81 } as typeof two.listeners[0],
    ];
    const conf = render(two, ON).conf;
    expect(conf).toContain('zone=bary_req_web:');
    expect(conf).toContain('zone=bary_req_other:');
  });

  describe('해독기가 경계에서 막는다', () => {
    const decode = (rateLimit: unknown) => decodeModel({
      ...base(), listeners: [{
        key: 'web', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true,
        http: { defaultAction: { pool: 'app' }, rateLimit },
      }],
    });

    it('모르는 키를 거부한다', () => {
      expect(decode({ requestsPerSecond: 1, nope: 1 }).ok).toBe(false);
    });

    it('0 과 음수와 정수 아닌 값을 거부한다', () => {
      expect(decode({ requestsPerSecond: 0 }).ok).toBe(false);
      expect(decode({ requestsPerSecond: -1 }).ok).toBe(false);
      expect(decode({ requestsPerSecond: 1.5 }).ok).toBe(false);
      expect(decode({ maxConnections: 0 }).ok).toBe(false);
    });

    it('**`burst` 만 적는 것을 거부한다** — 무엇의 burst 인지 없다', () => {
      // `limit_req burst=` 는 zone 없이 못 쓴다. 저장은 되는데 렌더가 못 하는 조합을
      // 만들지 않는다.
      expect(decode({ burst: 10 }).ok).toBe(false);
      expect(decode({ nodelay: true }).ok).toBe(false);
    });

    it('빈 객체를 거부한다 — 아무것도 안 할 거면 안 적는 것과 같다', () => {
      expect(decode({}).ok).toBe(false);
    });

    it('제대로 된 것은 통과한다', () => {
      const r = decode({ requestsPerSecond: 10, burst: 20, nodelay: true, maxConnections: 100 });
      expect(r.ok, JSON.stringify(r.ok ? [] : r.issues)).toBe(true);
    });
  });
});
