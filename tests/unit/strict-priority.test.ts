/**
 * S10 — **`strict_priority`** (§7.5-4 · §12.0)
 *
 * 기본에서 사용자 `priority` 는 **같은 매치 클래스 안에서만** 뜻이 있다. nginx 가
 * 정확일치 → 와일드카드 → 정규식 순으로 보기 때문이다(E20.1). `a.example.com`
 * (priority 10)과 `*.example.com`(priority 20)을 주면 사용자는 뒤가 이기길 바라는데
 * 앞이 이긴다 — §7.5-3 이 그 역전을 경고로 낸다.
 *
 * 켜면 **겨루는 것들을 전부 앵커 정규식으로 내린다.** 정규식끼리는 등장 순서를 따르므로
 * (E20.3) 우리가 순서를 정할 수 있다.
 *
 * ── 이 파일이 지키는 것 셋
 *
 *   ① **연결 요소 통째로** 내린다. 하나라도 앞 클래스로 남으면 그것이 무조건 먼저다 —
 *      한 쌍만 내리면 조용히 틀린다.
 *   ② **역전이 없으면 안 내린다.** 정규식은 순차 평가라 공짜가 아니다 (§7.4).
 *   ③ 내린 정확일치는 **이스케이프**한다. `a.b` 를 그대로 정규식에 넣으면 `axb` 에도
 *      걸린다.
 */
import { describe, expect, it } from 'vitest';
import { render } from '../../src/conf/render.js';
import { patternsConflict, planStrictPriority } from '../../src/route/compile.js';
import { validateModel } from '../../src/validate/model.js';
import { parseHostPattern } from '../../src/validate/strings.js';
import type { Model } from '../../src/model/provisional.js';

const pat = (h: string) => {
  const p = parseHostPattern(h);
  if (!p.ok) throw new Error(`못 읽는다: ${h}`);
  return p.value;
};

const host = (h: string, priority: number) => ({ key: h, pattern: pat(h), priority });

describe('충돌 판정', () => {
  it('와일드카드는 한 라벨만 삼킨다 — 우리 앵커 정규식과 같은 판정이다', () => {
    expect(patternsConflict(pat('a.example.com'), pat('*.example.com'))).toBe(true);
    // nginx 자체는 다중 라벨을 삼키지만(E22.2) 우리는 `~^[^.]+\.suffix$` 로 좁혀 뒀다.
    expect(patternsConflict(pat('y.x.example.com'), pat('*.example.com'))).toBe(false);
  });

  it('같은 것끼리는 같을 때만 겹친다', () => {
    expect(patternsConflict(pat('a.test'), pat('a.test'))).toBe(true);
    expect(patternsConflict(pat('a.test'), pat('b.test'))).toBe(false);
    expect(patternsConflict(pat('*.a.test'), pat('*.a.test'))).toBe(true);
    expect(patternsConflict(pat('*.a.test'), pat('*.b.test'))).toBe(false);
  });

  it('겹치지 않는 도메인은 안 겹친다', () => {
    expect(patternsConflict(pat('a.example.com'), pat('*.other.com'))).toBe(false);
  });
});

