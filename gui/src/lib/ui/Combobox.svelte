<script lang="ts">
  /**
   * 콤보박스 — 검색해서 고른다 (디자인 시스템 §3). ↑↓ Enter Esc. 항목 오른쪽에 보조 글(예: 프로토콜 계열).
   * 목록에 없는 값을 받지 않는다 — 고른 것만 `value` 가 된다.
   */
  type Item = { value: string; hint?: string };
  let { value = $bindable(''), items, placeholder = '검색', label, width = '240px', disabled = false, onchange }: {
    value?: string;
    items: readonly Item[];
    placeholder?: string;
    label: string;
    width?: string;
    disabled?: boolean;
    onchange?: (v: string) => void;
  } = $props();

  let q = $state(value);
  let open = $state(false);
  let hi = $state(0);
  let root: HTMLDivElement | undefined = $state();
  const listId = `cb-${Math.random().toString(36).slice(2, 9)}`;
  const shown = $derived(items.filter((i) => i.value.toLowerCase().includes(q.trim().toLowerCase())));
  $effect(() => { if (!open) q = value; });

  const pick = (v: string): void => { value = v; q = v; open = false; onchange?.(v); };
  const key = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowDown') { e.preventDefault(); open = true; hi = Math.min(shown.length - 1, hi + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); hi = Math.max(0, hi - 1); }
    else if (e.key === 'Enter' && open) { e.preventDefault(); const it = shown[hi]; if (it) pick(it.value); }
    else if (e.key === 'Escape') { open = false; }
  };
  const outside = (e: MouseEvent): void => { if (open && root && !root.contains(e.target as Node)) open = false; };
</script>

<svelte:window onclick={outside} />

<div class="cb" bind:this={root} style:width>
  <div class="box" data-disabled={disabled}>
    <span class="icon" aria-hidden="true">⌕</span>
    <input
      role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-label={label} {placeholder} {disabled}
      bind:value={q} oninput={() => { open = true; hi = 0; }} onfocus={() => { open = true; }} onkeydown={key}
    />
  </div>
  {#if open}
    <div class="list" role="listbox" id={listId}>
      {#each shown as it, i (it.value)}
        <button type="button" role="option" aria-selected={it.value === value} data-hi={i === hi}
          onclick={() => pick(it.value)} onmouseenter={() => { hi = i; }}>
          <span class="v">{it.value}</span>{#if it.hint}<span class="h">{it.hint}</span>{/if}
        </button>
      {/each}
      <div class="count">{shown.length === 0 ? '맞는 항목이 없어요' : `${shown.length}개`}</div>
    </div>
  {/if}
</div>

<style>
  .cb { position: relative; display: inline-block; max-width: 100%; }
  .box {
    height: 32px; display: flex; align-items: center; gap: 8px; padding: 0 10px;
    background: var(--bg-input); border: 1px solid var(--bd-strong); border-radius: var(--r-md);
  }
  .box:hover { border-color: var(--tx3); }
  .box:focus-within { outline: 2px solid var(--focus); outline-offset: 0; }
  .box[data-disabled='true'] { background: var(--bg-hover); border-color: var(--bd); }
  .icon { color: var(--tx3); }
  input { flex: 1; min-width: 0; height: 28px; border: 0; background: transparent; color: var(--tx); font: 400 13px/1 var(--mono); outline: none; padding: 0; }
  input::placeholder { color: var(--tx3); }
  .list {
    position: absolute; z-index: var(--z-pop); left: 0; right: 0; top: 36px;
    background: var(--bg-panel); border: 1px solid var(--bd-strong); border-radius: var(--r-md);
    box-shadow: var(--sh-pop); padding: 4px; max-height: 280px; overflow-y: auto; animation: bc-in var(--dur) var(--ease);
  }
  button {
    width: 100%; padding: 6px 8px; border: 0; border-radius: var(--r-sm); background: transparent; color: var(--tx);
    display: flex; justify-content: space-between; text-align: left; font: 400 13px/18px var(--font);
  }
  button[data-hi='true'] { background: var(--bg-hover); }
  button[aria-selected='true'] { background: var(--bg-sel); }
  .v { font-family: var(--mono); }
  .h, .count { color: var(--tx3); font: var(--t-cap); }
  .count { padding: 6px 8px; }
</style>
