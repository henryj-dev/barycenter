/**
 * **JSON 으로만 고치던 칸을 GUI 로** (2026-11-20).
 *
 * 전에는 아래 칸이 모델 · 검증 · 렌더에는 있었지만 폼에는 없었다 — 「JSON 으로 고치기」 나 raw patch 로만 넣었다.
 *   · 리스너 레이트리밋 zone 크기(`zoneKb`)            · 백엔드 동시 연결 기준(`softMaxConns`) · 예비(`isBackup`)
 *   · SNI 바인딩 TLS 버전 덮어쓰기(`override`)         · TLS 정책 HSTS `preload`
 *   · 출발지 규칙 동작의 요청 헤더 · 경로 바꾸기         · 엔진 설정(`engine`) 세 칸
 *   · 만들 때의 원본 IP · preread 타임아웃 · PROXY 수신 · 경로별 묶음의 우선순위
 *
 * 재는 것: 폼이 쓰는 빌더가 만든 몸체를 **해독기 · 검증기가 받는다**, 범위 판정이 해독기와 같다, 화면이 그 칸을 그린다.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { listenerOptionFields, parseListenerOptions, putBackendPatch, putSniBindingPatch, BACKUP_FORBIDDEN_ALGORITHMS } from '../../src/web/edit.js';
import { routeGroupPatch } from '../../src/web/route-group.js';
import { ENGINE_LIMITS, engineBody, engineErrors, engineFormOf } from '../../src/web/engine-settings.js';
import { RELAY_PATHS } from '../../src/global/relay.js';
import { KIT_ROUTES, pageOf } from '../../src/web/page.js';
import { NAV_GROUPS, PAGE_META } from '../../src/web/nav.js';
import { decodeModel } from '../../src/model/decode.js';
import { validateModel } from '../../src/validate/model.js';
import { overrideBody, overrideError, overrideOf, policyBody, policyForm, preloadError } from '../../gui/src/lib/tls/policy-edit.js';
import { plainSwitches, prereadError, realIpFields, switchedBody } from '../../gui/src/lib/forms/listener-create.js';

const gui = (p: string): string => readFileSync(join(import.meta.dirname, '../../gui/src', p), 'utf8');

const EMPTY = { listeners: [], httpRoutes: [], passthroughRoutes: [], pools: [], backends: [], certificates: [], tlsPolicies: [], sniBindings: [], addressSets: [] };
/** 해독되고 검증을 지나면 문제 코드가 없다. */
const issuesOf = (m: Record<string, unknown>): string[] => {
  const d = decodeModel({ ...EMPTY, ...m });
  if (!d.ok) return d.issues.map((i) => i.code);
  return validateModel(d.model).map((i) => i.code);
};

describe('리스너 레이트리밋 zone 크기', () => {
  it('`10m` · `512k` 를 KB 로 읽는다 — 단위가 없으면 거부한다', () => {
    expect(parseListenerOptions({ rate: '10', zone: '10m' }).rateLimit).toEqual({ requestsPerSecond: 10, zoneKb: 10240 });
    expect(parseListenerOptions({ maxConn: '5', zone: '512k' }).rateLimit).toEqual({ maxConnections: 5, zoneKb: 512 });
    expect(() => parseListenerOptions({ rate: '10', zone: '512' })).toThrow(/단위/);
  });
  it('zone 만으로는 레이트리밋이 아니다 — 해독기와 같은 규칙', () => {
    expect(() => listenerOptionFields({ rateLimit: { zoneKb: 64 } })).toThrow(/requestsPerSecond 나 maxConnections/);
  });
  it('폼이 칸을 그리고, 설정 탭은 그 칸의 주인이다(옛 값을 몰래 남기지 않는다)', () => {
    expect(gui('lib/forms/ListenerOptions.svelte')).toContain('value.zone = rateOn ? opt(f.zone) : undefined;');
    expect(gui('lib/listener/ListenerForm.svelte')).not.toContain("obj(oldRate)?.['zoneKb']");
  });
});

