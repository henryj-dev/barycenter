/**
 * S6 — **`least_conn` 배제 근거가 더 이상 사실이 아니다** (2026-08-23).
 *
 * 모델 주석이 이렇게 적어 뒀다:
 *
 * > `least_conn` 은 v0 에 없다. stream/http OSS 에 네이티브로 있지만, S1 이 통과해 Lua
 * > 밸런서 경로가 확정된 이상 **그 경로에서는 워커별 근사가 된다.** 정확한 것처럼
 * > 보이는 이름으로 근사를 파느니 빼는 편이 낫다.
 *
 * 그때는 맞았다. 그런데 **그 뒤에 `in:` 카운터가 생겼다** — 드레인 관측(S2)이 넣은
 * peer 별 inflight 다. 그리고 그것은 `lua_shared_dict` 에 산다.
 *
 * ── dict 는 워커 간 공유다
 *
 * 이 저장소가 이미 두 번 그 사실에 기대고 있다:
 *
 *   · `round_robin` 의 `rr:` 카운터 — 렌더러 주석이 *"dict 카운터 — **워커 간 공유**다.
 *     워커 로컬로 두면 워커 수만큼 편향된다"* 라고 적는다.
 *   · 멤버십 `slot:` — admin 이 한 번 쓰면 모든 워커가 읽는다 (S1·S5 가 수렴을 실측).
 *
 * `in:` 도 같은 dict 다. **그러니 `least_conn` 은 워커별 근사가 아니다** — 전 워커의
 * inflight 합을 보고 고른다.
 *
 * ⚠️ **남는 오차는 다른 종류다.** 읽고 고르는 사이가 원자적이지 않아 두 워커가 같은
 * peer 를 동시에 고를 수 있다. 그건 nginx 네이티브 `least_conn` 도 마찬가지이고(공유
 * zone 에 락을 걸지만 선택 자체는 순간의 값을 본다), **워커 수만큼 편향되는 것**과는
 * 크기가 다르다. 그 차이가 이 회차에 되살리는 근거다.
 */
import { describe, expect, it } from 'vitest';

import { render } from '../../src/conf/render.js';
import { decodeModel } from '../../src/model/decode.js';
import type { Model } from '../../src/model/provisional.js';

const ON = { streamRealip: false, httpLua: true, streamLua: true };

const model = (algorithm: string, protocolClass = 'http'): Model => ({
  listeners: [protocolClass === 'http'
    ? { key: 'web', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true,
      http: { defaultAction: { pool: 'app' } } }
    : { key: 'edge', protocol: 'tcp', bind: '0.0.0.0', port: 998, enabled: true, defaultPool: 'app' },
  ] as Model['listeners'],
  httpRoutes: [], passthroughRoutes: [],
  pools: [{ key: 'app', protocolClass, algorithm } as Model['pools'][number]],
  backends: [
    { key: 'a', pool: 'app', host: '10.0.0.1', port: 80, weight: 1 },
    { key: 'b', pool: 'app', host: '10.0.0.2', port: 80, weight: 1 },
  ],
  certificates: [], tlsPolicies: [], sniBindings: [],
});

describe('least_conn (S6)', () => {
  it('모델이 받는다', () => {
    const r = decodeModel(model('least_conn'));
    expect(r.ok, JSON.stringify(r.ok ? [] : r.issues)).toBe(true);
  });

  it('**`in:` 을 읽어 고른다** — 그 값이 워커 간 공유라는 것이 이 알고리즘의 전제다', () => {
    const conf = render(model('least_conn'), ON).conf;
    expect(conf).toContain('in:');
    // 목록을 훑어 최소를 고른다. 해시가 아니다.
    expect(conf).not.toContain('crc32');
  });

  it('**동점은 라운드로빈으로 가른다** — 안 그러면 밸런싱이 아예 안 된다', () => {
    /**
     * 골든이 잡은 것이다. 순차 요청에서는 inflight 가 매번 0 으로 돌아와 셋이 늘
     * 동점이고, "먼저 나온 것" 규칙이면 **첫 번째만 계속 고른다** — 실측으로
     * A 60 · B 0 · C 0 이었다.
     *
     * nginx 네이티브도 같은 문제를 같은 방법으로 푼다. `rr:` 카운터를 그대로 쓴다.
     */
    const conf = render(model('least_conn'), ON).conf;
    expect(conf).toContain('tied');
    expect(conf).toContain('rr:');
  });

  it('같은 dict 를 쓴다 — `in:` 을 올리는 자리와 읽는 자리가 갈리면 안 된다', () => {
    const conf = render(model('least_conn'), ON).conf;
    // 고르는 쪽과 올리는 쪽이 같은 `d` 를 본다.
    const block = conf.slice(conf.indexOf('balancer_by_lua_block'));
    expect(block).toContain('d:get("in:"');
    expect(block).toContain('d:incr("in:"');
  });

  it('**stream 평면에서도 선다** — nginx 네이티브도 양쪽에 있다', () => {
    const conf = render(model('least_conn', 'tcp'), ON).conf;
    expect(conf).toContain('in:');
  });

  it('관측이 없는 peer 는 0 으로 본다 — 새로 들어온 백엔드가 먼저 받는다', () => {
    /**
     * `in:` 키가 없으면 `d:get` 이 nil 이다. 그것을 0 으로 읽어야 갓 붙은 peer 가
     * 트래픽을 받기 시작한다 — nil 을 큰 값으로 치면 **새 백엔드가 영영 안 받는다.**
     */
    const conf = render(model('least_conn'), ON).conf;
    expect(conf).toMatch(/d:get\("in:"[^\n]*\)\s+or\s+0/);
  });

  it('다른 알고리즘은 안 바뀐다', () => {
    expect(render(model('round_robin'), ON).conf).toContain('rr:');
    expect(render(model('source_ip_hash'), ON).conf).toContain('crc32');
  });

  it('**정적 경로(멤버십 평면 없음)에서는 nginx 네이티브를 쓴다**', () => {
    /**
     * Lua 가 없는 엔진에서는 `least_conn;` 디렉티브가 있다 — 우리가 근사할 이유가 없다.
     * 그 경로에서 아무것도 안 내면 조용히 round_robin 이 되고, 그게 "필드는 있는데
     * 아무도 안 지킨다" 의 한 판이다.
     */
    const off = { streamRealip: false, httpLua: false, streamLua: false };
    expect(render(model('least_conn'), off).conf).toContain('least_conn;');
  });
});
