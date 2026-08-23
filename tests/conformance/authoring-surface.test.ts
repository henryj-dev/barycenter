/**
 * **저작 표면이 끝까지 닿는가** (§12.1)
 *
 * §12.1 이 이렇게 적어 뒀다: *"GUI 는 맨 뒤로 미루지 않는다 — 제품 명제가 GUI 이므로."*
 * 그리고 검수가 그 실패를 이렇게 표로 냈다:
 *
 * > 레이트리밋·헤더·프록시 한계값은 **모델·API·렌더러까지만 갔다.**
 * > CLI 전용 플래그 ❌ · GUI 폼 ❌ · 제안 9 를 GUI 가 보여주기 ❌
 * > "쓸 수는 있지만 **이 제품의 방식으로는 못 쓴다.**"
 *
 * ── 왜 이 파일이 있나
 *
 * 그 구멍은 **조각마다 테스트가 있어도 안 잡힌다.** 모델 테스트는 모델을, 렌더 테스트는
 * 렌더를 보는데, 정작 물음은 *"사람이 손에 쥔 것에서 출발해 산출물까지 닿는가"* 다.
 * 중간 한 마디가 빠져도 조각 테스트는 전부 초록이다.
 *
 * 그래서 여기서는 **플래그 문자열에서 출발해 렌더된 conf 까지** 한 번에 태운다.
 * 사람이 치는 것과 같은 값(`10r/s` · `50m` · `req:X-A:1`)으로 시작한다.
 *
 * GUI 는 같은 파서·같은 빌더를 쓰므로(`parseListenerOptions` · `putListenerPatch`)
 * 이 경로가 서면 폼도 선다 — 그 공유가 `ListenerOptions.svelte` 머리말의 요점이다.
 */
import { describe, expect, it } from 'vitest';
import { parseListenerOptions, putPassthroughListenerPatch } from '../../src/web/edit.js';
import { listenerCreatePatch } from '../../src/cli/listener.js';
import { poolCreatePatch } from '../../src/cli/pool.js';
import { render } from '../../src/conf/render.js';
import { reasonLabels, trafficMarkOf } from '../../src/web/pools-view.js';
import type { Model } from '../../src/model/provisional.js';

/** 사람이 실제로 치는 값들. 여기서 단위 해석이 틀리면 아래가 전부 흔들린다. */
const FLAGS = {
  rate: '10r/s',
  burst: '20',
  nodelay: true,
  maxConn: '100',
  maxBody: '50m',
  connectTimeout: '5s',
  readTimeout: '120s',
  sendTimeout: '90s',
  header: ['req:X-Tenant:acme', 'res:X-Served-By:bary'],
  strictPriority: true,
};

function confFromFlags(): { conf: string; http: Record<string, unknown> } {
  const options = parseListenerOptions(FLAGS);
  const patch = listenerCreatePatch({
    name: 'web', protocol: 'http', bind: '0.0.0.0', port: 80, pool: 'app', options,
  })!;
  const body = (patch[0] as { body: { http: Record<string, unknown> } }).body;
  const model = {
    listeners: [{
      key: 'web', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true, http: body.http,
    }],
    httpRoutes: [], passthroughRoutes: [],
    pools: [{ key: 'app', protocolClass: 'http', algorithm: 'round_robin' }],
    backends: [{ key: 'a', pool: 'app', host: '10.0.0.1', port: 80, weight: 1 }],
    certificates: [], tlsPolicies: [], sniBindings: [],
  } as unknown as Model;
  return { conf: render(model).conf, http: body.http };
}

describe('제안 6·7·8 — 플래그에서 산출물까지', () => {
  const { conf } = confFromFlags();

  it('레이트리밋 (제안 #6)', () => {
    expect(conf, 'zone 선언이 없다').toContain('limit_req_zone');
    expect(conf, '적용이 없다').toMatch(/limit_req\s+zone=/);
    expect(conf, 'nodelay 가 안 붙었다').toContain('nodelay');
  });

  it('커넥션 제한 (제안 #6)', () => {
    expect(conf).toContain('limit_conn_zone');
    expect(conf).toMatch(/limit_conn\s+\S+\s+100;/);
  });

  it('헤더 규칙 (제안 #7) — 요청은 location, 응답은 server', () => {
    expect(conf, '요청 헤더가 없다').toContain('X-Tenant');
    expect(conf, '응답 헤더가 없다').toContain('X-Served-By');
  });

  /** **단위 해석이 여기서 드러난다.** `50m` 이 그대로 나가야 하고 `120s` 도 그렇다. */
  it('프록시 한계값 (제안 #8) — 단위가 상하지 않는다', () => {
    expect(conf).toContain('client_max_body_size 50m;');
    expect(conf).toContain('proxy_connect_timeout 5s;');
    expect(conf).toContain('proxy_read_timeout 120s;');
    expect(conf).toContain('proxy_send_timeout 90s;');
  });

  it('strict_priority (S10) 가 모델까지 간다', () => {
    expect(confFromFlags().http['strictPriority']).toBe(true);
  });
});

