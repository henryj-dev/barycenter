<script lang="ts" module>
  export type MenuItem = {
    label: string;
    onselect?: () => void;
    href?: string;
    danger?: boolean;
    disabled?: boolean;
    /** 체크 항목(컬럼 보이기 등). undefined 면 일반 항목. */
    checked?: boolean;
    /** 이름 아래 설명 줄(시안 만들기 메뉴 `createItems` 의 `d` — 12px · --tx3). */
    description?: string;
  };
</script>

<script lang="ts">
  /**
   * 팝업 메뉴 — 행 메뉴(⋯) · 컬럼 메뉴 · 만들기 메뉴. 디자인 시스템 §4·§10.
   * 트리거는 `trigger` 스니펫이 그린다(받은 `toggle` 을 누르면 열고 닫는다). 밖을 누르거나 Esc 면 닫힌다.
   */
  import type { Snippet } from 'svelte';
  let { items, align = 'right', label, trigger, header }: {
    items: readonly MenuItem[];
    /** 항목 위의 머리(사용자 메뉴의 이름 · 역할). 고를 수 없다. */
    header?: { title: string; sub?: string };
    align?: 'left' | 'right';
    label: string;
    trigger: Snippet<[{ open: boolean; toggle: (e?: Event) => void }]>;
  } = $props();

  let open = $state(false);
  /** 설명 줄이 있는 메뉴는 시안 만들기 메뉴 모양이다 — 너비 260px, 항목은 이름 · 설명 두 줄(6px 10px). */
  const described = $derived(items.some((it) => it.description !== undefined));
  let root: HTMLSpanElement | undefined = $state();
  const toggle = (e?: Event): void => { e?.stopPropagation(); open = !open; };
  const outside = (e: MouseEvent): void => { if (open && root && !root.contains(e.target as Node)) open = false; };
  const choose = (it: MenuItem, e: Event): void => {
    e.stopPropagation();
    if (it.disabled) return;
    if (it.checked === undefined) open = false;
    it.onselect?.();
  };
</script>

<svelte:window onclick={outside} onkeydown={(e) => { if (open && e.key === 'Escape') open = false; }} />

{#snippet body(it: MenuItem)}
  {#if it.description !== undefined}<span class="l">{it.label}</span><span class="d">{it.description}</span>{:else}{it.label}{/if}
{/snippet}

<span class="menu" bind:this={root}>
  {@render trigger({ open, toggle })}
  {#if open}
    <div class="pop" role="menu" aria-label={label} data-align={align} data-described={described}>
      {#if header !== undefined}
        <div class="hd" role="presentation"><b>{header.title}</b>{#if header.sub}<span>{header.sub}</span>{/if}</div>
      {/if}
      {#each items as it (it.label)}
        {#if it.href !== undefined && !it.disabled}
          <a role="menuitem" class="item" href={it.href} data-danger={it.danger} onclick={() => { open = false; }}>{@render body(it)}</a>
        {:else}
          <button type="button" class="item" role={it.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
            aria-checked={it.checked} data-danger={it.danger} disabled={it.disabled} onclick={(e) => choose(it, e)}>
            {#if it.checked !== undefined}<span class="mark">{it.checked ? '✓' : ''}</span>{/if}{@render body(it)}
          </button>
        {/if}
      {/each}
    </div>
  {/if}
</span>

<style>
  .menu { position: relative; display: inline-block; }
  .pop {
    position: absolute; top: calc(100% + 4px); z-index: var(--z-drawer); min-width: 160px;
    background: var(--bg-panel); border: 1px solid var(--bd-strong); border-radius: var(--r-md);
    box-shadow: var(--sh-pop); padding: 4px; animation: bc-in var(--dur) var(--ease); text-align: left;
  }
  .pop[data-align='right'] { right: 0; }
  .pop[data-align='left'] { left: 0; }
  .item {
    width: 100%; display: flex; gap: 8px; align-items: center; padding: 6px 8px; border: 0;
    border-radius: var(--r-sm); background: transparent; color: var(--tx); font: 400 13px/18px var(--font);
    text-align: left; text-decoration: none; white-space: nowrap;
  }
  .item:not(:disabled):hover { background: var(--bg-hover); color: var(--tx); }
  .item[data-danger='true'] { color: var(--danger); }
  .item:disabled { color: var(--tx3); }
  .hd { display: grid; gap: 2px; padding: 6px 8px 8px; margin-bottom: 4px; border-bottom: 1px solid var(--bd); white-space: nowrap; }
  .hd b { font: 600 13px/18px var(--font); color: var(--tx); }
  .hd span { font: 400 12px/16px var(--font); color: var(--tx2); }
  .pop[data-described='true'] { width: 260px; }
  .pop[data-described='true'] .item { flex-direction: column; align-items: flex-start; gap: 0; padding: 6px 10px; white-space: normal; }
  .l { font-weight: 500; }
  .d { font-size: 12px; line-height: 16px; color: var(--tx3); }
  .mark { width: 14px; color: var(--accent); font-weight: 700; }
</style>
