/**
 * 멤버십 평면 렌더 (DESIGN.md §7.3 · §6.5 · S1)
 *
 * S1 이 HTTP·TCP·UDP 세 서브시스템 전부에서 **reload 없이** 백엔드가 바뀌는 것을 실증했고,
 * 그게 이 설계 전체가 걸려 있던 내기였다. 여기서는 그 경로를 렌더가 실제로 내는지 본다.
 *
 * **capability 로 켜진다.** 없으면 정적 `server` 줄이다 — 그건 열등한 것이 아니라 **다른
 * 계약**이다(백엔드가 바뀔 때마다 세대 전환 + reload). 기본값이 꺼짐이라 기존 산출물은
 * 한 바이트도 안 바뀐다.
 */
import { describe, expect, it } from 'vitest';

import { render } from '../../src/conf/render.js';
import type { Model } from '../../src/model/provisional.js';

const model: Model = {
  listeners: [
    { key: 'web', protocol: 'http', bind: '0.0.0.0', port: 8080, enabled: true,
      http: { defaultAction: { pool: 'p' } } },
    { key: 'raw', protocol: 'tcp', bind: '0.0.0.0', port: 8081, enabled: true, defaultPool: 'q' },
  ],
  httpRoutes: [],
  passthroughRoutes: [],
  pools: [
    { key: 'p', protocolClass: 'http', algorithm: 'round_robin' },
    { key: 'q', protocolClass: 'tcp', algorithm: 'round_robin' },
  ],
  backends: [
    { key: 'p1', pool: 'p', host: '10.2.0.1', port: 11, weight: 1 },
    { key: 'q1', pool: 'q', host: '10.2.0.2', port: 12, weight: 1 },
  ],
};

const ON = { streamRealip: false, httpLua: true, streamLua: true };

describe('멤버십 평면 (§7.3)', () => {
  it('**capability 가 없으면 산출물이 안 바뀐다** — 기본은 정적 server 줄이다', () => {
    const conf = render(model).conf;
    expect(conf).toContain('server 10.2.0.1:11;');
    expect(conf).not.toContain('balancer_by_lua_block');
    expect(conf).not.toContain('lua_shared_dict');
  });

  it('capability 가 있으면 백엔드가 conf 에서 **사라진다** — dict 로 옮겨간다', () => {
    const conf = render(model, ON).conf;
    expect(conf).not.toContain('server 10.2.0.1:11;');
    expect(conf).toContain('balancer_by_lua_block {');
    // 자리표시는 남는다 — nginx 는 upstream 에 server 를 최소 하나 요구한다.
    expect(conf).toContain('server 0.0.0.1:1;');
  });

  it('**평면마다 다른 dict 이름**이다 (E14)', () => {
    // 같은 이름을 양쪽에 선언하면 `already declared for a different use` 로 거부된다.
    const conf = render(model, ON).conf;
    expect(conf).toContain('lua_shared_dict bary_http 1m;');
    expect(conf).toContain('lua_shared_dict bary_stream 1m;');
  });

  it('**자기 epoch 의 슬롯만 본다** (§6.5-1)', () => {
    // 이게 있어야 HUP 뒤에도 옛 워커가 E-old 를 계속 쓴다 (§6.5-5). 활성 epoch 를
    // 보게 하면 새 슬롯이 준비되기 전에 옛 워커가 그리로 넘어간다.
    const conf = render(model, ON).conf;
    expect(conf).toContain('_G.BARY_EPOCH');
    expect(conf).toMatch(/get\("slot:pool_p:" \.\. \(_G\.BARY_EPOCH/);
  });

  it('**슬롯이 없으면 끊는다** — 조용히 옛 peer 로 안 흐른다 (§6.5-3)', () => {
    expect(render(model, ON).conf).toContain('return ngx.exit(ngx.ERROR)');
  });

  it('**epoch 리터럴을 렌더러가 굽지 않는다** — digest 가 모델만의 함수여야 한다', () => {
    // 세대 번호를 render() 인자로 받으면 같은 모델이 세대마다 다른 digest 를 내고,
    // plan 이 렌더러 드리프트를 잡는 근거(`render_digest`)가 사라진다.
    // 리터럴은 세대의 admin 조각에 산다 — 마커와 같은 수법이다 (E62).
    expect(render(model, ON).digest).toBe(render(structuredClone(model), ON).digest);
    expect(render(model, ON).conf).toContain('include stream-admin/*.conf;');
  });

  it('한쪽 평면만 켜도 그쪽만 바뀐다', () => {
    const httpOnly = render(model, { streamRealip: false, httpLua: true }).conf;
    expect(httpOnly).toContain('lua_shared_dict bary_http 1m;');
    expect(httpOnly).not.toContain('lua_shared_dict bary_stream');
    // stream 은 정적 그대로다.
    expect(httpOnly).toContain('server 10.2.0.2:12;');
  });
});