describe('백엔드 동시 연결 기준 · 예비', () => {
  const pool = (algorithm: string) => ({ key: 'p', protocolClass: 'http', algorithm });
  it('빌더가 싣고, 해독기 · 검증기가 받는다', () => {
    const [op] = putBackendPatch('b', { pool: 'p', host: '10.0.0.1', port: 80, softMaxConns: 100, isBackup: true });
    expect(op!.body).toEqual({ pool: 'p', host: '10.0.0.1', port: 80, weight: 1, softMaxConns: 100, isBackup: true });
    const main = putBackendPatch('a', { pool: 'p', host: '10.0.0.2', port: 80 })[0]!;
    expect(issuesOf({ pools: [pool('round_robin')], backends: [{ key: 'a', ...main.body }, { key: 'b', ...op!.body }] })).toEqual([]);
  });
  it('`isBackup: false` 는 싣지 않는다 · 범위 밖은 거부한다', () => {
    expect(putBackendPatch('b', { pool: 'p', host: 'h', port: 1, isBackup: false })[0]!.body).not.toHaveProperty('isBackup');
    expect(() => putBackendPatch('b', { pool: 'p', host: 'h', port: 1, softMaxConns: 0 })).toThrow();
  });
  it('해시 계열 풀이 예비를 못 갖는 것은 검증기와 같다', () => {
    for (const algorithm of ['round_robin', 'least_conn', 'hash', 'source_ip_hash']) {
      const backends = [{ key: 'a', pool: 'p', host: 'h', port: 1, weight: 1 }, { key: 'b', pool: 'p', host: 'h', port: 2, weight: 1, isBackup: true }];
      const rejected = issuesOf({ pools: [pool(algorithm)], backends }).length > 0;
      expect(rejected, algorithm).toBe(BACKUP_FORBIDDEN_ALGORITHMS.includes(algorithm));
    }
  });
  it('만들기 · 설정 폼이 두 칸을 그린다', () => {
    for (const f of ['lib/forms/BackendForm.svelte', 'lib/detail/BackendSettings.svelte']) {
      expect(gui(f)).toContain('label="동시 연결 기준"');
      expect(gui(f)).toContain('label="예비 백엔드"');
    }
  });
});

describe('SNI 바인딩 TLS 버전 덮어쓰기', () => {
  it('빈 덮어쓰기는 싣지 않는다 · 있으면 해독기가 받는다', () => {
    const base = { key: 's', listener: 'l', hosts: ['a.example.com'], certificate: 'c' };
    expect(putSniBindingPatch({ ...base, override: {} })[0]!.body).not.toHaveProperty('override');
    expect(putSniBindingPatch({ ...base, override: overrideBody({ min: '1.3', max: '' })! })[0]!.body.override).toEqual({ minVersion: '1.3' });
    expect(overrideOf({ override: { maxVersion: '1.2' } })).toEqual({ min: '', max: '1.2' });
    expect(overrideBody({ min: '', max: '' })).toBeUndefined();
  });
  it('덮지 않은 쪽은 정책 값으로 보고, 범위가 비면 막는다', () => {
    expect(overrideError({ min: '1.3', max: '' }, { min: '1.2', max: '1.2' })).toMatch(/최소 TLS 1.3 이 최대 TLS 1.2/);
    expect(overrideError({ min: '1.3', max: '' }, { min: '1.2' })).toBeUndefined();
    expect(overrideError({ min: '', max: '1.2' }, { min: '1.3' })).toMatch(/연결할 수 없어요/);
  });
  it('만들기 · 설정 폼이 구획을 그린다', () => {
    expect(gui('lib/forms/SniBindingForm.svelte')).toContain('<SniOverrideSection');
    expect(gui('lib/tls/SniBindingSettings.svelte')).toContain('<SniOverrideSection');
  });
});

describe('HSTS preload', () => {
  it('폼 값이 몸체에 싣고 다시 읽힌다 · 검증기가 받는다', () => {
    const f = { ...policyForm(undefined), hsts: true, maxAge: '31536000', subdomains: true, preload: true };
    const body = policyBody(f);
    expect(body['hsts']).toEqual({ maxAgeSeconds: 31_536_000, includeSubdomains: true, preload: true });
    expect(policyForm({ key: 'x', ...body }).preload).toBe(true);
    expect(issuesOf({ tlsPolicies: [{ key: 'x', ...body }] })).toEqual([]);
  });
  it('조건은 해독기 · 검증기와 같다 — 1년 이상 · 하위 도메인', () => {
    for (const [maxAge, subdomains] of [['31535999', true], ['31536000', false], ['63072000', true]] as const) {
      const f = { ...policyForm(undefined), hsts: true, maxAge, subdomains, preload: true };
      const rejected = issuesOf({ tlsPolicies: [{ key: 'x', ...policyBody(f) }] }).length > 0;
      expect(preloadError(f) !== undefined, `${maxAge} ${String(subdomains)}`).toBe(rejected);
    }
  });
});

