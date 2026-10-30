<script lang="ts" module>
  import type { Tone } from './Badge.svelte';

  export type Column<T> = {
    key: string;
    label: string;
    align?: 'left' | 'right';
    /** 값이 주소·이름·숫자면 고정폭. */
    mono?: boolean;
    /** 보조 정보(흐린 색). */
    muted?: boolean;
    /** 정렬 값. 없으면 정렬하지 않는다. */
    sort?: (row: T) => string | number;
    /** 컬럼 메뉴에서 숨길 수 있는가. 첫 컬럼(이름)은 숨기지 않는다. */
    hideable?: boolean;
    /** 처음에 숨겨 둔다. */
    hidden?: boolean;
    width?: string;
    /** `cell` 스니펫이 없을 때 쓰는 글. */
    text?: (row: T) => string;
  };

  export type FilterChip<T> = { key: string; label: string; tone: Tone; icon?: string; match: (row: T) => boolean };
</script>

<script lang="ts" generics="T">
  /**
   * 데이터 테이블 — 디자인 시스템 §4 (가장 중요한 컴포넌트).
   *
   * 필터 바(검색 + 칩) · 컬럼 보이기 · 정렬(오름 → 내림 → 해제) · 행 선택(행을 누르면 하나, 체크박스는 여럿) ·
   * 일괄 작업 줄 · 행 끝 ⋯ 메뉴 · 고정 헤더 · 페이지 · 빈 상태 · 로딩 스켈레톤 · 오류.
   * 키보드: 표에 초점을 두고 ↑↓ 로 움직이고, Space 로 고르고, Enter 로 상세를 열고, Esc 로 선택을 푼다.
   */
  import type { Snippet } from 'svelte';
  import Button from './Button.svelte';
  import Chip from './Chip.svelte';
  import Menu, { type MenuItem } from './Menu.svelte';

  let {
    rows, rowKey, columns, label, cell,
    search, chips = [], selectable = false, selected = $bindable([]), bulk, rowMenu, onopen,
    loading = false, error, onretry, emptyTitle = '항목이 없어요', emptyBody, emptyAction, toolbar,
    pageSize = 0, minHeight = '240px',
  }: {
    rows: readonly T[];
    rowKey: (row: T) => string;
    columns: readonly Column<T>[];
    /** 표 이름(스크린 리더). */
    label: string;
    cell?: Snippet<[T, Column<T>]>;
    search?: { placeholder: string; match: (row: T, q: string) => boolean };
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
    toolbar?: Snippet;
    pageSize?: number;
    minHeight?: string;
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
  const filtered = $derived.by(() => {
    const needle = q.trim().toLowerCase();
    const on = chips.filter((c) => activeChips.includes(c.key));
    let list = rows.filter((r) => (needle === '' || search === undefined || search.match(r, needle))
      && (on.length === 0 || on.some((c) => c.match(r))));
    const col = columns.find((c) => c.key === sortKey);
    if (col?.sort !== undefined) {
      const f = col.sort;
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
    else if (e.key === 'Enter') { const r = shown[focusIdx]; if (r !== undefined) onopen?.(r); }
    else if (e.key === 'Escape') { selected = []; }
  };
  const colItems = $derived(columns.slice(1).filter((c) => c.hideable !== false).map((c): MenuItem => ({
    label: c.label, checked: !hidden[c.key], onselect: () => { hidden = { ...hidden, [c.key]: !hidden[c.key] }; },
  })));
</script>

<div class="dt">
  {#if search !== undefined || chips.length > 0 || toolbar || colItems.length > 0}
    <div class="bar">
      {#if search !== undefined}
        <div class="search">
          <span aria-hidden="true">⌕</span>
          <input aria-label="필터" placeholder={search.placeholder} bind:value={q} oninput={() => { page = 0; }} />
          {#if q !== ''}<button type="button" class="clr" aria-label="지우기" onclick={() => { q = ''; }}>✕</button>{/if}
        </div>
      {/if}
      {#each chips as c (c.key)}
        <Chip tone={c.tone} icon={c.icon} pressed={activeChips.includes(c.key)}
          onclick={() => { activeChips = activeChips.includes(c.key) ? activeChips.filter((k) => k !== c.key) : [...activeChips, c.key]; page = 0; }}>{c.label}</Chip>
      {/each}
      <div class="grow"></div>
      <span class="count">{filtering ? `${filtered.length} / ${rows.length}개` : `${rows.length}개`}</span>
      {#if toolbar}{@render toolbar()}{/if}
      {#if colItems.length > 0}
        <Menu items={colItems} label="컬럼">
          {#snippet trigger({ open, toggle: t })}<Button onclick={t} aria-expanded={open}>컬럼 ▾</Button>{/snippet}
        </Menu>
      {/if}
    </div>
  {/if}

  {#if selectable && selected.length > 0 && bulk}
    <div class="bulk">
      <strong>{selected.length}개를 골랐어요</strong>
      {@render bulk(selected)}
      <div class="grow"></div>
      <Button variant="text" onclick={() => { selected = []; }}>선택 해제</Button>
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
  {:else if shownState === 'empty'}
    <div class="state" style:min-height={minHeight}>
      {#if filtering}
        <div class="st-title">일치하는 항목이 없어요</div>
        <div class="st-body">필터를 바꾸거나 지워요.</div>
      {:else}
        <div class="st-title">{emptyTitle}</div>
        {#if emptyBody}<div class="st-body">{emptyBody}</div>{/if}
        {#if emptyAction}<div>{@render emptyAction()}</div>{/if}
      {/if}
    </div>
  {:else}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div class="scroll" role="grid" aria-label={label} tabindex="0" style:min-height={minHeight}
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
            <tr aria-selected={selected.includes(k)} data-focus={focused && i === focusIdx}
              onclick={() => pick(r, i)} ondblclick={() => onopen?.(r)}>
              {#if selectable}
                <td class="ck"><button type="button" class="cb" role="checkbox" aria-checked={selected.includes(k)} aria-label="{k} 선택"
                  data-on={selected.includes(k)} onclick={(e) => { e.stopPropagation(); toggle(k); }}>{selected.includes(k) ? '✓' : ''}</button></td>
              {/if}
              {#each visible as c, ci (c.key)}
                <td class:mono={c.mono} class:muted={c.muted} class:first={ci === 0} style:text-align={c.align ?? 'left'}>
                  {#if cell}{@render cell(r, c)}{:else}{c.text?.(r) ?? String((r as Record<string, unknown>)[c.key] ?? '')}{/if}
                </td>
              {/each}
              {#if rowMenu}
                <td class="mn" onclick={(e) => e.stopPropagation()}>
                  <Menu items={rowMenu(r)} label="{k} 작업">
                    {#snippet trigger({ open, toggle: t })}
                      <Button variant="icon" size="sm" label="{k} 작업" aria-haspopup="menu" aria-expanded={open} onclick={t}>⋯</Button>
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
    <div class="pager">
      <span>{pageNow * pageSize + 1}–{Math.min(filtered.length, (pageNow + 1) * pageSize)} / {filtered.length}개</span>
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
  .dt { background: var(--bg-panel); border: 1px solid var(--bd); border-radius: var(--r-lg); overflow: hidden; }
  .bar { display: flex; gap: 8px; align-items: center; padding: 10px 12px; border-bottom: 1px solid var(--bd); flex-wrap: wrap; }
  .search {
    display: flex; align-items: center; gap: 8px; height: 32px; width: 260px; max-width: 100%; padding: 0 10px;
    background: var(--bg-input); border: 1px solid var(--bd-strong); border-radius: var(--r-md); color: var(--tx3);
  }
  .search:focus-within { outline: 2px solid var(--focus); outline-offset: 0; }
  .search input { flex: 1; min-width: 0; border: 0; background: transparent; color: var(--tx); font: var(--t-small); outline: none; height: 28px; padding: 0; }
  .search input::placeholder { color: var(--tx3); }
  .clr { border: 0; background: transparent; color: var(--tx3); padding: 0 2px; }
  .grow { flex: 1; }
  .count { color: var(--tx3); font: var(--t-cap); }
  .bulk {
    display: flex; gap: 12px; align-items: center; padding: 8px 12px; background: var(--accent-bg);
    border-bottom: 1px solid var(--bd); font: var(--t-small); flex-wrap: wrap;
  }
  .scroll { overflow: auto; outline: none; }
  .scroll:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
  table { width: 100%; border-collapse: separate; border-spacing: 0; font: var(--t-small); }
  th {
    position: sticky; top: 0; z-index: var(--z-sticky); background: var(--bg-hover); border-bottom: 1px solid var(--bd);
    height: 36px; padding: 0 12px; font: 600 12px/16px var(--font); color: var(--tx2); white-space: nowrap;
  }
  .sort { border: 0; background: transparent; padding: 0; color: var(--tx2); font: inherit; }
  .sort[data-on='true'] { color: var(--tx); }
  .arrow { color: var(--accent); }
  td { height: var(--row-h); padding: 0 12px; border-bottom: 1px solid var(--bd); }
  tbody tr:last-child td { border-bottom: 0; }
  td.mono { font-family: var(--mono); }
  td.first { font-weight: 500; }
  td.muted { color: var(--tx2); }
  tbody tr { cursor: pointer; }
  tbody tr:hover { background-image: linear-gradient(var(--hov), var(--hov)); }
  tbody tr[aria-selected='true'] { background-color: var(--bg-sel); }
  tbody tr[data-focus='true'] { box-shadow: inset 0 0 0 2px var(--focus); }
  .ck { width: 40px; }
  .mn { width: 48px; padding: 0 8px; text-align: center; }
  .cb {
    display: inline-grid; place-items: center; width: 16px; height: 16px; padding: 0; vertical-align: middle;
    border-radius: var(--r-sm); border: 1px solid var(--bd-strong); background: var(--bg-input); color: var(--accent-fg);
    font-size: 11px; font-weight: 700;
  }
  .cb[data-on='true'] { border-color: var(--accent); background: var(--accent); }
  .state { display: grid; place-content: center; text-align: center; padding: 24px; gap: 4px; }
  .st-title { font-weight: 600; }
  .st-title.err { color: var(--danger); }
  .st-body { color: var(--tx2); font: var(--t-small); margin-bottom: 8px; }
  .skel { display: flex; flex-direction: column; gap: 12px; padding: 12px 16px; place-content: start; text-align: left; }
  .skel div { height: 16px; border-radius: 3px; background: var(--bg-hover); animation: bc-pulse 1.2s ease-in-out infinite; }
  .pager {
    display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; border-top: 1px solid var(--bd);
    font: var(--t-cap); color: var(--tx3); flex-wrap: wrap; gap: 8px;
  }
  .pg { display: flex; gap: 4px; }
  .pg button { padding: 3px 10px; border: 1px solid var(--bd); background: transparent; color: var(--tx2); border-radius: var(--r-sm); font: inherit; }
  .pg button[aria-current='page'] { border-color: var(--accent); background: var(--accent-bg); color: var(--accent); }
  .pg button:disabled { opacity: .5; }
</style>
