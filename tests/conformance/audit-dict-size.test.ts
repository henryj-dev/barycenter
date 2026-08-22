/**
 * 검수 2026-08-22 · B-12 — **dict 는 절벽이다. 크기를 정할 수 있어야 한다**
 *
 * `lua_shared_dict` 크기가 하드코딩(`1m` · `64k`)이었다. 이 dict 에는 epoch 별 슬롯,
 * 라운드로빈 카운터, 그리고 **peer 별 in-flight 카운터**가 함께 산다.
 *
 * 차면 nginx 는 **LRU 로 밀어낸다.** 밀려난 것이 `slot:` 이면 `balancer_by_lua` 가
 * `ngx.exit(ngx.ERROR)` 를 타고 **그 풀의 모든 요청이 끊긴다.** 성능 손잡이가 아니라
 * 절벽이고, 백엔드가 늘면 언젠가 닿는데 그때 할 수 있는 것이 없었다.
 *
 * `in:` 카운터는 지우는 코드가 없어 **한번 본 peer 가 영원히 자리를 차지했다.** 그렇다고
 * 0 이 될 때 지우면 안 된다 — `/membership/inflight` 가 키 없음을 `{}` 로 답하고 드레인이
 * 그것을 "관측 없음" 으로 읽어 **`quiesced` 판정이 영영 안 난다.** 만료로 푼다.
 */
import { describe, expect, it } from 'vitest';

import { render } from '../../src/conf/render.js';
import type { Model } from '../../src/model/provisional.js';

const CAPS = { streamRealip: true, httpLua: true, streamLua: true };

const model = (engine?: Model['engine']): Model => ({
  ...(engine === undefined ? {} : { engine }),
  listeners: [{
    key: 'l4', protocol: 'tcp', bind: '0.0.0.0', port: 9000, enabled: true, defaultPool: 'l4',
  }],
  httpRoutes: [], passthroughRoutes: [],
  pools: [{ key: 'l4', protocolClass: 'tcp', algorithm: 'round_robin' }],
  backends: [{ key: 'b', pool: 'l4', host: '10.0.0.1', port: 9000, weight: 1 }],
  certificates: [], tlsPolicies: [], sniBindings: [],
});

describe('shared dict 크기와 수명 (검수 B-12)', () => {
  it('dict 크기를 정할 수 있다', () => {
    const conf = render(model({ membershipDictKb: 8192, acmeDictKb: 512 }), CAPS).conf;
    expect(conf).toContain('lua_shared_dict bary_http 8m;');
    expect(conf).toContain('lua_shared_dict bary_stream 8m;');
    expect(conf).toContain('lua_shared_dict bary_acme 512k;');
  });

  it('안 정하면 지금까지의 값 그대로다', () => {
    // 기본값을 바꾸면 조용한 동작 변경이 된다. 열기만 하고 기본은 그대로 둔다.
    const conf = render(model(), CAPS).conf;
    // **바이트가 그대로여야 한다.** 달라지면 render_digest 가 바뀌고, 설정을 하나도
    // 안 바꾼 배포가 다음 apply 에서 세대 전환을 한다.
    expect(conf).toContain('lua_shared_dict bary_http 1m;');
    expect(conf).toContain('lua_shared_dict bary_acme 64k;');
  });

  it('놀고 있는 in-flight 카운터는 만료된다 — 지우지는 않는다', () => {
    const conf = render(model(), CAPS).conf;
    // 0 으로 고정하면서 TTL 을 건다. 지우면 드레인이 quiesced 를 못 읽는다.
    expect(conf).toMatch(/d:set\("in:" \.\. peer, 0, 3600\)/);
    expect(conf).not.toMatch(/d:delete\("in:"/);
    // 두 평면 다 같은 규칙이어야 한다 — 한쪽만 고치면 stream 쪽이 계속 자란다.
    expect(conf.match(/d:set\("in:" \.\. peer, 0, 3600\)/g)).toHaveLength(2);
  });

  it('크기는 사용자 문자열이 아니다 — 정수만 지난다', () => {
    // nginx 크기 표기를 문자열로 받으면 그것이 곧 디렉티브로 가는 자유 문자열이 된다
    // (검수 S-11 과 같은 부류). KB 정수만 받고 접미사는 렌더러가 붙인다.
    const conf = render(model({ membershipDictKb: 64 }), CAPS).conf;
    expect(conf).toContain('lua_shared_dict bary_http 64k;');
    // 1024 의 배수는 `m` 으로 — 기본값의 바이트를 보존하기 위해서다.
    expect(render(model({ membershipDictKb: 2048 }), CAPS).conf)
      .toContain('lua_shared_dict bary_http 2m;');
  });
});
