/**
 * 디스커버리 러너의 **안전장치** · 멤버십 연결 (2026-11-05).
 *
 *   · 출처 오류 · 타임아웃 → 마지막 성공 값을 유지한다(빈 값으로 바꾸지 않는다). 처음부터 실패면 정적이다
 *   · 정상 빈 목록 → `emptyMeans`(기본 keep: 유지 · empty: 백엔드 0)
 *   · 출처 설정이 바뀌면 들던 값을 버린다 · 출처를 지우면 정적으로 돌아간다
 *   · 같은 실패를 매 주기 다시 「새 실패」 로 말하지 않는다
 *   · 풀 단위 — 출처가 있는 풀만 바뀌고 나머지 풀은 정적 그대로다
 *   · 적격(헬스 · 드레인)에 발견한 peer 가 들어가 슬롯에 남는다 — 전에는 정적만 줄여서 빈 슬롯이 됐다
 */
import { describe, expect, it } from 'vitest';

import { applyDiscoveredEndpoints, eligibleWithDiscovery } from '../../src/control/discovery.js';
import { DiscoveryRunner } from '../../src/control/discovery/runner.js';
import type { DiscoveryResult, DiscoverySource } from '../../src/control/discovery/source.js';
import { slotsForEligible } from '../../src/control/membership.js';
import type { Model, Pool } from '../../src/model/provisional.js';

const model = (pools: Pool[]): Model => ({
  listeners: [
    { key: 'web', protocol: 'http', bind: '0.0.0.0', port: 8080, enabled: true, http: { defaultAction: { pool: 'app' } } },
    { key: 'db', protocol: 'tcp', bind: '0.0.0.0', port: 5432, enabled: true, defaultPool: 'pg' },
  ] as Model['listeners'],
  httpRoutes: [], passthroughRoutes: [],
  pools,
  backends: [
    { key: 'app-1', pool: 'app', host: '10.0.0.1', port: 80, weight: 1 },
    { key: 'pg-1', pool: 'pg', host: '10.0.9.1', port: 5432, weight: 1 },
  ],
  certificates: [], tlsPolicies: [], sniBindings: [],
});

const appPool = (discovery?: Pool['discovery']): Pool => ({
  key: 'app', protocolClass: 'http', algorithm: 'round_robin', ...(discovery === undefined ? {} : { discovery }),
});
const pgPool: Pool = { key: 'pg', protocolClass: 'tcp', algorithm: 'round_robin' };

/** 차례로 답하는 가짜 출처. */
function scripted(answers: DiscoveryResult[]): DiscoverySource & { calls: string[] } {
  const calls: string[] = [];
  return {
    kind: 'consul',
    calls,
    resolve: async (q) => {
      calls.push(q);
      return answers.shift() ?? { ok: false, reason: 'unavailable', detail: '답이 없다' };
    },
  };
}

const ok = (...hosts: string[]): DiscoveryResult => ({ ok: true, endpoints: hosts.map((h) => ({ host: h, port: 8080 })) });
const fail = (reason: 'unavailable' | 'invalid' = 'unavailable'): DiscoveryResult => ({ ok: false, reason, detail: '시간이 지났다' });

const runnerWith = (src: DiscoverySource | undefined): DiscoveryRunner =>
  new DiscoveryRunner({ sources: () => src, intervalMs: 1_000, now: () => new Date('2026-11-05T00:00:00Z') });

describe('출처 오류면 마지막 성공 값을 지킨다', () => {
  it('성공 → 실패 → 실패: 목록이 그대로다', async () => {
    const src = scripted([ok('10.1.0.1', '10.1.0.2'), fail(), fail('invalid')]);
    const r = runnerWith(src);
    const m = model([appPool({ source: 'consul', query: 'api' }), pgPool]);
    expect((await r.tick(m)).changed).toEqual(['app']);
    const second = await r.tick(m);
    expect(second.changed).toEqual([]);
    expect(second.failed.map((f) => f.pool)).toEqual(['app']);
    const third = await r.tick(m);
    // 실패의 뜻이 바뀌었으니 다시 알린다. 목록은 그대로다.
    expect(third.failed.map((f) => f.error?.reason)).toEqual(['invalid']);
    expect(r.view('app')).toMatchObject({
      state: 'error', advertised: true,
      endpoints: [{ host: '10.1.0.1', port: 8080 }, { host: '10.1.0.2', port: 8080 }],
      lastSuccessAt: '2026-11-05T00:00:00.000Z',
    });
    expect(r.intake()).toEqual({
      advertised: true, pools: ['app'],
      endpoints: [{ pool: 'app', host: '10.1.0.1', port: 8080 }, { pool: 'app', host: '10.1.0.2', port: 8080 }],
    });
  });

  it('같은 실패는 매 주기 「새 실패」 가 아니다', async () => {
    const r = runnerWith(scripted([fail(), fail(), fail()]));
    const m = model([appPool({ source: 'consul', query: 'api' }), pgPool]);
    expect((await r.tick(m)).failed).toHaveLength(1);
    expect((await r.tick(m)).failed).toHaveLength(0);
  });

  it('처음부터 실패면 정적 백엔드다 — 광고하지 않는다', async () => {
    const r = runnerWith(scripted([fail()]));
    await r.tick(model([appPool({ source: 'consul', query: 'api' }), pgPool]));
    expect(r.view('app')).toMatchObject({ state: 'error', advertised: false, endpoints: [] });
    expect(r.intake()).toBeUndefined();
  });

  it('출처가 던져도 실패로 닫고 값을 지킨다', async () => {
    let n = 0;
    const r = runnerWith({
      kind: 'consul',
      resolve: async () => {
        n += 1;
        if (n === 1) return ok('10.1.0.1');
        throw new Error('버그');
      },
    });
    const m = model([appPool({ source: 'consul', query: 'api' }), pgPool]);
    await r.tick(m);
    await r.tick(m);
    expect(r.view('app')).toMatchObject({ state: 'error', advertised: true, endpoints: [{ host: '10.1.0.1', port: 8080 }] });
  });

  it('이 데몬에 출처가 없으면 「설정 안 됨」 이고 정적이다', async () => {
    const r = runnerWith(undefined);
    const t = await r.tick(model([appPool({ source: 'kubernetes', query: 'prod/api' }), pgPool]));
    expect(t.failed.map((f) => f.error?.reason)).toEqual(['unconfigured']);
    expect(r.view('app')).toMatchObject({ state: 'unconfigured', advertised: false });
    expect(r.intake()).toBeUndefined();
  });
});

