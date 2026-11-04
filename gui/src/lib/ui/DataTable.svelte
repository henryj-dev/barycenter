<script lang="ts" module>
  import type { Tone } from './tone.ts';
  import type { Cell } from './cells.ts';

  export type Column<T> = {
    key: string;
    label: string;
    align?: 'left' | 'right';
    /**
     * 칸 값 — 시안 `cells()` 의 `m()` · `x()` · `b()` (`#lib/ui/cells.ts`). 주면 표가 시안 `cellMap` 규칙대로 그린다:
     * 고정폭은 `--mono` · `--tx`, 보통 글은 `--font` · `--tx2`, 배지는 `Badge`, 빈 값은 「—」.
     * 없으면 `cell` 스니펫 → `text` → `row[key]` 순서로 그린다.
     */
    value?: (row: T) => Cell;
    /** 값이 주소·이름·숫자면 고정폭(`--tx`). 아니면 보통 글꼴 · 흐린색(`--tx2`) — 시안 `cellMap`. `value` 가 있으면 무시한다. */
    mono?: boolean;
    /** 보조 정보(흐린 색). `mono` 칸을 흐리게 할 때만 쓴다. */
    muted?: boolean;
    /** 정렬 값. `true` 면 `value` 의 글로 정렬한다. 없으면 정렬하지 않는다. */
    sort?: ((row: T) => string | number) | true;
    /** 컬럼 메뉴에서 숨길 수 있는가. 첫 컬럼(이름)은 숨기지 않는다. 기본은 숨길 수 있다. */
    hideable?: boolean;
    /** 처음에 숨겨 둔다 — 「컬럼 ▾」 메뉴에서 켠다(시안에 없는 열을 시안 자리에 두는 방법). */
    hidden?: boolean;
    width?: string;
    /** `cell` 스니펫이 없을 때 쓰는 글. */
    text?: (row: T) => string;
  };

  export type FilterChip<T> = { key: string; label: string; tone: Tone; icon?: string; match: (row: T) => boolean };
</script>

