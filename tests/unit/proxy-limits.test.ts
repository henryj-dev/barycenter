/**
 * 제안 #8 — **타임아웃·버퍼·본문 크기가 전부 nginx 기본값 고정이었다** (2026-08-23).
 *
 * `proxy_connect_timeout`(60s) · `proxy_read_timeout`(60s) · `client_max_body_size`(1m)
 * 를 정할 자리가 모델에 없었다. 실서비스로 넘어갈 때 가장 먼저 요구받는 것들이고,
 * 특히 `client_max_body_size` 는 기본 1m 이라 **업로드가 413 으로 죽는다** — 그런데
 * 고칠 손잡이가 없으니 이 제품을 못 쓴다.
 *
 * ── 어디에 두는가
 *
 * `HttpProfile` 이다. 이름 그대로 프로필의 자리이고, HTTP·HTTPS 리스너가 **둘 다**
 * 이 타입을 쓰므로 한 자리를 넓히면 둘이 함께 열린다.
 *
 * 라우트(location)별로 안 연다. nginx 는 거기서도 받지만, 라우트마다 다른 타임아웃을
 * 주려면 "어느 라우트가 어느 값을 상속받는가" 가 모델에 드러나야 하고 그건 다른 크기의
 * 일이다. **없는 것을 있는 척하지 않는다.**
 *
 * ── 안 적으면 한 글자도 안 바뀐다
 *
 * 이게 이 변경의 가장 중요한 성질이다. 설정을 안 건드린 배포의 렌더 바이트가 그대로여야
 * **다음 apply 에서 세대 전환이 안 일어난다.** B-12(dict 크기)에서 같은 이유로 1024 의
 * 배수를 `m` 으로 냈다.
 */
import { describe, expect, it } from 'vitest';

import { render } from '../../src/conf/render.js';
import { decodeModel } from '../../src/model/decode.js';
import type { Model } from '../../src/model/provisional.js';

const ON = { streamRealip: false, httpLua: true, streamLua: true };

const base = (limits?: unknown): Model => ({
  listeners: [{
    key: 'web', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true,
    http: { defaultAction: { pool: 'app' }, ...(limits === undefined ? {} : { limits }) },
  }] as Model['listeners'],
  httpRoutes: [], passthroughRoutes: [],
  pools: [{ key: 'app', protocolClass: 'http', algorithm: 'round_robin' }],
  backends: [{ key: 'a', pool: 'app', host: '10.0.0.1', port: 80, weight: 1 }],
  certificates: [], tlsPolicies: [], sniBindings: [],
});

describe('프록시 타임아웃·본문 크기 (제안 #8)', () => {
  it('**안 적으면 렌더 바이트가 한 글자도 안 바뀐다**', () => {
    // 안 그러면 설정을 안 건드린 전 배포가 다음 apply 에서 세대 전환을 한다.
    const conf = render(base(), ON).conf;
    expect(conf).not.toContain('proxy_connect_timeout');
    expect(conf).not.toContain('proxy_read_timeout');
    expect(conf).not.toContain('proxy_send_timeout');
    expect(conf).not.toContain('client_max_body_size');
  });

  it('적으면 server 블록에 나온다', () => {
    const conf = render(base({
      connectTimeoutMs: 5000, readTimeoutMs: 120_000, sendTimeoutMs: 90_000,
      clientMaxBodyBytes: 52_428_800,
    }), ON).conf;
    expect(conf).toContain('proxy_connect_timeout 5s;');
    expect(conf).toContain('proxy_read_timeout 120s;');
    expect(conf).toContain('proxy_send_timeout 90s;');
    expect(conf).toContain('client_max_body_size 50m;');
  });

  it('초로 안 떨어지면 ms 로 낸다 — 반올림해서 조용히 다른 값을 쓰지 않는다', () => {
    const conf = render(base({ connectTimeoutMs: 1500 }), ON).conf;
    expect(conf).toContain('proxy_connect_timeout 1500ms;');
  });

  it('본문 크기가 1024 의 배수면 `m`·`k` 로, 아니면 바이트로 낸다', () => {
    expect(render(base({ clientMaxBodyBytes: 1024 }), ON).conf).toContain('client_max_body_size 1k;');
    expect(render(base({ clientMaxBodyBytes: 1_048_576 }), ON).conf).toContain('client_max_body_size 1m;');
    expect(render(base({ clientMaxBodyBytes: 1500 }), ON).conf).toContain('client_max_body_size 1500;');
  });

  it('`0` 은 무제한이다 — 빠뜨린 것과 다르다', () => {
    // nginx 에서 `client_max_body_size 0` 은 검사를 끈다. 그 뜻을 표현할 수 있어야 한다.
    expect(render(base({ clientMaxBodyBytes: 0 }), ON).conf).toContain('client_max_body_size 0;');
  });

  it('일부만 적으면 적은 것만 나온다', () => {
    const conf = render(base({ readTimeoutMs: 300_000 }), ON).conf;
    expect(conf).toContain('proxy_read_timeout 300s;');
    expect(conf).not.toContain('proxy_connect_timeout');
    expect(conf).not.toContain('client_max_body_size');
  });

  describe('해독기가 경계에서 막는다', () => {
    const decode = (limits: unknown) => decodeModel({
      ...base(), listeners: [{
        key: 'web', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true,
        http: { defaultAction: { pool: 'app' }, limits },
      }],
    });

    it('모르는 키를 거부한다', () => {
      const r = decode({ readTimeoutMs: 1000, nope: 1 });
      expect(r.ok).toBe(false);
    });

    it('음수와 정수 아닌 값을 거부한다', () => {
      expect(decode({ readTimeoutMs: -1 }).ok).toBe(false);
      expect(decode({ readTimeoutMs: 1.5 }).ok).toBe(false);
      expect(decode({ clientMaxBodyBytes: -1 }).ok).toBe(false);
    });

    it('**`proxy_connect_timeout` 의 nginx 상한 75s 를 넘기면 거부한다**', () => {
      /**
       * nginx 문서가 못 박은 값이다: *"It should be noted that this timeout cannot
       * usually exceed 75 seconds."* 넘겨 적으면 조용히 무시되고, 운영자는 자기가
       * 정한 값이 안 먹는 이유를 영영 못 찾는다 — 저장 단계에서 막는 편이 정직하다.
       */
      expect(decode({ connectTimeoutMs: 75_001 }).ok).toBe(false);
      expect(decode({ connectTimeoutMs: 75_000 }).ok).toBe(true);
    });

    it('0 타임아웃을 거부한다 — nginx 가 안 받는다', () => {
      expect(decode({ readTimeoutMs: 0 }).ok).toBe(false);
    });

    it('제대로 된 값은 통과한다', () => {
      const r = decode({ connectTimeoutMs: 5000, readTimeoutMs: 120_000, clientMaxBodyBytes: 0 });
      expect(r.ok, JSON.stringify(r.ok ? [] : r.issues)).toBe(true);
    });
  });
});
