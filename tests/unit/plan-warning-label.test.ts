/**
 * plan 경고 머리말 — `impact.capabilityWarnings` 의 kind 마다 맞는 말을 붙인다 (2026-11-09).
 *
 * 전에는 GUI 적용 화면과 CLI 가 모든 줄 앞에 「엔진 —」 을 붙였다. 헬스 프로브의 SNI 경고(`probe_tls_no_sni`)나
 * 와일드카드 리스너 경고는 엔진 한계가 아니다 — 머리말이 틀린 말을 했다.
 *
 * 재는 것: 두 kind 의 머리말 · 모르는 kind 는 머리말 없이 · GUI 와 CLI 가 같은 줄 · 서버가 내는 kind 가 표에 다 있다.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { planSummary } from '../../src/cli/flow.js';
import { CAPABILITY_WARNING_LABEL, viewOfImpact } from '../../src/web/impact-view.js';

const root = join(__dirname, '../..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');

const guiLines = (warnings: { kind: string; message: string }[]): string[] =>
  viewOfImpact(
    { planId: 'p1', revision: '1' },
    {
      requiresReload: false, affectedListeners: [],
      socketChanges: { added: [], removed: [] }, planes: [],
      capabilityWarnings: warnings,
    },
  ).capabilityWarnings;

const cliLines = (warnings: { kind: string; message: string }[]): string[] =>
  planSummary({
    requiresReload: false, socketChanges: { added: [], removed: [] }, planes: [],
    capabilityWarnings: warnings,
  }).slice(1);

describe('plan 경고 머리말 — kind 마다', () => {
  it('엔진 능력 경고는 「엔진 —」', () => {
    const w = [{ kind: 'no_http2', message: 'h2 를 못 낸다' }];
    expect(guiLines(w)).toEqual(['엔진 — h2 를 못 낸다']);
    expect(cliLines(w)).toEqual(['엔진 — h2 를 못 낸다']);
  });

  it('probe_tls_no_sni 는 「헬스 체크 —」 — 엔진 한계가 아니다', () => {
    const w = [{ kind: 'probe_tls_no_sni', message: 'api 의 헬스 프로브는 IP 로 검증한다' }];
    expect(guiLines(w)).toEqual(['헬스 체크 — api 의 헬스 프로브는 IP 로 검증한다']);
    expect(cliLines(w)).toEqual(['헬스 체크 — api 의 헬스 프로브는 IP 로 검증한다']);
  });

  it('모르는 kind 는 머리말 없이 — 틀린 말보다 낫다', () => {
    const w = [{ kind: 'from_the_future', message: '새 경고' }];
    expect(guiLines(w)).toEqual(['새 경고']);
    expect(cliLines(w)).toEqual(['새 경고']);
  });

  it('GUI 와 CLI 가 모든 kind 에서 같은 줄을 낸다', () => {
    const w = Object.keys(CAPABILITY_WARNING_LABEL).map((kind) => ({ kind, message: `m-${kind}` }));
    expect(w.length).toBeGreaterThan(0);
    expect(cliLines(w)).toEqual(guiLines(w));
  });

  it('서버가 내는 kind 는 모두 표에 있다', () => {
    const src = read('src/store/config-store.ts');
    const body = src.slice(src.indexOf('function capabilityWarningsOf'), src.indexOf('function impactOf'));
    const emitted = [...body.matchAll(/kind: '([a-z_0-9]+)'/g)].map((m) => m[1]);
    expect(emitted).toContain('probe_tls_no_sni');
    expect(emitted.filter((k) => CAPABILITY_WARNING_LABEL[k!] === undefined)).toEqual([]);
  });

  it('GUI 화면은 머리말을 따로 붙이지 않는다 — 표 한 곳에서 온다', () => {
    const svelte = read('gui/src/lib/ops/PendingImpact.svelte');
    expect(svelte).not.toMatch(/엔진 — \$\{/);
  });
});
