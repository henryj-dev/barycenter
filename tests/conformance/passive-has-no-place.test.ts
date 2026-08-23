/**
 * §4.3 의 `passive` — **이 평면에는 그것이 놓일 자리가 없다** (S15.5)
 *
 * §4.3 필드 표에 `passive`(`max_fails`·`fail_timeout_s`)가 적혀 있는데 `Pool` 타입에도
 * 렌더에도 없다. S15 를 재다가 그것이 걸렸다 — §12.0 의 넷째 축이 "재시도·failure
 * penalty 동작" 이라 **잴 대상이 없어서** SKIP 이 됐다.
 *
 * 그래서 넣으려다 멈췄다. 넣으면 안 되는 이유가 렌더 산출물에 그대로 보인다.
 *
 * ── ① 멤버십 평면에서는 셀 대상이 없다
 *
 * `max_fails` 는 nginx 가 **upstream 의 `server` 줄마다** 세는 값이다. 그런데 멤버십
 * 평면이 켜지면 upstream 에 `server` 가 **자리표시 하나뿐**이고(`0.0.0.1:1`), 진짜
 * peer 는 `balancer_by_lua` 가 매 연결마다 dict 에서 골라 꽂는다. 그러면 nginx 의
 * peer 별 실패 카운터는 **자리표시 하나에 대해** 세어진다 — 우리 백엔드 열 개의 실패가
 * 한 통에 섞이고, 그 통이 차면 **전부** 빠진다.
 *
 * ── ② Lua 로 다시 만들면 멤버십의 주인이 둘이 된다
 *
 * `in:` 처럼 `fail:` 카운터를 두면 될 것 같은데, 그러면 "이 백엔드가 풀에 있는가" 를
 * 정하는 곳이 **둘**이 된다 — 능동 프로브(`backend_health` → `projectHealth`)와 수동
 * 카운터. §6.6 이 리듀서를 하나로 둔 이유가 그것이고, 이 저장소가 mTLS 에서도(역할표
 * 하나) 같은 규칙을 지켰다.
 *
 * ── 그래서 무엇을 하나
 *
 * **안 넣는다.** 그리고 그 결정을 여기 계약으로 남긴다. 나중에 누가 §4.3 표를 보고
 * `passive` 를 넣으려 하면, 이 파일이 "먼저 자리표시 문제를 풀어라" 라고 말한다.
 *
 * 정적 경로(멤버십 평면이 꺼진 엔진)에서는 `max_fails` 가 정상 동작한다 — 거기서는
 * `server` 줄이 백엔드마다 하나씩이다. 그 경로만을 위해 모델 필드를 만들면 **정본
 * 배포에서 아무도 안 읽는 필드**가 되고, 그건 이 저장소가 반복해서 잡아 온 부류다.
 */
import { describe, expect, it } from 'vitest';
import { render } from '../../src/conf/render.js';
import type { Model } from '../../src/model/provisional.js';

const ON = { httpLua: true, streamLua: true, streamRealip: false, sslConfCommand: true };
const OFF = { streamRealip: false };

const model: Model = {
  listeners: [{
    key: 'web', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true,
    http: { defaultAction: { pool: 'app' } },
  }],
  httpRoutes: [], passthroughRoutes: [],
  pools: [{ key: 'app', protocolClass: 'http', algorithm: 'round_robin' }],
  backends: [
    { key: 'a', pool: 'app', host: '10.0.0.1', port: 80, weight: 1 },
    { key: 'b', pool: 'app', host: '10.0.0.2', port: 80, weight: 1 },
    { key: 'c', pool: 'app', host: '10.0.0.3', port: 80, weight: 1 },
  ],
  certificates: [], tlsPolicies: [], sniBindings: [],
} as unknown as Model;

/**
 * `upstream pool_app { ... }` 만 떼어 낸다.
 *
 * **중괄호를 센다.** 처음엔 `\n\}` 로 끊었는데 그러면 들여쓴 닫는 괄호를 못 만나
 * 뒤따르는 `server { ... }` 블록까지 삼켰고, `server` 줄이 넷으로 세어졌다 —
 * 백엔드 셋 + 리스너의 `server {` 한 줄이다. 계측기가 틀리면 결과가 결함처럼 보인다.
 */
