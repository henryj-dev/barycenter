/**
 * 제안 #7 — **요청·응답 헤더 조작** (2026-08-23)
 *
 * `validateHeaderName`/`validateHeaderValue` 는 변수 화이트리스트까지 이미 있었다.
 * 해시 키가 쓰고 있었고, 헤더를 얹는 쪽에서는 아무도 안 썼다 — 얹을 자리가 없었으니까.
 *
 * ── nginx 의 함정 둘. 둘 다 "상속이 아니라 대체" 다
 *
 * ① **`add_header`** — location 에 하나라도 있으면 상위 server 의 것이 **전부 사라진다.**
 *    `tests/golden/hsts.test.ts` 가 실측해 두고 그 사실에 기대고 있다: *"지금 렌더러는
 *    location 에 `add_header` 를 하나도 안 낸다."* 응답 헤더를 location 에 내면 **HSTS 가
 *    조용히 없어진다** — 그리고 HSTS 는 클라이언트 쪽에서 되돌릴 수 없다.
 *
 * ② **`proxy_set_header`** — 같은 규칙이다. 그런데 렌더러는 이미 location 에
 *    `Host`·`X-Forwarded-For`·`X-Forwarded-Proto` 를 낸다. 그러니 요청 헤더를 server 에
 *    내면 **그 셋에 지워진다.**
 *
 * 두 함정이 서로 반대 방향을 가리킨다. 그래서 자리가 갈린다:
 *
 *   응답 헤더 → **server** (HSTS 옆. location 에는 계속 아무것도 안 낸다)
 *   요청 헤더 → **location** (기존 셋 뒤에 붙인다)
 *
 * ── 그리고 못 덮게 하는 것들
 *
 * `X-Forwarded-For`·`X-Forwarded-Proto` 는 백엔드가 **신뢰하는** 값이다. 덮게 두면
 * 클라이언트 IP 사슬이 조용히 끊기고, 그건 나중에 보안 사고로 돌아온다.
 * `Upgrade`·`Connection` 은 websocket 이 그 위에 선다. `Strict-Transport-Security` 는
 * 모델에 자기 필드가 있다 — 출처가 둘이면 싸운다.
 *
 * `Host` 는 **연다.** 다른 Host 를 기대하는 백엔드로 프록시하는 것은 정당하고 흔하다.
 */
import { describe, expect, it } from 'vitest';

import { render } from '../../src/conf/render.js';
import { decodeModel } from '../../src/model/decode.js';
import type { Model } from '../../src/model/provisional.js';

const ON = { streamRealip: false, httpLua: true, streamLua: true };

const base = (headers?: unknown): Model => ({
  listeners: [{
    key: 'web', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true,
    http: { defaultAction: { pool: 'app' }, ...(headers === undefined ? {} : { headers }) },
  }] as Model['listeners'],
  httpRoutes: [{
    key: 'r', listener: 'web', hosts: ['a.test'], priority: 10,
    action: { kind: 'proxy', pool: 'app', websocket: false },
  }],
  passthroughRoutes: [],
  pools: [{ key: 'app', protocolClass: 'http', algorithm: 'round_robin' }],
  backends: [{ key: 'a', pool: 'app', host: '10.0.0.1', port: 80, weight: 1 }],
  certificates: [], tlsPolicies: [], sniBindings: [],
});

