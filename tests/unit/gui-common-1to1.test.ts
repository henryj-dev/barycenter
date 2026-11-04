/**
 * 3차 — 공통 컴포넌트가 콘솔 시안 마크업 값과 같다 (2026-11-04).
 *   · DataTable 도구 줄: 분할 컨트롤(`toolbar`)은 찾기 칸 바로 옆, 빈 칸 뒤에는 「N개」 (시안 `rkTabs` 자리)
 *   · Menu 항목 설명 줄(시안 `ci.d`) · FormRow 경고 톤(시안 `o.warn`) · TextInput 단위 꼬리표(시안 `f.unit`)
 *   · 상세 머리: 제목 고정폭 18px · 600 · 경로 줄 없음 · 버튼 28px(「URL로 다시 만들기」 24px) · 「이 지역에서 열기 ↗」 자리 · 위험 테두리
 *   · 「연결된 리소스 · N」 의 N 은 탭이 그리는 줄 수(같은 `relationRows`)
 *   · 쓸 수 없는 설정 탭 · 분할 보기 모드는 시안 `viewSecs` 구획
 *   · 개요 격자 · 연결 줄 · 기록 줄 · 설정 틀은 리소스마다 하나
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GUI = join(dirname(fileURLToPath(import.meta.url)), '../../gui/src');
const src = (p: string): string => readFileSync(join(GUI, p), 'utf8');

describe('공통 컴포넌트 — 시안 1:1 (3차)', () => {
  it('DataTable: toolbar 는 빈 칸 앞(찾기 칸 옆), actions 는 빈 칸 뒤', () => {
    const s = src('lib/ui/DataTable.svelte');
    const bar = s.slice(s.indexOf('<div class="bar">'), s.indexOf('<span class="count">'));
    expect(bar.indexOf('{@render toolbar()}')).toBeGreaterThan(-1);
    expect(bar.indexOf('{@render toolbar()}')).toBeLessThan(bar.indexOf('<div class="grow"></div>'));
    expect(bar.indexOf('{@render actions()}')).toBeGreaterThan(bar.indexOf('<div class="grow"></div>'));
    expect(src('lib/lists/HttpRouteList.svelte')).toContain('toolbar={segments}');
  });

  it('Menu: 설명 줄이 있으면 260px · 이름 500 · 설명 12px --tx3', () => {
    const s = src('lib/ui/Menu.svelte');
    expect(s).toContain("description?: string;");
    expect(s).toContain(".pop[data-described='true'] { width: 260px; }");
    expect(s).toContain('.d { font-size: 12px; line-height: 16px; color: var(--tx3); }');
  });

  it('FormRow: warn 이면 도움말 · 입력 테두리가 --warn', () => {
    expect(src('lib/ui/FieldMessage.svelte')).toContain(".msg[data-tone='warn'] { color: var(--warn); }");
    const r = src('lib/ui/FormRow.svelte');
    expect(r).toContain("<FieldMessage tone={warn ? 'warn' : 'help'}>{help}</FieldMessage>");
    expect(r).toContain('border-color: var(--warn);');
    expect(src('lib/forms/TlsPolicyForm.svelte')).toContain('<FormRow label="HSTS" warn={hsts}');
    expect(src('lib/forms/SourceAllowSection.svelte')).toContain('{error} {warn}');
  });

  it('TextInput: unit 꼬리표(0 10px · --bg-hover · 왼쪽 --bd 선 · --tx2 · 고정폭 12px)', () => {
    const t = src('lib/ui/TextInput.svelte');
    expect(t).toContain('<span class="unit" aria-hidden="true">{unit}</span>');
    expect(t).toMatch(/\.unit \{[^}]*border-left: 1px solid var\(--bd\);[^}]*font: 400 12px\/1 var\(--mono\);/);
    expect(src('lib/pool/PoolSettings.svelte')).toContain('inputmode="numeric" unit="s"');
  });

  it('상세 머리: 제목 18px · 600 · 고정폭, 경로 줄은 하위 화면만', () => {
    const h = src('lib/ui/DetailHeader.svelte');
    expect(h).toContain('h1 { margin: 0; font: 600 18px/26px var(--mono);');
    expect(h).toContain('{#if crumbs.length > 0}');
    expect(h).toContain('.row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }');
    const f = src('lib/detail/ResourceFrame.svelte');
    expect(f).toContain('crumbs={extra !== undefined ? [');
  });

  it('상세 머리 버튼: 다시 만들기 24px → 지역에서 열기 28px(강조) → 수정 28px → 삭제 28px(위험)', () => {
    const f = src('lib/detail/ResourceFrame.svelte');
    const at = (s: string): number => f.indexOf(s);
    expect(at('<Button size="xs" href={resourcePath(kind, key, \'rebuild\')}>')).toBeGreaterThan(-1);
    expect(at('<Button size="sm" outline="accent" href={openReg.href}')).toBeGreaterThan(at('size="xs" href={resourcePath(kind, key, \'rebuild\')}'));
    expect(at('<Button size="sm" href={resourcePath(kind, key, \'settings\')}>수정</Button>')).toBeGreaterThan(at('outline="accent" href={openReg.href}'));
    expect(at('<Button size="sm" error disabled={desk.editing}')).toBeGreaterThan(at('>수정</Button>'));
    expect(src('lib/global/open-in.ts')).toContain("'이 지역에서 열기 ↗'");
  });

  it('「연결된 리소스」 의 수는 탭이 그리는 줄과 같은 함수', () => {
    expect(src('lib/detail/ResourceFrame.svelte')).toContain('relationRows(desk, kind, key).length');
    expect(src('lib/detail/RelationRows.svelte')).toContain('relationRows(desk, kind, key)');
  });

  it('쓸 수 없는 설정 탭 · 분할 보기 모드 = 시안 viewSecs', () => {
    expect(src('lib/detail/ViewSections.svelte')).toContain("n >= 3 ? '100%' : n === 2 ? 'calc(50% - 8px)' : 'calc(25% - 12px)'");
    expect(src('lib/detail/ReadView.svelte')).toContain('.view { display: flex; flex-direction: column; gap: 14px; max-width: 900px; }');
    expect(src('lib/detail/Settings.svelte')).toContain('<ReadView sections={view}>');
    expect(src('lib/detail/ListSplit.svelte')).toContain('<ViewSections sections=');
  });

  it('겹치던 시안 블록은 하나다', () => {
    for (const gone of ['lib/tls/SettingsFrame.svelte', 'lib/tls/TlsRelations.svelte', 'lib/tls/TlsHistory.svelte',
      'lib/route/RouteRelations.svelte', 'lib/route/RouteHistory.svelte']) {
      expect(existsSync(join(GUI, gone)), gone).toBe(false);
    }
    for (const o of ['lib/detail/CellOverview.svelte', 'lib/tls/TlsOverview.svelte', 'lib/route/RouteOverview.svelte']) {
      expect(src(o), o).toContain("import OverviewGrid from");
    }
    for (const d of ['route/http', 'route/passthrough']) {
      expect(src(`routes/traffic/${d}/[key]/resources/+page.svelte`)).toContain('<RelationRows kind=');
      expect(src(`routes/traffic/${d}/[key]/history/+page.svelte`)).toContain('<HistoryRows kind=');
    }
  });
});