<script lang="ts" generics="T">
  /**
   * 데이터 테이블 — 디자인 시스템 §4 + 콘솔 목록 마크업(시안 `lpDisp` 블록).
   *
   * 도구 줄(검색 · 필터 칩 · 「N개」 · 「컬럼 ▾」) · 헤더(32px · 정렬 ▲▼) · 행(`--row-h`) · 고른 행(`--bg-sel` +
   * 왼쪽 `inset 3px 0 0 var(--accent)`) · 행 끝 ⋯ 메뉴 · 체크박스 열 · 일괄 작업 줄 · 고정 헤더 · 페이지 ·
   * 빈 상태(「검색 결과가 없어요.」 / 처음부터 없음) · 로딩 스켈레톤 · 오류.
   * 칸은 링크가 아니다 — 행을 누르면 고르고(분할 상세), Enter · 두 번 누르기로 상세를 연다(`onopen`).
   * 키보드: 표에 초점을 두고 ↑↓ 로 움직이고, Space 로 고르고, Enter 로 상세를 열고, Esc 로 선택을 푼다.
   *
   * 칸을 시안 방식으로 적으려면 열에 `value: (r) => m(r.name)` 처럼 `#lib/ui/cells.ts` 의 도우미를 준다.
   * 검색 `match` 를 안 주면 `value` · `text` 칸의 글을 모두 이어 찾는다.
   */
  import type { Snippet } from 'svelte';
  import Badge from './Badge.svelte';
  import Button from './Button.svelte';
  import Chip from './Chip.svelte';
  import Menu, { type MenuItem } from './Menu.svelte';
  import SearchInput from './SearchInput.svelte';
  import { cellStyle, cellText } from './cells.ts';

  let {
    rows, rowKey, columns, label, cell,
    search, chips = [], selectable = false, selected = $bindable([]), bulk, rowMenu, onopen,
    loading = false, error, onretry, emptyTitle = '항목이 없어요', emptyBody, emptyAction, toolbar, actions,
    pageSize = 0, minHeight = '240px', fill = false,
  }: {
    rows: readonly T[];
    rowKey: (row: T) => string;
    columns: readonly Column<T>[];
    /** 표 이름(스크린 리더). */
    label: string;
    cell?: Snippet<[T, Column<T>]>;
    /** 검색 칸. `match` 를 안 주면 `value` · `text` 칸의 글로 찾는다. 시안 자리표시 「이름·주소로 찾기」. */
    search?: { placeholder?: string; match?: (row: T, q: string) => boolean };
    chips?: readonly FilterChip<T>[];
    selectable?: boolean;
    selected?: string[];
    bulk?: Snippet<[string[]]>;
    rowMenu?: (row: T) => MenuItem[];
    onopen?: (row: T) => void;
    loading?: boolean;
    error?: string;
    onretry?: () => void;
    emptyTitle?: string;
    emptyBody?: string;
    emptyAction?: Snippet;
    /** 찾기 칸 · 칩 바로 뒤(빈 칸 앞)에 둘 것 — 시안 라우트 목록의 HTTP / 패스스루 분할 컨트롤 자리. */
    toolbar?: Snippet;
    /** 빈 칸 뒤 · 「N개」 앞(도구 줄 오른쪽)에 둘 단추 — 시안 밖 화면(소속 백엔드 넣기 · 지역 다시 묻기)용. */
    actions?: Snippet;
    pageSize?: number;
    minHeight?: string;
    /** 부모 높이를 채운다 — 도구 줄은 그대로, 표만 스크롤한다(분할 뷰 위쪽). */
    fill?: boolean;
  } = $props();

  let q = $state('');
  let activeChips = $state<string[]>([]);
  // 처음 숨김만 컬럼 정의에서 읽는다 — 그 뒤는 사람이 컬럼 메뉴로 바꾼다.
  // svelte-ignore state_referenced_locally
  let hidden = $state<Record<string, boolean>>(Object.fromEntries(columns.filter((c) => c.hidden).map((c) => [c.key, true])));
  let sortKey = $state('');
  let sortDir = $state<1 | -1>(1);
  let page = $state(0);
  let focusIdx = $state(0);
  let focused = $state(false);

  const visible = $derived(columns.filter((c, i) => i === 0 || !hidden[c.key]));
  /** 칸의 평문 — 검색 · 정렬에 쓴다. */
  const plain = (r: T, c: Column<T>): string => (c.value !== undefined ? cellText(c.value(r)) : c.text?.(r) ?? '');
  const sortOf = (c: Column<T>): ((row: T) => string | number) | undefined =>
    c.sort === true ? (r: T) => plain(r, c) : c.sort;
  const matches = (r: T, needle: string): boolean => {
    if (search === undefined || needle === '') return true;
    if (search.match !== undefined) return search.match(r, needle);
    return columns.some((c) => plain(r, c).toLowerCase().includes(needle));
  };
  const filtered = $derived.by(() => {
    const needle = q.trim().toLowerCase();
    const on = chips.filter((c) => activeChips.includes(c.key));
    let list = rows.filter((r) => matches(r, needle) && (on.length === 0 || on.some((c) => c.match(r))));
    const col = columns.find((c) => c.key === sortKey);
    const f = col === undefined ? undefined : sortOf(col);
    if (f !== undefined) {
      list = [...list].sort((a, b) => {
        const x = f(a), y = f(b);
        return (x === y ? 0 : x < y ? -1 : 1) * sortDir;
      });
    }
    return list;
  });
  const pages = $derived(pageSize > 0 ? Math.max(1, Math.ceil(filtered.length / pageSize)) : 1);
  const pageNow = $derived(Math.min(page, pages - 1));
  const shown = $derived(pageSize > 0 ? filtered.slice(pageNow * pageSize, pageNow * pageSize + pageSize) : filtered);
  const shownKeys = $derived(shown.map(rowKey));
  const allSel = $derived(shownKeys.length > 0 && shownKeys.every((k) => selected.includes(k)));
  const someSel = $derived(!allSel && shownKeys.some((k) => selected.includes(k)));
  const filtering = $derived(q.trim() !== '' || activeChips.length > 0);
  const shownState = $derived(error !== undefined ? 'error' : loading ? 'loading' : shown.length === 0 ? 'empty' : 'ok');

  const sortBy = (c: Column<T>): void => {
    if (c.sort === undefined) return;
    if (sortKey !== c.key) { sortKey = c.key; sortDir = 1; }
    else if (sortDir === 1) sortDir = -1;
    else { sortKey = ''; sortDir = 1; }
  };
  const toggle = (k: string): void => { selected = selected.includes(k) ? selected.filter((x) => x !== k) : [...selected, k]; };
  const toggleAll = (): void => {
    selected = allSel ? selected.filter((k) => !shownKeys.includes(k)) : [...new Set([...selected, ...shownKeys])];
  };
  const pick = (r: T, i: number): void => { selected = [rowKey(r)]; focusIdx = i; };
  const key = (e: KeyboardEvent): void => {
    if (shown.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); focusIdx = Math.min(shown.length - 1, focusIdx + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusIdx = Math.max(0, focusIdx - 1); }
    else if (e.key === ' ') { e.preventDefault(); const r = shown[focusIdx]; if (r !== undefined) (selectable ? toggle : (k: string) => { selected = [k]; })(rowKey(r)); }
    // 시안 `r.key`: Enter 는 그 행을 고르고 상세를 연다.
    else if (e.key === 'Enter') { const r = shown[focusIdx]; if (r !== undefined) { if (!selectable) selected = [rowKey(r)]; onopen?.(r); } }
    else if (e.key === 'Escape') { selected = []; }
  };
  const colItems = $derived(columns.slice(1).filter((c) => c.hideable !== false).map((c): MenuItem => ({
    label: c.label, checked: !hidden[c.key], onselect: () => { hidden = { ...hidden, [c.key]: !hidden[c.key] }; },
  })));
  /** 고른 행의 왼쪽 막대 + 초점 테두리(시안 `r.bar`). */
  const ring = (on: boolean, focus: boolean): string | undefined =>
    on && focus ? 'inset 3px 0 0 var(--accent), inset 0 0 0 2px var(--focus)' : on ? 'inset 3px 0 0 var(--accent)' : focus ? 'inset 0 0 0 2px var(--focus)' : undefined;
