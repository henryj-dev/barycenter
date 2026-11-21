/**
 * 운영 › 지표 · 관리 › 계정 감사 (2026-11-21).
 *
 * 지표: 서버가 내는 Prometheus 텍스트(`src/obs/metrics.ts` 의 `render`)를 화면 모듈이 그대로 읽는지 — 카운터는
 * 라벨을 이름에 접어 넣고 `# TYPE` 줄에도 라벨이 붙어 온다. 계정 감사: 서비스가 남기는 동작 이름이 화면 표에
 * 모두 있는지 — 새 동작을 넣고 표를 잊으면 화면이 영어 이름을 보인다.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { count, render, resetCounters, type Gauges } from '../../src/obs/metrics.js';
import { AUDIT_ACTIONS, AUDIT_GROUPS, auditAction, auditDetailText } from '../../src/web/account-audit-view.js';
import {
  counterRate, formatMetric, groupMetrics, labelText, parseMetrics, pushHistory, sampleKey, type MetricHistory,
} from '../../src/web/metrics-view.js';
import { RELAY_PATHS } from '../../src/global/relay.js';
import { apiRouteTable } from '../../src/api/server.js';
import { NAV_GROUPS, PAGE_META } from '../../src/web/nav.js';
import { KIT_ROUTES, pageOf } from '../../src/web/page.js';

const ROOT = join(import.meta.dirname, '../..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

const GAUGES: Gauges = {
  generations: 3, generationBytes: 5 * 1024 * 1024, agentStateBytes: 2048, head: 95, leader: 1,
  activationEpochHttp: 105, activationEpochStream: 105, unfinished: 0, backendsHealthy: 12, backendsUnhealthy: 1,
  backendsUnknown: 0, pendingApply: 0, uptimeSeconds: 7200, rssBytes: 120 * 1024 * 1024,
};

afterEach(() => resetCounters());

describe('지표 — 서버의 텍스트를 화면 모양으로', () => {
  it('게이지 · 라벨 게이지 · 라벨을 접은 카운터를 모두 읽는다', () => {
    count('bary_apply_total{phase="activated"}');
    count('bary_apply_total{phase="activated"}');
    count('bary_apply_total{phase="failed"}');
    count('bary_health_transition_total');
    const text = render(GAUGES, [{
      name: 'bary_certificate_expiry_seconds', help: '인증서 만료까지 남은 초',
      samples: [{ labels: { certificate: 'web:main', issuer: 'acme' }, value: 86400 * 40 }],
    }]);
    const fams = parseMetrics(text);
    const apply = fams.find((f) => f.name === 'bary_apply_total')!;
    expect(apply.type).toBe('counter');
    expect(apply.samples).toEqual([
      { labels: { phase: 'activated' }, value: 2 },
      { labels: { phase: 'failed' }, value: 1 },
    ]);
    expect(apply.help).toBe('적용이 어느 단계에서 끝났는지 센다');
    const head = fams.find((f) => f.name === 'bary_config_head_revision')!;
    expect(head).toMatchObject({ type: 'gauge', help: '전역 설정 리비전', samples: [{ labels: {}, value: 95 }] });
    const cert = fams.find((f) => f.name === 'bary_certificate_expiry_seconds')!;
    expect(cert.samples[0]!.labels).toEqual({ certificate: 'web:main', issuer: 'acme' });
  });

  it('묶음으로 나눈다 — 적용 · 헬스 · ACME · 프로세스, 모르는 이름은 「그 밖」', () => {
    count('bary_apply_total{phase="activated"}');
    const text = `${render(GAUGES)}# TYPE something_else gauge\nsomething_else 1\n`;
    const areas = groupMetrics(parseMetrics(text));
    const of = (name: string): string | undefined => areas.find((a) => a.families.some((f) => f.name === name))?.key;
    expect(of('bary_apply_total')).toBe('apply');
    expect(of('bary_backends_unhealthy')).toBe('health');
    expect(of('bary_generation_bytes')).toBe('generations');
    expect(of('bary_uptime_seconds')).toBe('process');
    expect(of('bary_leader')).toBe('cluster');
    expect(of('something_else')).toBe('other');
    expect(areas.every((a) => a.families.length > 0)).toBe(true);
  });

  it('깨진 줄과 라벨의 따옴표 · 줄바꿈을 견딘다', () => {
    const fams = parseMetrics('garbage line\nx_total{a="q\\"t",b="l\\nn"} 4\ny NaNish\n# HELP\n');
    expect(fams).toHaveLength(1);
    expect(fams[0]!.samples[0]!.labels).toEqual({ a: 'q"t', b: 'l\nn' });
  });

  it('단위를 이름에서 읽는다', () => {
    expect(formatMetric('bary_generation_bytes', 5 * 1024 * 1024)).toBe('5.0 MiB');
    expect(formatMetric('bary_uptime_seconds', 7200)).toBe('2.0시간');
    expect(formatMetric('bary_config_head_revision', 1234)).toBe('1,234');
    expect(labelText({ phase: 'activated', plane: 'http' })).toBe('phase=activated · plane=http');
  });

  it('흐름을 쌓고, 카운터의 초당 증가를 센다 — 줄면(다시 뜸) 비운다', () => {
    const h: MetricHistory = new Map();
    const f = (v: number) => [{ name: 'bary_apply_total', type: 'counter' as const, samples: [{ labels: { phase: 'activated' }, value: v }] }];
    pushHistory(h, 0, f(10));
    pushHistory(h, 10_000, f(15));
    const k = sampleKey('bary_apply_total', { phase: 'activated' });
    expect(counterRate(h.get(k))).toBe(0.5);
    pushHistory(h, 20_000, f(2));
    expect(counterRate(h.get(k))).toBeUndefined();
    for (let i = 0; i < 100; i += 1) pushHistory(h, 30_000 + i, f(i), 60);
    expect(h.get(k)).toHaveLength(60);
  });

  it('API 자리(`/api/v1/metrics`)와 전역 중계가 있다 — 최상위 `/metrics` 는 그대로다', () => {
    const t = apiRouteTable().map((r) => `${r.method} ${r.path} ${r.scope}`);
    expect(t).toContain('GET /metrics read');
    expect(t).toContain('GET /api/v1/metrics read');
    expect(t).toContain('GET /api/v1/regions/:name/metrics read');
    expect(RELAY_PATHS).toContain('metrics');
  });
});

describe('계정 감사 — 동작 이름', () => {
  /** 서비스와 API 가 `#audit(...)` · INSERT 로 남기는 동작 이름. */
  const emitted = (): string[] => {
    const src = ['src/accounts/service.ts', 'src/api/server.ts'].map(read).join('\n');
    return [...new Set([...src.matchAll(/'((?:account|session|global)\.[a-z_]+)'/g)].map((m) => m[1]!))].sort();
  };

  it('남기는 모든 동작에 한국어 이름과 묶음이 있다', () => {
    const missing = emitted().filter((a) => AUDIT_ACTIONS[a] === undefined);
    expect(missing).toEqual([]);
    for (const a of Object.values(AUDIT_ACTIONS)) expect(AUDIT_GROUPS.map((g) => g.key)).toContain(a.group);
  });

  it('모르는 동작은 이름 그대로 보인다', () => {
    expect(auditAction('account.future_thing')).toEqual({ label: 'account.future_thing', tone: 'neutral' });
  });

  it('자세히 — 한 줄로, 긴 값은 자른다', () => {
    expect(auditDetailText({ role: 'operator', email: true, why: null })).toBe('role: operator · email: true');
    expect(auditDetailText({ x: 'a'.repeat(200) })).toHaveLength(3 + 78);
    expect(auditDetailText(undefined)).toBe('');
  });

  it('API 는 쪽 단위다 — `before` 가 숫자가 아니면 400, 관리자만', () => {
    const t = apiRouteTable().map((r) => `${r.method} ${r.path} ${r.scope}`);
    expect(t).toContain('GET /api/v1/account-audit admin');
    const s = read('src/api/server.ts');
    expect(s).toContain("code: 'invalid_cursor'");
    expect(read('src/accounts/service.ts')).toContain('ORDER BY a.id DESC LIMIT $1');
  });

  it('전역 화면은 계정 감사 경로를 지역으로 바꾸지 않는다 — 계정 저장소를 함께 쓴다', () => {
    expect(read('gui/src/lib/global/scope.svelte.ts')).toContain("'/api/v1/account-audit'");
  });
});

