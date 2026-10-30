<script lang="ts">
  /**
   * 분할 뷰 — 디자인 시스템 §5 「분할 패턴(기본)」. 위는 목록, 아래는 고른 행의 상세·수정.
   * 막대를 끌거나 ↑↓ 로 높이를 조절한다. 아무것도 안 골랐으면 「행을 고르면 상세가 열려요」.
   */
  import type { Snippet } from 'svelte';

  let { top, detail, title, badges, open = false, onclose, height = '560px', initialTop = 260 }: {
    top: Snippet;
    detail: Snippet;
    title?: string;
    badges?: Snippet;
    /** 상세에 보일 행이 있는가. */
    open?: boolean;
    onclose?: () => void;
    height?: string;
    initialTop?: number;
  } = $props();

  // 처음 높이만 받는다 — 그 뒤는 사람이 막대로 바꾼다.
  // svelte-ignore state_referenced_locally
  let topH = $state(initialTop);
  let collapsed = $state(false);
  let root: HTMLDivElement | undefined = $state();
  const clamp = (v: number): number => Math.max(96, Math.min((root?.clientHeight ?? 600) - 96, v));

  const drag = (e: PointerEvent): void => {
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
  <div class="top" style:height={collapsed ? 'auto' : `${topH}px`} style:flex={collapsed ? '1' : 'none'}>{@render top()}</div>
  {#if !collapsed}
    <!-- 키보드로 움직이는 구분선(ARIA focusable separator)이라 초점을 받는다. -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_no_noninteractive_tabindex -->
    <div class="sep" role="separator" aria-orientation="horizontal" aria-label="높이 조절" aria-valuenow={topH}
      tabindex="0" onpointerdown={drag} onkeydown={key}><span></span></div>
  {/if}
  <div class="bottom" data-collapsed={collapsed}>
    <div class="bh">
      <strong>{open ? (title ?? '') : '상세'}</strong>
      {#if open && badges}{@render badges()}{/if}
      <div class="grow"></div>
      {#if open && onclose}<button type="button" onclick={onclose}>선택 해제</button>{/if}
      <button type="button" aria-label={collapsed ? '상세 펼치기' : '상세 접기'} onclick={() => { collapsed = !collapsed; }}>{collapsed ? '▴' : '▾'}</button>
    </div>
    {#if !collapsed}
      {#if open}<div class="body">{@render detail()}</div>{:else}<div class="none">행을 고르면 상세가 열려요.</div>{/if}
    {/if}
  </div>
</div>

<style>
  .split { border: 1px solid var(--bd); border-radius: var(--r-lg); background: var(--bg-panel); display: flex; flex-direction: column; overflow: hidden; }
  .top { overflow: auto; min-height: 0; }
  .top :global(.dt) { border: 0; border-radius: 0; }
  .sep {
    flex: none; height: 12px; display: flex; align-items: center; justify-content: center; cursor: row-resize;
    background: var(--bg-hover); border-top: 1px solid var(--bd-strong); border-bottom: 1px solid var(--bd); touch-action: none;
  }
  .sep span { width: 36px; height: 4px; border-radius: 2px; background: var(--tx3); }
  .bottom { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  .bottom[data-collapsed='true'] { flex: none; border-top: 1px solid var(--bd-strong); }
  .bh { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--bd); }
  .bh strong { font: 600 13px/18px var(--mono); }
  .grow { flex: 1; }
  .bh button { border: 0; background: transparent; color: var(--tx2); font: 500 12px/1 var(--font); }
  .body { padding: 12px; overflow: auto; flex: 1; }
  .none { flex: 1; display: grid; place-items: center; color: var(--tx3); font: var(--t-small); padding: 12px; text-align: center; }
</style>