const upstreamOf = (conf: string): string => {
  const start = conf.indexOf('upstream pool_app {');
  expect(start, 'upstream 블록을 못 찾았다').toBeGreaterThan(-1);
  let depth = 0;
  for (let i = start; i < conf.length; i += 1) {
    if (conf[i] === '{') depth += 1;
    else if (conf[i] === '}') {
      depth -= 1;
      if (depth === 0) return conf.slice(start, i);
    }
  }
  throw new Error('upstream 블록이 안 닫혔다');
};

/** `server <host>:<port>` 줄만. `server {` 블록 머리는 안 센다. */
const serverLines = (body: string): string[] => body.match(/^\s*server\s+[^{\s]+/gm) ?? [];

describe('passive 를 안 넣은 이유 (§4.3 · S15.5)', () => {
  /**
   * **이 검사가 근거 전부다.** 백엔드가 셋인데 `server` 줄은 하나다.
   */
  it('멤버십 평면의 upstream 에는 server 가 자리표시 하나뿐이다', () => {
    const body = upstreamOf(render(model, ON).conf);
    const servers = serverLines(body);
    expect(servers.length, `server 줄: ${JSON.stringify(servers)}`).toBe(1);
    expect(servers[0]).toContain('0.0.0.1:1');
    // 진짜 peer 는 conf 에 없다 — dict 에 산다.
    expect(body).not.toContain('10.0.0.1');
    expect(body).toContain('balancer_by_lua_block');
  });

  /**
   * 정적 경로에서는 다르다 — 백엔드마다 `server` 줄이 있다. `max_fails` 가 뜻을 갖는
   * 것은 **이쪽뿐**이고, 그래서 이 필드를 넣으면 정본 배포에서 안 읽히는 값이 된다.
   */
  it('정적 경로에서는 백엔드마다 server 줄이 있다 — 거기서만 max_fails 가 뜻이 있다', () => {
    const body = upstreamOf(render(model, OFF).conf);
    const servers = serverLines(body);
    expect(servers.length).toBe(3);
    expect(body).toContain('10.0.0.1');
  });

  /** 지금은 어느 경로에도 `max_fails` 를 안 낸다. 이 줄이 이 결정의 현재 상태다. */
  it('아직 어느 경로에도 max_fails·fail_timeout 을 안 낸다', () => {
    expect(render(model, ON).conf).not.toContain('max_fails');
    expect(render(model, OFF).conf).not.toContain('max_fails');
    expect(render(model, ON).conf).not.toContain('fail_timeout');
    expect(render(model, OFF).conf).not.toContain('fail_timeout');
  });

  /**
   * **멤버십의 주인은 하나다.** 풀에 누가 있는지를 정하는 것은 `slot:` 이고, 그것을
   * 채우는 것은 리듀서 하나다(§6.6). `fail:` 같은 두 번째 카운터가 생기면 그 규칙이
   * 깨진다 — 이 검사는 그 카운터가 아직 없다는 것을 지킨다.
   */
  it('밸런서가 쓰는 dict 카운터는 in:·rr: 둘뿐이다 — 두 번째 멤버십 권한이 없다', () => {
    const conf = render(model, ON).conf;
    const counters = new Set((conf.match(/d:(?:get|incr|set)\("(\w+):/g) ?? [])
      .map((m) => /"(\w+):/.exec(m)![1]!));
    // `slot:` 은 카운터가 아니라 **멤버십 자체**다 — 리듀서가 채우는 정본이고, 밸런서는
    // 그것을 읽기만 한다. `in:`·`rr:` 은 고르기 위한 보조값이다. 셋을 다 못 박는 이유는
    // 네 번째가 생기는 순간 "이 백엔드가 풀에 있는가" 의 주인이 둘이 될 수 있어서다.
    expect([...counters].sort(), '모르는 dict 키가 생겼다').toEqual(['in', 'rr', 'slot']);
  });
});