</script>

{#snippet cellView(c: Cell)}
  {#if c.kind === 'badge'}<Badge tone={c.tone} icon={c.icon} title={c.title}>{c.t}</Badge>
  {:else}{@const st = cellStyle(c)}<span title={c.title} style:font-family={st.font} style:color={st.color}>{c.t}</span>{/if}
{/snippet}

<div class="dt" class:fill>
  {#if search !== undefined || chips.length > 0 || toolbar || actions || colItems.length > 0}
    <div class="bar">
      {#if search !== undefined}
        <SearchInput bind:value={q} placeholder={search.placeholder ?? '이름·주소로 찾기'} oninput={() => { page = 0; }} />
      {/if}
      {#each chips as c (c.key)}
        <Chip tone={c.tone} icon={c.icon} pressed={activeChips.includes(c.key)}
          onclick={() => { activeChips = activeChips.includes(c.key) ? activeChips.filter((k) => k !== c.key) : [...activeChips, c.key]; page = 0; }}>{c.label}</Chip>
      {/each}
      {#if toolbar}{@render toolbar()}{/if}
      <div class="grow"></div>
      {#if actions}{@render actions()}{/if}
      <span class="count">{filtered.length}개</span>
      {#if colItems.length > 0}
        <Menu items={colItems} label="컬럼">
          {#snippet trigger({ open, toggle: t })}<Button size="sm" onclick={t} aria-expanded={open} aria-haspopup="menu">컬럼 ▾</Button>{/snippet}
        </Menu>
      {/if}
    </div>
  {/if}

  <!-- 한 행만 고르면 분할 상세(시안 행 고르기)다. 일괄 줄은 둘 이상 골랐을 때만. -->
  {#if selectable && selected.length > 1 && bulk}
    <div class="bulk">
      <strong>{selected.length}개를 골랐어요</strong>
      {@render bulk(selected)}
      <div class="grow"></div>
      <button type="button" class="unsel" onclick={() => { selected = []; }}>선택 해제</button>
    </div>
  {/if}

  {#if shownState === 'loading'}
    <div class="state skel" style:min-height={minHeight} role="status" aria-label="불러오는 중">
      {#each [90, 70, 85, 60, 80, 75] as w, i (i)}<div style:width="{w}%" style:animation-delay="{i * .12}s"></div>{/each}
    </div>
  {:else if shownState === 'error'}
    <div class="state" style:min-height={minHeight} role="alert">
      <div class="st-title err">✕ 목록을 불러오지 못했어요</div>
      <div class="st-body">{error}</div>
      {#if onretry}<div><Button onclick={onretry}>다시 불러와요</Button></div>{/if}
    </div>
  {:else if shownState === 'empty' && filtering}
    <!-- 시안 `emptyD`: 찾아도 없으면 한 줄. -->
    <div class="nohit">검색 결과가 없어요.</div>
  {:else if shownState === 'empty'}
    <div class="state" style:min-height={minHeight}>
      <div class="st-title">{emptyTitle}</div>
      {#if emptyBody}<div class="st-body">{emptyBody}</div>{/if}
      {#if emptyAction}<div>{@render emptyAction()}</div>{/if}
    </div>
  {:else}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div class="scroll" role="grid" aria-label={label} tabindex="0" style:min-height={fill ? undefined : minHeight}
      onkeydown={key} onfocus={() => { focused = true; }} onblur={() => { focused = false; }}>
      <table>
        <thead>
          <tr>
            {#if selectable}
              <th class="ck"><button type="button" class="cb" role="checkbox" aria-checked={allSel ? 'true' : someSel ? 'mixed' : 'false'}
                aria-label="전체 선택" data-on={allSel || someSel} onclick={toggleAll}>{allSel ? '✓' : someSel ? '–' : ''}</button></th>
            {/if}
            {#each visible as c (c.key)}
              <th style:text-align={c.align ?? 'left'} style:width={c.width}
                aria-sort={sortKey === c.key ? (sortDir === 1 ? 'ascending' : 'descending') : 'none'}>
                {#if c.sort}
                  <button type="button" class="sort" data-on={sortKey === c.key} onclick={() => sortBy(c)}>
                    {c.label} <span class="arrow">{sortKey === c.key ? (sortDir === 1 ? '▲' : '▼') : ''}</span>
                  </button>
                {:else}{c.label}{/if}
              </th>
            {/each}
            {#if rowMenu}<th class="mn"></th>{/if}
          </tr>
        </thead>
        <tbody>
          {#each shown as r, i (rowKey(r))}
            {@const k = rowKey(r)}
            {@const on = selected.includes(k)}
            <tr aria-selected={on} data-focus={focused && i === focusIdx} style:box-shadow={ring(on, focused && i === focusIdx)}
              onclick={() => pick(r, i)} ondblclick={() => onopen?.(r)}>
              {#if selectable}
                <td class="ck"><button type="button" class="cb" role="checkbox" aria-checked={on} aria-label="{k} 선택"
                  data-on={on} onclick={(e) => { e.stopPropagation(); toggle(k); }}>{on ? '✓' : ''}</button></td>
              {/if}
              {#each visible as c (c.key)}
                {#if c.value !== undefined}
                  <td style:text-align={c.align ?? 'left'}>{@render cellView(c.value(r))}</td>
                {:else}
                  <td class:mono={c.mono} class:muted={c.muted} style:text-align={c.align ?? 'left'}>
                    {#if cell}{@render cell(r, c)}{:else}{c.text?.(r) ?? String((r as Record<string, unknown>)[c.key] ?? '')}{/if}
                  </td>
                {/if}
              {/each}
              {#if rowMenu}
                <td class="mn" onclick={(e) => e.stopPropagation()}>
                  <Menu items={rowMenu(r)} label="{k} 작업">
                    {#snippet trigger({ open, toggle: t })}
                      <button type="button" class="dots" aria-label="{k} 작업" aria-haspopup="menu" aria-expanded={open} onclick={t}>⋯</button>
                    {/snippet}
                  </Menu>
                </td>
              {/if}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  {#if pageSize > 0 && shownState === 'ok' && pages > 1}
    <!-- 시안 §4 `pageLabel`: 「1–5 / 7 · 5개씩」. 한 페이지에 다 들어가면 줄을 안 그린다(콘솔 목록에는 페이지가 없다). -->
    <div class="pager">
      <span>{pageNow * pageSize + 1}–{pageNow * pageSize + shown.length} / {filtered.length} · {pageSize}개씩</span>
      <span class="pg">
        <button type="button" aria-label="이전" disabled={pageNow === 0} onclick={() => { page = pageNow - 1; }}>‹</button>
        {#each Array.from({ length: pages }, (_, i) => i) as p (p)}
          <button type="button" aria-current={p === pageNow ? 'page' : undefined} onclick={() => { page = p; }}>{p + 1}</button>
        {/each}
        <button type="button" aria-label="다음" disabled={pageNow >= pages - 1} onclick={() => { page = pageNow + 1; }}>›</button>
      </span>
    </div>
  {/if}
</div>

<style>
  /* 값은 시안 콘솔 목록(`lpDisp`)의 인라인 style 그대로다. 디자인 시스템 §4 견본과 다른 곳은 콘솔을 따른다. */
  .dt { background: var(--bg-panel); border: 1px solid var(--bd); border-radius: var(--r-lg); overflow: hidden; display: flex; flex-direction: column; min-height: 0; }
  .dt.fill { flex: 1; height: 100%; }
  .bar { flex: none; display: flex; gap: 8px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--bd); flex-wrap: wrap; }
  .grow { flex: 1; }
  .count { font-size: 12px; color: var(--tx3); white-space: nowrap; }
  .bulk {
    flex: none; display: flex; gap: 12px; align-items: center; padding: 8px 12px; background: var(--accent-bg);
    border-bottom: 1px solid var(--bd); font: var(--t-small); flex-wrap: wrap;
  }
  .bulk :global(.btn[data-size='sm']) { height: 24px; border-radius: var(--r-sm); background: var(--bg-panel); }
  .unsel { border: 0; background: transparent; color: var(--accent); font: 500 13px/1 var(--font); padding: 0; }
  .scroll { overflow: auto; outline: none; }
  .dt.fill .scroll { flex: 1 1 0; min-height: 0; }
  .scroll:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
  table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13px; }
  th {
    position: sticky; top: 0; z-index: 5; text-align: left; background: var(--bg-hover); border-bottom: 1px solid var(--bd);
    height: 32px; padding: 0 12px; font: 600 12px/16px var(--font); color: var(--tx2); white-space: nowrap;
  }
  .sort { border: 0; background: transparent; padding: 0; color: var(--tx2); font: inherit; }
  .sort[data-on='true'] { color: var(--tx); }
  .arrow { color: var(--accent); }
  /* 시안 td 에는 white-space 가 없다 — 긴 값은 줄을 바꿔 표가 화면 폭 안에 든다(오른쪽 열 · 지역 열이 잘리지 않는다). */
  /* 칸 색은 시안 `cellMap`: 고정폭은 --tx, 보통 글은 --tx2. */
  td { height: var(--row-h); padding: 0 12px; border-bottom: 1px solid var(--bd); color: var(--tx2); }
  td.mono { font-family: var(--mono); color: var(--tx); }
  td.muted { color: var(--tx2); }
  tbody tr { cursor: pointer; }
  tbody tr:hover { background-image: linear-gradient(var(--hov), var(--hov)); }
  tbody tr[aria-selected='true'] { background-color: var(--bg-sel); }
  .ck { width: 40px; }
  th.mn { width: 44px; padding: 0; }
  td.mn { padding: 0 6px; text-align: center; }
  .dots {
    width: 28px; height: 28px; border: 0; border-radius: var(--r-md); background: transparent; color: var(--tx2);
    font: 700 16px/1 var(--font); padding: 0;
  }
  .dots:hover { background-image: linear-gradient(var(--hov), var(--hov)); }
  .cb {
    display: inline-grid; place-items: center; width: 16px; height: 16px; padding: 0; vertical-align: middle;
    border-radius: var(--r-sm); border: 1px solid var(--bd-strong); background: var(--bg-input); color: var(--accent-fg);
    font-size: 11px; font-weight: 700;
  }
  .cb[data-on='true'] { border-color: var(--accent); background: var(--accent); }
  .state { display: grid; place-content: center; text-align: center; padding: 24px; }
  .st-title { font-weight: 600; }
  .st-title.err { color: var(--danger); }
  .st-body { color: var(--tx2); font-size: 13px; margin: 4px 0 12px; }
  .nohit { padding: 32px; text-align: center; color: var(--tx3); font-size: 13px; }
  .skel { display: flex; flex-direction: column; gap: 12px; padding: 12px 16px; place-content: start; text-align: left; }
  .skel div { height: 16px; border-radius: 3px; background: var(--bg-hover); animation: bc-pulse 1.2s ease-in-out infinite; }
  .pager {
    flex: none; display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; border-top: 1px solid var(--bd);
    font-size: 12px; color: var(--tx3); flex-wrap: wrap; gap: 8px;
  }
  .pg { display: flex; gap: 4px; align-items: center; }
  .pg button { padding: 3px 10px; border: 1px solid var(--bd); background: transparent; color: var(--tx2); border-radius: var(--r-sm); font: inherit; }
  .pg button[aria-current='page'] { border-color: var(--accent); background: var(--accent-bg); color: var(--accent); }
</style>
