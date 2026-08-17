/**
 * 렌더 출력의 **모양**을 고정한다 — admin include 와 http 블록의 존재.
 *
 * 이 파일이 생긴 경위를 적어 둔다. `render()` 에 `include admin/*.conf;` 를 넣고 http
 * 블록을 **항상** 내도록 바꿨는데, **단위 217 · conformance 381 · 골든 10 이 전부 그대로
 * 통과했다.** 출력이 실제로 바뀌었는지 손으로 찍어 보고서야 알았다.
 *
 * 즉 그때까지 **렌더 출력의 모양을 붙잡는 테스트가 없었다.** 골든은 `nginx -t` 만 보고
 * (문법이 맞으면 통과), 단위는 부분 문자열만 본다. 그 사이로 "http 블록이 통째로
 * 사라졌다" 같은 변경도 지나간다.
 *
 * 전체 스냅샷을 박지는 않는다 — 무관한 변경마다 깨져서 갱신이 습관이 되면 그건 계측이
 * 아니다. 대신 **의미가 걸린 구조**만 못 박는다.
 */
import { describe, expect, it } from 'vitest';

import { render } from '../../src/conf/render.js';
import type { Model } from '../../src/model/provisional.js';

const streamOnly: Model = {
  listeners: [
    { key: 'l', protocol: 'tcp', bind: '0.0.0.0', port: 998, enabled: true, defaultPool: 'p' },
  ],
  httpRoutes: [],
  passthroughRoutes: [], certificates: [], tlsPolicies: [], sniBindings: [],
  pools: [{ key: 'p', protocolClass: 'tcp', algorithm: 'round_robin' }],
  backends: [{ key: 'b', pool: 'p', host: '10.0.0.1', port: 11, weight: 1 }],
};

const httpOnly: Model = {
  listeners: [
    {
      key: 'front', protocol: 'http', bind: '0.0.0.0', port: 999, enabled: true,
      http: { defaultAction: { pool: 'app' } },
    },
  ],
  httpRoutes: [],
  passthroughRoutes: [], certificates: [], tlsPolicies: [], sniBindings: [],
  pools: [{ key: 'app', protocolClass: 'http', algorithm: 'round_robin' }],
  backends: [{ key: 'a', pool: 'app', host: '10.0.0.1', port: 11, weight: 1 }],
};

const empty: Model = {
  listeners: [], httpRoutes: [], passthroughRoutes: [], certificates: [], tlsPolicies: [], sniBindings: [], pools: [], backends: [],
};

describe('세대에 결박된 admin include (§6.3 · §7.2)', () => {
  it('**http 블록은 언제나 있다** — 모델에 http 리스너가 없어도', () => {
    // 없으면 마커를 서빙할 자리가 없고, 활성화를 증명하지 못하면 apply 가 좌표를
    // 못 옮긴다. v0.1 의 명시적 선택이다: 데이터 플레인은 언제나 admin http 를 띄운다.
    expect(render(streamOnly).conf).toMatch(/^http \{$/m);
    expect(render(empty).conf).toMatch(/^http \{$/m);
    expect(render(httpOnly).conf).toMatch(/^http \{$/m);
  });

  it('include 는 **상대경로**다 — 절대경로면 세대 결박이 깨진다', () => {
    // E62 로 실측: `include` 는 conf_prefix 기준이다. 절대경로를 구우면 `current` 링크를
    // 지나든 `generations/N` 을 직접 검증하든 **같은 파일**을 읽어 세대가 안 갈린다.
    for (const m of [empty, streamOnly, httpOnly]) {
      expect(render(m).conf).toContain('include admin/*.conf;');
      expect(render(m).conf).not.toMatch(/include\s+\//);
    }
  });

  it('include 가 http 블록의 **첫 자식**이다', () => {
    const lines = render(httpOnly).conf.split('\n');
    const at = lines.findIndex((l) => l === 'http {');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(lines[at + 1]?.trim()).toBe('include admin/*.conf;');
  });

  it('stream 블록에는 include 를 안 넣는다 — 마커는 HTTP 로 읽는다', () => {
    const conf = render(streamOnly).conf;
    const streamAt = conf.indexOf('stream {');
    expect(streamAt).toBeGreaterThan(0);
    expect(conf.slice(streamAt)).not.toContain('include');
  });

  it('**`planes` 는 그대로 모델에서 나온다** — admin 블록이 평면을 만들지 않는다', () => {
    // 여기가 미묘하다. http 블록을 항상 내지만 `planes` 가 따라 늘면, stream 전용 배포에서
    // apply 가 http 좌표까지 옮기려 들고 게시 전 검사가 plane_mismatch 로 막는다.
    // admin 블록은 좌표도 멤버십도 안 든다 — 세대마다 마커 리터럴만 다르다.
    expect(render(streamOnly).planes).toEqual(['stream']);
    expect(render(httpOnly).planes).toEqual(['http']);
    expect(render(empty).planes).toEqual([]);
  });

  it('digest 는 여전히 **모델만의 함수**다', () => {
    // 세대 번호를 `render()` 인자로 받았다면 같은 모델이 세대마다 다른 digest 를 내고,
    // plan 이 렌더러 드리프트를 잡는 근거(`render_digest`)가 사라진다.
    expect(render(httpOnly).digest).toBe(render(structuredClone(httpOnly)).digest);
    expect(render(httpOnly).digest).not.toBe(render(streamOnly).digest);
  });
});
