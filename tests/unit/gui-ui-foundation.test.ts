/**
 * 공통 컴포넌트 기반 — 시안 1:1 (#126 후속).
 *
 * 재는 것:
 *   · 목록 칸 도우미(`cells.ts`)가 시안 `cellMap` 규칙과 같다 — `m()` 고정폭 · --tx, `x()` 보통 글꼴 · --tx2,
 *     `b()` 배지(아이콘이 비면 「·」), 빈 값은 「—」
 *   · 표의 고른 행은 `--bg-sel` 과 왼쪽 `inset 3px 0 0 var(--accent)`, 헤더는 32px, 찾아도 없으면 「검색 결과가 없어요.」
 *   · 분할 상세는 인라인 수정 자리(`inline`)를 갖고, 인라인 수정의 안내 문구는 시안 `hintTxt` 그대로다
 *   · 드로어는 dialog · Esc · Tab 가두기 · 시안 폭(500 · 560 · 680)을 갖는다
 *   · 만들기 주소(`…/new`)는 목록 위에 드로어를 연다 — 목록 컴포넌트와 `FormDrawer` 를 함께 그린다
 *   · 상세 머리는 메타 줄(`meta`)을 받고, `ResourceFrame` 이 그것을 넘긴다
 *
 * 파일은 테스트 안에서 읽는다(수정 전 트리에서 수집이 터지지 않고 빨강이 되도록).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const GUI = join(dirname(fileURLToPath(import.meta.url)), '../../gui/src');
const read = (p: string): string => readFileSync(join(GUI, p), 'utf8');

describe('목록 칸 도우미 (시안 cellMap)', () => {
  it('m · x · b · 빈 값', async () => {
    const { b, cellStyle, cellText, dash, m, x } = await import('../../gui/src/lib/ui/cells.js');
    expect(m('web-https')).toEqual({ kind: 'mono', t: 'web-https' });
    expect(cellStyle(m('a'))).toEqual({ font: 'var(--mono)', color: 'var(--tx)' });
    expect(cellStyle(x('켜짐'))).toEqual({ font: 'var(--font)', color: 'var(--tx2)' });
    expect(b('ok', '●', '정상')).toEqual({ kind: 'badge', tone: 'ok', icon: '●', t: '정상' });
    expect(b('neutral', '', 'x').icon).toBe('·');
    for (const v of ['', null, undefined]) expect(m(v).t).toBe('—');
    expect(m(0).t).toBe('0');
    expect(dash.t).toBe('—');
    expect(cellText(dash)).toBe('');
    expect(x('경로', '/a\n/b').title).toBe('/a\n/b');
  });
});

describe('데이터 테이블 (콘솔 목록 마크업)', () => {
  it('고른 행 · 헤더 · 빈 검색 · 칸 값 · 숨긴 열', () => {
    const src = read('lib/ui/DataTable.svelte');
    expect(src).toContain('inset 3px 0 0 var(--accent)');
    expect(src).toMatch(/tr\[aria-selected='true'\] \{ background-color: var\(--bg-sel\); \}/);
    expect(src).toMatch(/height: 32px; padding: 0 12px; font: 600 12px/);
    expect(src).toContain('검색 결과가 없어요.');
    expect(src).toContain('value?: (row: T) => Cell');
    expect(src).toContain('hidden?: boolean');
    expect(src).toContain('컬럼 ▾');
  });
});

describe('분할 상세 · 인라인 수정', () => {
  it('ListSplit 은 inline 스니펫을 받고, 고르지 않으면 아래를 숨긴다', () => {
    const src = read('lib/detail/ListSplit.svelte');
    expect(src).toContain('inline?: Snippet<[InlineContext]>');
    expect(src).toMatch(/hideEmpty/);
    expect(src).toContain('closeLabel="닫기"');
    expect(src).toContain('상세 페이지 ↗');
  });
  it('InlineEdit 문구는 시안 hintTxt 그대로다', () => {
    const src = read('lib/detail/InlineEdit.svelte');
    for (const t of ['✕ 오류가 있는 항목을 고쳐요', '저장하면 커밋하고 적용 대기에 새 리비전이 생겨요.', '◐ 적용 대기 중인 변경이 있어요.', '바뀐 값이 없어요.', '되돌리기', '저장']) {
      expect(src).toContain(t);
    }
  });
  it('SplitView 막대는 ↑↓ 24px · 위 80px · 아래 130px', () => {
    const src = read('lib/ui/SplitView.svelte');
    expect(src).toContain('Math.max(80');
    expect(src).toContain('- 130');
    expect(src).toMatch(/topH - 24/);
  });
});

describe('드로어', () => {
  it('dialog · Esc · Tab 가두기 · 어두운 막', () => {
    const src = read('lib/ui/Drawer.svelte');
    expect(src).toContain('role="dialog"');
    expect(src).toContain('aria-modal="true"');
    expect(src).toContain("e.key === 'Escape'");
    expect(src).toContain("e.key !== 'Tab'");
    expect(src).toContain('rgba(0, 0, 0, .45)');
  });
  it('시안 폭 · 제목', () => {
    const src = read('lib/forms/FormDrawer.svelte');
    expect(src).toMatch(/quick: \{ title: '빠른 프록시 만들기'.*width: 560/);
    expect(src).toMatch(/routeGroup: \{ title: '경로별 묶음으로 만들기'.*width: 680/);
    expect(src).toMatch(/backend: \{ title: '새 백엔드', sub: '설정', width: 500/);
  });
  it('만들기 주소는 목록 위에 드로어를 연다', () => {
    const news: string[] = [];
    const walk = (d: string): void => {
      for (const n of readdirSync(join(GUI, d))) {
        const p = join(d, n);
        if (statSync(join(GUI, p)).isDirectory()) walk(p);
        else if (n === '+page.svelte' && /\/new(\/|$)/.test(d)) news.push(p);
      }
    };
    walk('routes');
    expect(news.length).toBeGreaterThanOrEqual(16);
    for (const p of news) {
      const src = read(p);
      expect(src, p).toMatch(/import \w+List from '#lib\/lists\//);
      expect(src, p).toContain('<FormDrawer');
    }
  });
  it('CreateForm 은 드로어 안이면 아래 줄을 드로어 바닥에 넘긴다', () => {
    const src = read('lib/forms/CreateForm.svelte');
    expect(src).toContain('drawer.footer');
    expect(src).toContain('form={fid}');
  });
});

describe('상세 머리 메타 줄', () => {
  it('DetailHeader · ResourceFrame 이 meta 를 받는다', () => {
    expect(read('lib/ui/DetailHeader.svelte')).toContain('meta?: readonly { label: string; value: string; mono?: boolean }[]');
    const frame = read('lib/detail/ResourceFrame.svelte');
    expect(frame).toContain('meta?: readonly');
    expect(frame).toContain('{meta}');
  });
});