describe('제안 #9 — 왜 트래픽을 안 받나', () => {
  /**
   * 화면이 읽는 것과 같은 함수다. 이유를 사람 말로 바꾸는 자리가 없으면 GUI 는
   * `unhealthy` 같은 낱말만 보여 주게 되고, 그건 "왜" 에 대한 답이 아니다.
   */
  it('이유마다 사람 말이 있다', () => {
    for (const r of ['unhealthy', 'draining', 'pool_not_routed', 'pool_missing'] as const) {
      const label = reasonLabels([r]);
      expect(label.length, `'${r}' 에 말이 없다`).toBeGreaterThan(0);
    }
  });

  /**
   * **관측 없음과 받는 중이 다르다.** 상태 API 가 아직 안 왔는데 "이유 없음 = 받는 중"
   * 으로 읽으면 못 읽은 것이 초록으로 보인다 — 화면에서 제일 나쁜 종류의 거짓이다.
   */
  it('안 받는 줄만 표식을 낸다 — 관측 없음도 받는 중도 아니다', () => {
    expect(trafficMarkOf(undefined), '관측이 없는데 표식을 냈다').toBeUndefined();
    expect(
      trafficMarkOf({ receivingTraffic: true, reasons: [] }),
      '받는 중인데 표식을 냈다 — 매번 나오는 줄은 안 읽게 된다',
    ).toBeUndefined();
    const mark = trafficMarkOf({ receivingTraffic: false, reasons: ['unhealthy'] });
    expect(mark?.reasons?.[0], '이유가 사람 말로 안 바뀐다').toBeDefined();
    expect(mark?.reasons?.[0]).not.toBe('unhealthy');
  });
});

describe('그 뒤에 연 것들도 손에 쥘 수 있다', () => {
  /** S9 — 패스스루의 두 폴백. GUI 폼과 CLI 가 같은 빌더를 쓴다. */
  it('on_no_sni 가 패치까지 간다 (S9)', () => {
    const [op] = putPassthroughListenerPatch('pt', {
      bind: '0.0.0.0', port: 8443, pool: 'unmatched', noSniPool: 'nosni',
    });
    expect(op!.body.onUnmatchedSni).toEqual({ pool: 'unmatched' });
    expect(op!.body.onNoSni).toEqual({ pool: 'nosni' });
  });

  /** S6 — `least_conn`. */
  it('least_conn 이 CLI 에서 선다 (S6)', () => {
    const patch = poolCreatePatch({
      name: 'app', protocolClass: 'http', algorithm: 'least_conn',
      backend: 'a', host: '10.0.0.1', port: 80,
    })!;
    expect(JSON.stringify(patch)).toContain('least_conn');
  });

  /** §4.3 — 업스트림 TLS. */
  it('upstream_tls 가 CLI 에서 선다 (§4.3)', () => {
    const patch = poolCreatePatch({
      name: 'app', protocolClass: 'http', backend: 'a', host: '10.0.0.1', port: 443,
      upstreamTls: { enabled: true, sni: 'backend.internal' },
    })!;
    expect(JSON.stringify(patch)).toContain('upstreamTls');
    expect(JSON.stringify(patch)).toContain('backend.internal');
  });

  /**
   * **`verify` 는 번들 없이 못 켠다** — 폼이 저장 못 하는 patch 를 안 만든다.
   * 검증기가 막는 것과 **같은 규칙을 여기서도** 건다는 것이 이 검사의 요점이다.
   */
  it('번들 없는 verify 는 빌더가 먼저 막는다', () => {
    expect(() => poolCreatePatch({
      name: 'app', protocolClass: 'http', backend: 'a', host: '10.0.0.1', port: 443,
      upstreamTls: { enabled: true, verify: true },
    })).toThrow(/caBundle/);
  });
});