describe('강등 계획', () => {
  it('역전이 있으면 연결 요소 전체를 내린다', () => {
    const plan = planStrictPriority([
      host('a.example.com', 10),   // exact, 낮은 priority
      host('*.example.com', 20),   // wildcard, 높은 priority — 사용자는 이게 이기길 바란다
    ]);
    expect(plan.lowered.size).toBe(2);
    // 높은 priority 가 먼저 나와야 한다.
    expect(plan.order[0]).toBe('*example.com');
  });

  /**
   * **①의 검사.** `b.example.com` 은 역전에 직접 끼지 않지만 같은 요소에 있다 —
   * 안 내리면 정확일치로 남아 두 정규식보다 먼저 평가된다.
   */
  it('역전에 직접 안 낀 이웃도 같은 요소면 내린다', () => {
    const plan = planStrictPriority([
      host('a.example.com', 10),
      host('*.example.com', 20),
      host('b.example.com', 5),
    ]);
    expect(plan.lowered.size, `내려간 것: ${[...plan.lowered]}`).toBe(3);
    expect(plan.lowered.has('=b.example.com')).toBe(true);
  });

  /** **②의 검사.** 역전이 없으면 내려 봐야 순서가 같다. */
  it('역전이 없으면 아무것도 안 내린다', () => {
    const plan = planStrictPriority([
      host('a.example.com', 20),   // exact 가 이미 더 높다 — 엔진 순서와 같다
      host('*.example.com', 10),
    ]);
    expect(plan.lowered.size).toBe(0);
    expect(plan.order).toEqual([]);
  });

  it('안 겹치는 요소는 서로에게 영향을 안 준다', () => {
    const plan = planStrictPriority([
      host('a.example.com', 10),
      host('*.example.com', 20),   // 여기만 역전
      host('c.other.com', 1),
      host('*.other.com', 0),      // 역전 없음
    ]);
    expect(plan.lowered.has('=c.other.com')).toBe(false);
    expect(plan.lowered.has('*other.com')).toBe(false);
    expect(plan.lowered.size).toBe(2);
  });

  it('동점은 키로 갈라 결정적이다 — 두 번 돌려도 같은 순서다', () => {
    const hosts = [host('a.example.com', 10), host('*.example.com', 10),
      host('b.example.com', 20)];
    expect(planStrictPriority(hosts).order).toEqual(planStrictPriority(hosts).order);
  });
});

// ── 렌더 ────────────────────────────────────────────────────────────────

const model = (strictPriority: boolean): Model => ({
  listeners: [{
    key: 'web', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true,
    http: { defaultAction: { pool: 'app' }, ...(strictPriority ? { strictPriority } : {}) },
  }],
  httpRoutes: [
    { key: 'r-exact', listener: 'web', hosts: ['a.example.com'], priority: 10, action: { kind: 'proxy', pool: 'app', websocket: false } },
    { key: 'r-wild', listener: 'web', hosts: ['*.example.com'], priority: 20, action: { kind: 'proxy', pool: 'app', websocket: false } },
  ],
  passthroughRoutes: [],
  pools: [{ key: 'app', protocolClass: 'http', algorithm: 'round_robin' }],
  backends: [{ key: 'a', pool: 'app', host: '10.0.0.1', port: 80, weight: 1 }],
  certificates: [], tlsPolicies: [], sniBindings: [],
} as unknown as Model);

const serverNames = (conf: string): string[] =>
  [...conf.matchAll(/server_name\s+(\S+);/g)].map((m) => m[1]!);