describe('헤더 조작 (제안 #7)', () => {
  it('**안 적으면 렌더 바이트가 한 글자도 안 바뀐다**', () => {
    const conf = render(base(), ON).conf;
    expect(conf).not.toContain('add_header');
    // 기존 셋은 그대로 있어야 한다 — 없어졌으면 이 테스트가 아니라 렌더러가 깨진 것이다.
    expect(conf).toContain('proxy_set_header Host $host;');
  });

  it('요청 헤더는 **location** 에 나온다 — server 에 내면 기존 셋에 지워진다', () => {
    const conf = render(base({ request: [{ name: 'X-Tenant', value: 'acme' }] }), ON).conf;
    expect(conf).toContain('proxy_set_header X-Tenant acme;');
    // 기존 셋과 같은 블록이어야 한다. 위치를 바이트로 잰다.
    const mine = conf.indexOf('proxy_set_header X-Tenant');
    const built = conf.indexOf('proxy_set_header X-Forwarded-For');
    expect(mine).toBeGreaterThan(built);
    // 사이에 블록 경계가 없어야 같은 location 이다.
    expect(conf.slice(built, mine)).not.toContain('}');
  });

  it('응답 헤더는 **server** 에 나온다 — location 에 내면 HSTS 가 사라진다', () => {
    const conf = render(base({ response: [{ name: 'X-Frame-Options', value: 'DENY' }] }), ON).conf;
    expect(conf).toContain('add_header X-Frame-Options DENY always;');
    /**
     * **location 블록 안에는 여전히 `add_header` 가 하나도 없다.** 이게 HSTS 가 서
     * 있는 전제다. 블록을 실제로 잘라서 잰다 — `indexOf('location')` 부터 끝까지
     * 보면 server 레벨 줄이 섞여 들어와 이 단언이 거짓으로 통과하거나 실패한다.
     */
    for (const m of conf.matchAll(/^(\s*)location [^\n]*\{\n([\s\S]*?)^\1\}$/gm)) {
      expect(m[2], `location 본문에 add_header 가 있다:\n${m[0]}`).not.toContain('add_header');
    }
  });

  it('응답 헤더에 `always` 를 붙인다 — 5xx 에도 나가야 한다', () => {
    // HSTS 가 같은 이유로 `always` 다. 에러 응답에서만 사라지는 보안 헤더는 최악이다.
    const conf = render(base({ response: [{ name: 'X-Content-Type-Options', value: 'nosniff' }] }), ON).conf;
    expect(conf).toMatch(/add_header X-Content-Type-Options nosniff always;/);
  });

  it('여러 개를 적은 순서대로 낸다', () => {
    const conf = render(base({
      request: [{ name: 'X-A', value: '1' }, { name: 'X-B', value: '2' }],
    }), ON).conf;
    expect(conf.indexOf('X-A')).toBeLessThan(conf.indexOf('X-B'));
  });

  it('허용된 변수는 값에 쓸 수 있다', () => {
    const conf = render(base({ request: [{ name: 'X-Real-Host', value: '$host' }] }), ON).conf;
    expect(conf).toContain('proxy_set_header X-Real-Host $host;');
  });

  describe('해독기가 경계에서 막는다', () => {
    const decode = (headers: unknown) => decodeModel({
      ...base(), listeners: [{
        key: 'web', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true,
        http: { defaultAction: { pool: 'app' }, headers },
      }],
    });

    it('token 이 아닌 이름을 거부한다', () => {
      expect(decode({ request: [{ name: 'X Bad', value: '1' }] }).ok).toBe(false);
      expect(decode({ request: [{ name: 'X:Bad', value: '1' }] }).ok).toBe(false);
    });

    it('**헤더 분리를 거부한다** — CR/LF 가 값에 들어가면 응답이 둘이 된다', () => {
      expect(decode({ response: [{ name: 'X-A', value: 'a\r\nX-Evil: 1' }] }).ok).toBe(false);
      expect(decode({ request: [{ name: 'X-A', value: 'a\nb' }] }).ok).toBe(false);
    });

    it('화이트리스트 밖 변수를 거부한다', () => {
      expect(decode({ request: [{ name: 'X-A', value: '$document_root' }] }).ok).toBe(false);
      expect(decode({ request: [{ name: 'X-A', value: '$' }] }).ok).toBe(false);
    });

    it('**신뢰 사슬 헤더는 못 덮는다** — 조용히 끊기면 나중에 보안 사고다', () => {
      expect(decode({ request: [{ name: 'X-Forwarded-For', value: 'x' }] }).ok).toBe(false);
      expect(decode({ request: [{ name: 'x-forwarded-proto', value: 'x' }] }).ok).toBe(false);
      expect(decode({ request: [{ name: 'Upgrade', value: 'x' }] }).ok).toBe(false);
      expect(decode({ request: [{ name: 'Connection', value: 'x' }] }).ok).toBe(false);
    });

    it('`Host` 는 **연다** — 다른 Host 를 기대하는 백엔드는 정당하다', () => {
      expect(decode({ request: [{ name: 'Host', value: 'backend.internal' }] }).ok).toBe(true);
    });

    it('`Strict-Transport-Security` 는 응답에서 막는다 — 모델에 자기 필드가 있다', () => {
      // 출처가 둘이면 싸우고, HSTS 는 클라이언트 쪽에서 되돌릴 수 없다.
      expect(decode({ response: [{ name: 'Strict-Transport-Security', value: 'max-age=1' }] }).ok).toBe(false);
    });

    it('같은 이름을 두 번 적으면 거부한다 — 어느 쪽이 이기는지 모델이 안 말한다', () => {
      expect(decode({ request: [{ name: 'X-A', value: '1' }, { name: 'x-a', value: '2' }] }).ok).toBe(false);
    });

    it('제대로 된 것은 통과한다', () => {
      const r = decode({
        request: [{ name: 'X-Tenant', value: 'acme' }],
        response: [{ name: 'X-Frame-Options', value: 'DENY' }],
      });
      expect(r.ok, JSON.stringify(r.ok ? [] : r.issues)).toBe(true);
    });
  });
});
