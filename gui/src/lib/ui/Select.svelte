<script lang="ts" generics="T extends string">
  /**
   * 셀렉트 — 디자인 시스템 §3. 고른 값에 ✓ 와 선택 배경. ↑↓ Enter Esc 로 다룬다. 밖을 누르면 닫힌다.
   */
  import { tick } from 'svelte';

  type Option = { value: T; label?: string; hint?: string; disabled?: boolean };
  let { value = $bindable(), options, placeholder = '고른다', label, disabled = false, width = '200px', mono = true, invalid = false, onchange }: {
    value?: T;
    options: readonly Option[];
    placeholder?: string;
    /** 스크린 리더용 이름 — 보이는 라벨이 따로 있으면 그것과 같게. */
    label?: string;
    disabled?: boolean;
    width?: string;
    mono?: boolean;
    invalid?: boolean;
    onchange?: (v: T) => void;
  } = $props();

  let open = $state(false);
  let hi = $state(0);
  let root: HTMLDivElement | undefined = $state();
  const current = $derived(options.find((o) => o.value === value));
  const listId = `sel-${Math.random().toString(36).slice(2, 9)}`;

  const pick = (o: Option): void => {
    if (o.disabled) return;
    value = o.value;
    open = false;
    onchange?.(o.value);
  };
  const toggle = async (): Promise<void> => {
    if (disabled) return;
    open = !open;
    if (open) {
      hi = Math.max(0, options.findIndex((o) => o.value === value));
      await tick();
    }
  };
  const key = (e: KeyboardEvent): void => {
    if (disabled) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) open = true; else hi = Math.min(options.length - 1, hi + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); hi = Math.max(0, hi - 1); }
    else if (e.key === 'Enter' && open) { e.preventDefault(); const o = options[hi]; if (o) pick(o); }
    else if (e.key === 'Escape') { open = false; }
  };
  const outside = (e: MouseEvent): void => { if (open && root && !root.contains(e.target as Node)) open = false; };
</script>

<svelte:window onclick={outside} />

<div class="sel" bind:this={root} style:width>
  <button
    type="button" class="trigger" class:mono role="combobox" aria-expanded={open} aria-controls={listId}
    aria-label={label} aria-invalid={invalid || undefined} {disabled} onclick={toggle} onkeydown={key}
  >
    <span class:ph={current === undefined}>{current?.label ?? current?.value ?? placeholder}</span>
    <span class="caret" aria-hidden="true">▼</span>
  </button>
  {#if open}
    <div class="list" role="listbox" id={listId}>
      {#each options as o, i (o.value)}
        <button
          type="button" role="option" class="opt" class:mono aria-selected={o.value === value}
          data-hi={i === hi} disabled={o.disabled} onclick={() => pick(o)} onmouseenter={() => { hi = i; }}
        >
          <span>{o.label ?? o.value}{#if o.hint}<span class="hint">{o.hint}</span>{/if}</span>
          {#if o.value === value}<span class="mark">✓</span>{/if}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .sel { position: relative; display: inline-block; max-width: 100%; }
  .trigger {
    width: 100%;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 0 10px;
    background: var(--bg-input);
    border: 1px solid var(--bd-strong);
    border-radius: var(--r-md);
    color: var(--tx);
    font: 400 13px/1 var(--font);
    text-align: left;
  }
  .mono { font-family: var(--mono) !important; }
  .trigger:not(:disabled):hover { border-color: var(--tx3); }
  .trigger[aria-invalid='true'] { border-color: var(--danger); }
  .trigger:disabled { background: var(--bg-hover); border-color: var(--bd); color: var(--tx3); }
  .ph { color: var(--tx3); }
  .caret { color: var(--tx3); font-size: 10px; }
  .list {
    position: absolute;
    z-index: var(--z-pop);
    left: 0; right: 0; top: 36px;
    background: var(--bg-panel);
    border: 1px solid var(--bd-strong);
    border-radius: var(--r-md);
    box-shadow: var(--sh-pop);
    padding: 4px;
    max-height: 280px;
    overflow-y: auto;
    animation: bc-in var(--dur) var(--ease);
  }
  .opt {
    width: 100%;
    display: flex;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 8px;
    border: 0;
    border-radius: var(--r-sm);
    background: transparent;
    color: var(--tx);
    font: 400 13px/18px var(--font);
    text-align: left;
  }
  .opt[data-hi='true'] { background: var(--bg-hover); }
  .opt[aria-selected='true'] { background: var(--bg-sel); }
  .opt:disabled { color: var(--tx3); }
  .hint { margin-left: 8px; color: var(--tx3); font: var(--t-cap); }
  .mark { color: var(--accent); }
</style>