describe('화면 자리', () => {
  it('운영 › 지표 · 관리 › 계정 감사가 메뉴 · 주소 · 제목에 있다', () => {
    const items = NAV_GROUPS.flatMap((g) => g.items);
    expect(items).toContainEqual({ place: 'metrics', label: '지표', icon: '∿', href: '/ops/metrics' });
    expect(items).toContainEqual({ place: 'accountAudit', label: '계정 감사', icon: '⌕', href: '/admin/account-audit' });
    expect(KIT_ROUTES).toContainEqual({ place: 'metrics', path: '/ops/metrics' });
    expect(KIT_ROUTES).toContainEqual({ place: 'accountAudit', path: '/admin/account-audit' });
    expect(pageOf('/ops/metrics')).toBe('metrics');
    expect(pageOf('/admin/account-audit')).toBe('accountAudit');
    expect(PAGE_META.metrics.title).toBe('지표');
    expect(PAGE_META.accountAudit.title).toBe('계정 감사');
  });

  it('화면은 해석 모듈만 부른다 — Svelte 안에서 텍스트를 나누지 않는다', () => {
    const m = read('gui/src/lib/ops/Metrics.svelte');
    expect(m).toContain("from '@web/metrics-view'");
    expect(m).toContain('desk.metricsText()');
    expect(m).not.toMatch(/split\('\\n'\)/);
    const a = read('gui/src/lib/account/AccountAudit.svelte');
    expect(a).toContain("from '@web/account-audit-view'");
    expect(a).toContain('accountApi.accountAudit(PAGE');
  });
});
