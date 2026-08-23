/**
 * §4.3 의 `sticky` — **이미 있는 것에 두 번째 이름을 안 붙인다**
 *
 * 표가 이렇게 적어 두었다: *"`sticky` | object? | HTTP: 쿠키 / L4: `source_ip_hash`"*
 * 그리고 제약 표에 *"`sticky.kind=cookie` → `protocol_class=http`"*.
 *
 * 넣으려다 멈췄다. 둘 다 **이미 표현된다**:
 *
 *   L4    `algorithm: 'source_ip_hash'` — 표가 말하는 그것이다
 *   HTTP  `algorithm: 'hash'` + `hashKey: 'cookie(sid)'` → `$cookie_sid` 로 고른다
 *
 * ── 그러면 `sticky` 는 무엇이 되는가
 *
 * 둘 중 하나다. **둘 다 이 저장소가 거부하는 모양이다.**
 *
 *   ① 같은 것의 **두 번째 이름** — "이 풀이 어떻게 고르는가" 의 진실이 둘이 된다.
 *      `algorithm` 과 `sticky` 가 어긋나면 어느 쪽이 이기나? 그 물음이 생기는 순간
 *      진 것이다.
 *   ② **쿠키를 발급하겠다는 약속** — nginx OSS 는 못 한다. `sticky cookie` 는 상용
 *      모듈이고, OSS 가 할 수 있는 것은 **앱이 이미 심어 둔** 쿠키로 고르는 것뿐이다.
 *      약속을 모델에 두면 "설정했는데 안 걸린다" 가 된다.
 *
 * ── 그래서 무엇을 하나
 *
 * **안 넣는다.** 그리고 그 판단이 사실 위에 서 있다는 것을 여기서 지킨다 — 아래 검사가
 * 빨개지면 "이미 있다" 가 거짓이 된 것이고, 그때는 결정을 다시 해야 한다.
 */
import { describe, expect, it } from 'vitest';
import { render } from '../../src/conf/render.js';
import { parseHashKey } from '../../src/validate/strings.js';
import type { Model } from '../../src/model/provisional.js';

const ON = { httpLua: true, streamLua: true, streamRealip: false, sslConfCommand: true };
const OFF = { streamRealip: false };

const model = (pool: Record<string, unknown>): Model => ({
  listeners: [{
    key: 'web', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true,
    http: { defaultAction: { pool: 'app' } },
  }],
  httpRoutes: [], passthroughRoutes: [],
  pools: [{ key: 'app', protocolClass: 'http', ...pool }],
  backends: [
    { key: 'a', pool: 'app', host: '10.0.0.1', port: 80, weight: 1 },
    { key: 'b', pool: 'app', host: '10.0.0.2', port: 80, weight: 1 },
  ],
  certificates: [], tlsPolicies: [], sniBindings: [],
} as unknown as Model);

describe('HTTP 쿠키 친화는 이미 표현된다', () => {
  it('`cookie(name)` 이 해시 키 화이트리스트에 있다', () => {
    const r = parseHashKey('http', 'cookie(sid)');
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.ok && r.value.variable).toBe('cookie_sid');
  });

  it('정적 경로가 `hash $cookie_sid consistent` 를 낸다', () => {
    const conf = render(model({ algorithm: 'hash', hashKey: 'cookie(sid)' }), OFF).conf;
    expect(conf).toContain('hash $cookie_sid consistent;');
  });

  it('멤버십 평면도 같은 변수로 고른다', () => {
    const conf = render(model({ algorithm: 'hash', hashKey: 'cookie(sid)' }), ON).conf;
    expect(conf).toContain('ngx.var.cookie_sid');
  });

  it('L4 친화는 `source_ip_hash` 그 자체다', () => {
    const conf = render(model({ algorithm: 'source_ip_hash' }), OFF).conf;
    expect(conf).toMatch(/ip_hash;|hash \$remote_addr consistent;/);
  });
});

describe('쿠키를 발급하지는 않는다 — 그건 상용 모듈이다', () => {
  /**
   * **이 검사가 결정의 나머지 절반이다.** `sticky` 를 넣으면 사용자는 이 제품이 친화
   * 쿠키를 심어 준다고 기대하는데, OSS 로는 못 한다. 산출물에 그런 지시어가 없다는
   * 것이 그 사실이다.
   */
  it('산출물에 `sticky` 지시어가 없다 — 낼 수 있는 척하지 않는다', () => {
    for (const caps of [OFF, ON]) {
      const conf = render(model({ algorithm: 'hash', hashKey: 'cookie(sid)' }), caps).conf;
      expect(conf, '상용 모듈 지시어가 산출물에 있다').not.toMatch(/^\s*sticky\b/m);
    }
  });

  /**
   * 모델도 그 이름을 안 받는다. 받아 놓고 안 쓰면 이 저장소가 반복해서 잡아 온
   * *"필드는 있는데 아무도 안 읽는다"* 가 된다.
   */
  it('모델이 `sticky` 를 안 받는다', async () => {
    const { decodeModel } = await import('../../src/model/decode.js');
    const out = decodeModel({
      listeners: [], httpRoutes: [], passthroughRoutes: [],
      pools: [{ key: 'app', protocolClass: 'http', algorithm: 'round_robin', sticky: { kind: 'cookie', name: 'sid' } }],
      backends: [], certificates: [], tlsPolicies: [], sniBindings: [],
    });
    expect(out.ok, '모델이 sticky 를 받아 놓고 아무도 안 읽는다').toBe(false);
  });
});
