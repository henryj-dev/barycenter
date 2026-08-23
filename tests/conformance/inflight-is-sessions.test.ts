/**
 * S2 의 남은 것 — **inflight 와 세션이 한 카운터다** (§4.4, §12.0)
 *
 * §12.0 이 S2 를 이렇게 닫아 두었다:
 *
 * > 남은 것: inflight 와 세션이 **한 카운터**라 둘로 안 갈린다
 *
 * 오래 그것을 "못 가른다" 로 읽었다. 실제로는 **가를 것이 없다** — 우리 렌더에서 두
 * 수는 같은 수다. 그리고 그건 우연이 아니라 렌더의 성질에서 따라 나온다:
 *
 *   stream 평면 — `balancer_by_lua_block` 도 `log_by_lua_block` 도 **연결당 한 번**
 *                 돈다. 연결 = 세션 = inflight 하나. 정의상 같다.
 *
 *   http 평면   — 둘 다 **요청당 한 번** 돈다. 요청과 업스트림 연결이 갈리려면
 *                 upstream 에 `keepalive` 가 있어야 하는데, **우리는 안 낸다.**
 *                 keepalive 가 없으면 요청 하나가 업스트림 연결 하나다.
 *
 * ── 이 파일이 지키는 것
 *
 * 등식이 성립하는 **조건**이다. 나중에 누가 `keepalive` 를 upstream 에 넣으면 http 에서
 * 요청과 연결이 갈리고, 그 순간 `quiesced = inflight 0 && active_sessions 0` (§4.4)
 * 은 한 카운터로 판정할 수 없게 된다 — 유휴 keepalive 연결이 inflight 0 인 채로 남기
 * 때문이다. 그때 필요한 것은 이 테스트를 지우는 게 아니라 **세션 카운터를 따로 두는
 * 것**이고, 이 테스트가 그 자리에서 그걸 말해 준다.
 *
 * 그래서 여기서 재는 것은 성능이나 동작이 아니라 **가정** 이다.
 */
import { describe, expect, it } from 'vitest';
import { render } from '../../src/conf/render.js';
import type { Model } from '../../src/model/provisional.js';

/** 멤버십 평면이 켜진 엔진 — `in:` 카운터가 사는 경로다. */
const ON = { httpLua: true, streamLua: true, streamRealip: false, sslConfCommand: true };

const model: Model = {
  listeners: [
    {
      key: 'web', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true,
      http: { defaultAction: { pool: 'app' } },
    },
    { key: 'raw', protocol: 'tcp', bind: '0.0.0.0', port: 9000, enabled: true, defaultPool: 'tcpapp' },
  ],
  httpRoutes: [], passthroughRoutes: [],
  pools: [
    { key: 'app', protocolClass: 'http', algorithm: 'round_robin' },
    { key: 'tcpapp', protocolClass: 'tcp', algorithm: 'round_robin' },
  ],
  backends: [
    { key: 'a', pool: 'app', host: '10.0.0.1', port: 8080, weight: 1 },
    { key: 't', pool: 'tcpapp', host: '10.0.0.2', port: 9090, weight: 1 },
  ],
  certificates: [], tlsPolicies: [], sniBindings: [],
} as unknown as Model;

describe('S2 — inflight 와 세션이 같은 수인 조건', () => {
  /**
   * **이 파일에서 제일 중요한 검사.** `keepalive` 가 들어오면 http 에서 요청과 업스트림
   * 연결이 갈리고, 한 카운터로 §4.4 의 `quiesced` 를 판정할 수 없게 된다.
   *
   * 이게 빨개졌다면 고칠 것은 이 테스트가 아니라 드레인 판정이다.
   */
  it('upstream 에 keepalive 를 안 낸다 — 이것이 등식의 전제다', () => {
    const { conf } = render(model, ON);
    expect(conf).not.toMatch(/^\s*keepalive\s+\d/m);
    expect(conf).not.toMatch(/keepalive_requests/);
  });

  it('`in:` 을 올리는 자리와 내리는 자리가 짝이다', () => {
    const { conf } = render(model, ON);
    const up = (conf.match(/d:incr\("in:" \.\. peer, 1, 0\)/g) ?? []).length;
    const down = (conf.match(/d:incr\("in:" \.\. peer, -1\)/g) ?? []).length;
    // 두 평면 각각 한 쌍이다. 짝이 안 맞으면 카운터가 새거나 음수로 흐른다.
    expect(up).toBe(down);
    expect(up).toBeGreaterThan(0);
  });

  /**
   * http 는 `balancer_by_lua_block`(요청 시작)과 `log_by_lua_block`(요청 끝)이 짝이다.
   * 둘 사이가 곧 "요청 하나" 이고, keepalive 가 없으니 그게 곧 "업스트림 연결 하나" 다.
   */
  it('http 는 요청 하나가 업스트림 연결 하나다 — 올림이 밸런서, 내림이 로그다', () => {
    const { conf } = render(model, ON);
    const http = conf.slice(conf.indexOf('http {'), conf.indexOf('stream {'));
    expect(http).toContain('balancer_by_lua_block');
    expect(http).toContain('log_by_lua_block');
    expect(http.indexOf('d:incr("in:" .. peer, 1, 0)')).toBeGreaterThan(-1);
    expect(http.indexOf('d:incr("in:" .. peer, -1)')).toBeGreaterThan(-1);
  });

  /** stream 은 연결당 한 번이라 세션과 inflight 가 **정의상** 같다. */
  it('stream 은 연결 하나가 세션 하나다', () => {
    const { conf } = render(model, ON);
    const stream = conf.slice(conf.indexOf('stream {'));
    expect(stream).toContain('balancer_by_lua_block');
    expect(stream).toContain('log_by_lua_block');
    expect(stream).toContain('d:incr("in:" .. peer, -1)');
  });

  /**
   * 0 이하가 되면 0 으로 고정하되 **지우지는 않는다** (검수 B-12). 키가 사라지면
   * 드레인이 "관측 없음" 으로 읽어 `quiesced` 를 영영 못 판정한다 — 그건 한 카운터냐
   * 두 카운터냐와 무관하게 이 등식을 쓸모 있게 만드는 조건이다.
   */
  it('0 을 지우지 않고 만료를 건다 — 관측 없음과 0 은 다른 말이다', () => {
    const { conf } = render(model, ON);
    expect(conf).toMatch(/d:set\("in:" \.\. peer, 0, \d+\)/);
    expect(conf).not.toMatch(/d:delete\("in:"/);
  });
});