describe('만들 때 정하는 원본 IP · preread · PROXY 수신', () => {
  it('기본값이면 원래 만들기 길이다', () => {
    expect(plainSwitches({ enabled: true, realIp: { source: 'none', header: 'X-Real-IP', trusted: '' }, preread: ' ' })).toBe(true);
    expect(plainSwitches({ enabled: true, preread: '10' })).toBe(false);
    expect(plainSwitches({ enabled: true, realIp: { source: 'proxy', header: 'X-Real-IP', trusted: '10.0.0.0/8' } })).toBe(false);
  });
  it('원본 IP 는 출처 하나만 싣는다', () => {
    expect(realIpFields({ source: 'header', header: 'X-Real-IP', trusted: '10.0.0.0/8\n@lb' }))
      .toEqual({ realIpFromHeader: { header: 'X-Real-IP', trustedCidrs: ['10.0.0.0/8', '@lb'] } });
    expect(realIpFields({ source: 'proxy', header: 'X-Real-IP', trusted: '10.0.0.0/8' })).toEqual({ acceptProxyProtocol: { trustedCidrs: ['10.0.0.0/8'] } });
    expect(realIpFields({ source: 'none', header: 'X-Real-IP', trusted: '10.0.0.0/8' })).toEqual({});
  });
  it('패스스루 preread 는 해독기와 같은 범위다', () => {
    const body = switchedBody([{ key: 'l', body: { protocol: 'tls_passthrough', bind: '0.0.0.0', port: 443, enabled: true } }], { enabled: true, preread: '30' }).body;
    expect(body['prereadTimeoutS']).toBe(30);
    expect(issuesOf({ listeners: [{ key: 'l', ...body }] }).filter((c) => c === 'invalid_value' || c === 'out_of_range')).toEqual([]);
    expect(prereadError('0')).toBeDefined();
    expect(prereadError('3601')).toBeDefined();
    expect(prereadError('')).toBeUndefined();
  });
  it('만들기 폼이 원본 IP 구획을 그린다', () => {
    for (const f of ['lib/forms/HttpListenerForm.svelte', 'lib/forms/TcpListenerForm.svelte', 'lib/forms/PassthroughListenerForm.svelte']) {
      expect(gui(f), f).toContain('<RealIpSection');
    }
    expect(gui('lib/forms/PassthroughListenerForm.svelte')).toContain('label="preread 타임아웃"');
  });
});

describe('경로별 묶음의 우선순위', () => {
  const input = {
    key: 'g', listener: 'web', hosts: ['a.example.com'],
    lines: [
      { paths: ['/'], from: [], action: { kind: 'reject' as const, status: 444 as const } },
      { paths: ['/api/'], from: [], action: { kind: 'proxy' as const, pool: 'p', websocket: false } },
    ],
  };
  it('펼친 라우트 모두가 같은 값을 쓴다 · 없으면 0', () => {
    expect(routeGroupPatch({ ...input, priority: 250 }).map((o) => o.body.priority)).toEqual([250, 250]);
    expect(routeGroupPatch(input).map((o) => o.body.priority)).toEqual([0, 0]);
    expect(() => routeGroupPatch({ ...input, priority: 1_000_001 })).toThrow();
  });
  it('폼이 칸을 그린다', () => {
    expect(gui('lib/forms/RouteGroupForm.svelte')).toContain('label="우선순위"');
  });
});

describe('출발지 규칙 동작의 요청 헤더 · 경로 바꾸기', () => {
  it('폼이 칸을 그리고, 저장을 막던 `lossy` 가 없다', () => {
    const field = gui('lib/forms/SourceRulesField.svelte');
    expect(field).toContain('bind:value={rule.rewritePrefix}');
    expect(field).toContain('bind:rows={rule.headers}');
    expect(gui('lib/forms/HttpRouteForm.svelte')).not.toContain('lossy');
    expect(gui('lib/lists/HttpRouteInline.svelte')).not.toContain('lossy');
  });
});

describe('엔진 설정', () => {
  it('범위는 해독기와 같다', () => {
    const cases = [['shutdown', 'workerShutdownTimeoutS'], ['membership', 'membershipDictKb'], ['acme', 'acmeDictKb']] as const;
    for (const [field, limit] of cases) {
      const { min, max } = ENGINE_LIMITS[limit];
      for (const v of [min - 1, min, max, max + 1]) {
        const f = { shutdown: '', membership: '', acme: '', [field]: String(v) };
        const decoded = decodeModel({ ...EMPTY, engine: engineBody(f) }).ok;
        expect(engineErrors(f)[field] === undefined, `${field}=${v}`).toBe(decoded);
      }
    }
  });
  it('비운 칸은 싣지 않는다 · 모델 → 폼 → 몸체가 같다', () => {
    expect(engineBody({ shutdown: '', membership: '', acme: '' })).toEqual({});
    const s = { workerShutdownTimeoutS: 30, membershipDictKb: 4096 };
    expect(engineBody(engineFormOf(s))).toEqual(s);
  });
  it('읽기 API 가 있고 전역에서 중계된다', () => {
    const server = readFileSync(join(import.meta.dirname, '../../src/api/server.ts'), 'utf8');
    expect(server).toContain("route('GET', '/api/v1/engine', 'read'");
    expect(server).toContain("route('GET', '/api/v1/regions/:name/engine', 'read', relayTo('engine'))");
    expect(RELAY_PATHS).toContain('engine');
  });
  it('운영 메뉴의 화면이다', () => {
    expect(KIT_ROUTES).toContainEqual({ place: 'engine', path: '/ops/engine' });
    expect(pageOf('/ops/engine')).toBe('engine');
    expect(NAV_GROUPS.find((g) => g.title === '운영')?.items.map((i) => i.place)).toContain('engine');
    expect(PAGE_META.engine.title).toBe('엔진 설정');
    expect(gui('routes/ops/engine/+page.svelte')).toContain('<EngineSettings />');
    expect(gui('lib/ops/EngineSettings.svelte')).toContain('desk.putEngine(engineBody(f))');
  });
});