describe('렌더', () => {
  it('기본에서는 정확일치가 리터럴이다', () => {
    const names = serverNames(render(model(false)).conf);
    expect(names).toContain('a.example.com');
    expect(names.some((n) => n.startsWith('~^a\\.example'))).toBe(false);
  });

  it('켜면 정확일치도 앵커 정규식이 된다', () => {
    const names = serverNames(render(model(true)).conf);
    expect(names.some((n) => n.startsWith('~^a\\.example')), names.join(' ')).toBe(true);
    expect(names).not.toContain('a.example.com');
  });

  /** **③의 검사.** `.` 을 안 이스케이프하면 `axexample.com` 에도 걸린다. */
  it('내린 정확일치의 점을 이스케이프한다', () => {
    const names = serverNames(render(model(true)).conf);
    const lowered = names.find((n) => n.includes('a\\.example'))!;
    expect(lowered).toBe('~^a\\.example\\.com$');
  });

  /**
   * **등장 순서가 곧 우선순위다** (E20.3). 높은 priority 를 준 와일드카드가 conf 에서
   * 먼저 나와야 한다 — 그것이 이 모드 전체의 목적이다.
   */
  it('높은 priority 가 conf 에서 먼저 나온다', () => {
    const conf = render(model(true)).conf;
    const wild = conf.indexOf('~^[^.]+\\.example\\.com$');
    const exact = conf.indexOf('~^a\\.example\\.com$');
    expect(wild).toBeGreaterThan(-1);
    expect(exact).toBeGreaterThan(-1);
    expect(wild, 'priority 20 인 와일드카드가 뒤에 나왔다').toBeLessThan(exact);
  });

  /**
   * **S10 은 자기 기준을 못 넘었다.** §12.0 이 "라우트 500개 p99 영향 < 5%" 를
   * 요구했는데 실측은 강등 50개 +3.4%, 250개 +9.8% 다 — 선형이고, 500 라우트에서는
   * 기준의 두 배다.
   *
   * §12.0 의 실패 규칙은 "모드 미제공" 인데 §7.5-4 는 같은 모드를 두고 "라우트 수
   * 상한과 벤치 기준을 함께 정의한다" 고 했다. 그래서 **모드는 내되 상한을 강제한다** —
   * 상한 없이 내면 큰 배포가 조용히 두 배의 대가를 문다.
   */
  it('상한을 넘으면 검증기가 막는다 — 조용히 느려지지 않는다', () => {
    const routes = [];
    for (let i = 0; i < 200; i += 1) {
      routes.push({ key: `e${i}`, listener: 'web', hosts: [`h.z${i}.test`], priority: 10, action: { kind: 'proxy', pool: 'app', websocket: false } });
      routes.push({ key: `w${i}`, listener: 'web', hosts: [`*.z${i}.test`], priority: 20, action: { kind: 'proxy', pool: 'app', websocket: false } });
    }
    const big = { ...model(true), httpRoutes: routes } as unknown as Model;
    const issues = validateModel(big);
    expect(issues.some((i) => i.code === 'strict_priority_too_many'),
      JSON.stringify(issues.map((i) => i.code))).toBe(true);
  });

  it('상한 안이면 안 막는다', () => {
    const routes = [];
    for (let i = 0; i < 40; i += 1) {
      routes.push({ key: `e${i}`, listener: 'web', hosts: [`h.z${i}.test`], priority: 10, action: { kind: 'proxy', pool: 'app', websocket: false } });
      routes.push({ key: `w${i}`, listener: 'web', hosts: [`*.z${i}.test`], priority: 20, action: { kind: 'proxy', pool: 'app', websocket: false } });
    }
    const ok = { ...model(true), httpRoutes: routes } as unknown as Model;
    expect(validateModel(ok).some((i) => i.code === 'strict_priority_too_many')).toBe(false);
  });

  it('안 켜면 상한도 안 본다 — 강등이 없으니 대가도 없다', () => {
    const routes = [];
    for (let i = 0; i < 200; i += 1) {
      routes.push({ key: `e${i}`, listener: 'web', hosts: [`h.z${i}.test`], priority: 10, action: { kind: 'proxy', pool: 'app', websocket: false } });
      routes.push({ key: `w${i}`, listener: 'web', hosts: [`*.z${i}.test`], priority: 20, action: { kind: 'proxy', pool: 'app', websocket: false } });
    }
    const big = { ...model(false), httpRoutes: routes } as unknown as Model;
    expect(validateModel(big).some((i) => i.code === 'strict_priority_too_many')).toBe(false);
  });

  it('안 켜면 산출물이 예전과 같다 — 옵트인이다', () => {
    // 이 모드가 기본이 되면 안 건드린 배포의 렌더 바이트가 바뀌고, 그러면 전 배포가
    // 다음 apply 에서 세대 전환을 한다.
    expect(render(model(false)).conf).toBe(render({
      ...model(false),
      listeners: [{
        key: 'web', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true,
        http: { defaultAction: { pool: 'app' }, strictPriority: false },
      }],
    } as unknown as Model).conf);
  });
});
