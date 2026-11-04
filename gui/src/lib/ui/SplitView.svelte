<script lang="ts">
  /**
   * 분할 뷰 — 디자인 시스템 §5 「분할 패턴(기본)」 · 콘솔 목록 분할(시안 `sepD` · `hasSelBlock`).
   * 위는 목록, 아래는 고른 행의 상세·수정. 막대를 끌거나 막대에 초점을 두고 ↑↓ 로 높이를 24px 씩 바꾼다
   * (위쪽 최소 80px, 아래쪽 최소 130px — 시안 `dragStart` · `sepKey`).
   *
   * 아무것도 안 골랐을 때 두 가지:
   *   · 기본(디자인 시스템 §5) — 아래에 「행을 고르면 상세가 열려요.」
   *   · `hideEmpty`(콘솔 목록) — 막대와 아래를 안 그리고 목록이 높이를 다 쓴다.
   * 머리 줄: 이름(고정폭 13px) · `badges` · `meta`(지역 같은 흐린 고정폭 글) · 빈칸 · `actions` · 닫기(`closeLabel`) · ▾(`collapsible`).
   * 아래 본문은 스크롤만 한다 — 안쪽 여백은 부르는 쪽이 준다(인라인 수정의 아래 버튼 줄이 바닥에 붙도록).
   */
  import type { Snippet } from 'svelte';

  let {
    top, detail, title, badges, meta, actions, open = false, onclose, closeLabel = '선택 해제', collapsible = true,
    hideEmpty = false, emptyText = '행을 고르면 상세가 열려요.', height = '560px', initialTop = 240, sepLabel = '높이 조절',
  }: {
    top: Snippet;
    detail: Snippet;
    title?: string;
    badges?: Snippet;
    /** 이름 옆 흐린 고정폭 글(전체 합산의 지역 이름 — 시안 `selReg`). */
    meta?: string;
    /** 머리 줄 오른쪽 버튼(「URL로 다시 만들기」 · 「상세 페이지 ↗」 …). */
    actions?: Snippet;
    /** 상세에 보일 행이 있는가. */
    open?: boolean;
    onclose?: () => void;
    /** 콘솔 목록은 「닫기」, 디자인 시스템 §5 는 「선택 해제」. */
    closeLabel?: string;
    /** 「▾」 로 아래를 접는다(디자인 시스템 §5). 콘솔 목록에는 없다. */
    collapsible?: boolean;
    hideEmpty?: boolean;
    emptyText?: string;
    height?: string;
    initialTop?: number;
    /** 막대의 이름(스크린 리더). 콘솔 목록은 「목록·상세 높이 조절」. */
    sepLabel?: string;
  } = $props();

  // 처음 높이만 받는다 — 그 뒤는 사람이 막대로 바꾼다.
  // svelte-ignore state_referenced_locally
  let topH = $state(initialTop);
  let collapsed = $state(false);
  let root: HTMLDivElement | undefined = $state();
  const clamp = (v: number): number => Math.max(80, Math.min((root?.clientHeight ?? 600) - 130, v));
  const showBottom = $derived(open || !hideEmpty);

  const drag = (e: PointerEvent): void => {
    e.preventDefault();
    const start = e.clientY, from = topH;
    const move = (m: PointerEvent): void => { topH = clamp(from + m.clientY - start); };
    const up = (): void => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const key = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowUp') { e.preventDefault(); topH = clamp(topH - 24); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); topH = clamp(topH + 24); }
  };
</script>

<div class="split" bind:this={root} style:height>
  <div class="top" style:height={!showBottom || collapsed ? 'auto' : `${topH}px`} style:flex={!showBottom || collapsed ? '1 1 0' : 'none'}>{@render top()}</div>
  {#if showBottom && !collapsed}
    <!-- 키보드로 움직이는 구분선(ARIA focusable separator)이라 초점을 받는다. -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_no_noninteractive_tabindex -->
    <div class="sep" role="separator" aria-orientation="horizontal" aria-label={sepLabel} aria-valuenow={topH}
      tabindex="0" onpointerdown={drag} onkeydown={key}><span></span></div>
  {/if}
  {#if showBottom}
    <div class="bottom" data-collapsed={collapsed}>
      <div class="bh">
        <strong>{open ? (title ?? '') : '상세'}</strong>
        {#if open && badges}{@render badges()}{/if}
        {#if open && meta}<span class="meta">{meta}</span>{/if}
        <div class="grow"></div>
        {#if open && actions}{@render actions()}{/if}
        {#if open && onclose}<button type="button" class="hb" onclick={onclose}>{closeLabel}</button>{/if}
        {#if collapsible}
          <button type="button" class="hb" aria-label={collapsed ? '상세 펼치기' : '상세 접기'} onclick={() => { collapsed = !collapsed; }}>{collapsed ? '▴' : '▾'}</button>
        {/if}
      </div>
      {#if !collapsed}
        {#if open}<div class="body">{@render detail()}</div>{:else}<div class="none">{emptyText}</div>{/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  .split { border: 1px solid var(--bd); border-radius: var(--r-lg); background: var(--bg-panel); display: flex; flex-direction: column; overflow: hidden; }
  .top { overflow: auto; min-height: 0; display: flex; flex-direction: column; }
  .top :global(.dt) { border: 0; border-radius: 0; }
  .sep {
    flex: none; height: 12px; display: flex; align-items: center; justify-content: center; cursor: row-resize;
    background: var(--bg-hover); border-top: 1px solid var(--bd-strong); border-bottom: 1px solid var(--bd); touch-action: none;
  }
  .sep span { width: 36px; height: 4px; border-radius: 2px; background: var(--tx3); }
  .bottom { flex: 1 1 0; display: flex; flex-direction: column; min-height: 60px; }
  .bottom[data-collapsed='true'] { flex: none; min-height: 0; border-top: 1px solid var(--bd-strong); }
  .bh { flex: none; display: flex; align-items: center; gap: 10px; padding: 8px 16px; background: var(--bg-panel); border-bottom: 1px solid var(--bd); flex-wrap: wrap; }
  .bh strong { font: 600 13px/18px var(--mono); }
  .meta { font: 400 12px/16px var(--mono); color: var(--tx3); }
  .grow { flex: 1; }
  .hb { border: 0; background: transparent; color: var(--tx2); font: 400 12px/1 var(--font); padding: 0; }
  .body { flex: 1 1 0; min-height: 0; overflow: auto; display: flex; flex-direction: column; }
  .none { flex: 1; display: grid; place-items: center; color: var(--tx3); font: var(--t-small); padding: 12px; text-align: center; }
</style>