describe('정상 빈 목록은 emptyMeans 가 정한다', () => {
  it('기본 keep — 앞의 목록을 지킨다', async () => {
    const r = runnerWith(scripted([ok('10.1.0.1'), ok()]));
    const m = model([appPool({ source: 'consul', query: 'api' }), pgPool]);
    await r.tick(m);
    expect((await r.tick(m)).changed).toEqual([]);
    expect(r.view('app')).toMatchObject({ state: 'ok', advertised: true, keptEmpty: true, endpoints: [{ host: '10.1.0.1', port: 8080 }] });
  });

  it('처음부터 빈 목록이면(keep) 정적이다', async () => {
    const r = runnerWith(scripted([ok()]));
    await r.tick(model([appPool({ source: 'consul', query: 'api' }), pgPool]));
    expect(r.view('app')).toMatchObject({ advertised: false, keptEmpty: true });
  });

  it('empty — 백엔드 0 이 된다', async () => {
    const r = runnerWith(scripted([ok('10.1.0.1'), ok()]));
    const m = model([appPool({ source: 'consul', query: 'api', emptyMeans: 'empty' }), pgPool]);
    await r.tick(m);
    expect((await r.tick(m)).changed).toEqual(['app']);
    expect(r.intake()).toEqual({ advertised: true, pools: ['app'], endpoints: [] });
    // 그 풀은 백엔드 0, 다른 풀은 정적 그대로다.
    expect(applyDiscoveredEndpoints(m, r.intake()).backends.map((b) => b.key)).toEqual(['pg-1']);
  });
});

describe('출처 설정의 변화', () => {
  it('query 가 바뀌면 들던 값을 버린다 · 포트 덮기', async () => {
    const src = scripted([ok('10.1.0.1'), fail()]);
    const r = runnerWith(src);
    await r.tick(model([appPool({ source: 'consul', query: 'api' }), pgPool]));
    const t = await r.tick(model([appPool({ source: 'consul', query: 'api-v2', port: 9000 }), pgPool]));
    expect(t.changed).toEqual(['app']);
    expect(r.view('app')).toMatchObject({ query: 'api-v2', advertised: false, state: 'error' });
    expect(src.calls).toEqual(['api', 'api-v2']);

    const r2 = runnerWith(scripted([ok('10.1.0.1', '10.1.0.2')]));
    await r2.tick(model([appPool({ source: 'consul', query: 'api', port: 9000 }), pgPool]));
    expect(r2.view('app')?.endpoints).toEqual([{ host: '10.1.0.1', port: 9000 }, { host: '10.1.0.2', port: 9000 }]);
  });

  it('출처를 지우면 정적으로 돌아간다', async () => {
    const r = runnerWith(scripted([ok('10.1.0.1')]));
    await r.tick(model([appPool({ source: 'consul', query: 'api' }), pgPool]));
    const t = await r.tick(model([appPool(), pgPool]));
    expect(t.changed).toEqual(['app']);
    expect(r.view('app')).toBeUndefined();
    expect(r.intake()).toBeUndefined();
  });
});

describe('멤버십 연결', () => {
  it('풀 단위 — 출처가 있는 풀만 바뀌고 옛 계약(pools 없음)은 그대로 통째 교체다', () => {
    const m = model([appPool({ source: 'consul', query: 'api' }), pgPool]);
    const used = applyDiscoveredEndpoints(m, {
      advertised: true, pools: ['app'],
      endpoints: [{ pool: 'app', host: '10.1.0.1', port: 8080 }, { pool: 'pg', host: '10.9.9.9', port: 1 }],
    });
    expect(used.backends.map((b) => `${b.pool}:${b.host}:${b.port}`)).toEqual(['pg:10.0.9.1:5432', 'app:10.1.0.1:8080']);
    const legacy = applyDiscoveredEndpoints(m, { advertised: true, endpoints: [{ pool: 'app', host: '10.1.0.1', port: 8080 }] });
    expect(legacy.backends.map((b) => b.host)).toEqual(['10.1.0.1']);
  });

  it('적격에 발견한 peer 가 들어가 슬롯에 남는다 — 헬스 · 드레인은 정적 peer 에 그대로 걸린다', () => {
    const m = model([appPool({ source: 'consul', query: 'api' }), pgPool]);
    const intake = { advertised: true as const, pools: ['app'], endpoints: [{ pool: 'app', host: '10.1.0.1', port: 8080 }] };
    const eligible = eligibleWithDiscovery(m, new Map([['pg-1', 'unhealthy' as const]]), new Set(), intake);
    const slots = slotsForEligible(m, eligible, { streamRealip: false, httpLua: true, streamLua: true }, intake);
    const http = Object.values(slots.http);
    const stream = Object.values(slots.stream);
    expect(http).toEqual([['10.1.0.1:8080']]);
    expect(stream).toEqual([[]]);
  });
});
