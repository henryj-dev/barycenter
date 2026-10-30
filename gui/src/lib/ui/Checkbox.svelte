<script lang="ts">
  /** 체크박스 — 디자인 시스템 §3. 켜면 강조 색에 ✓. */
  import type { Snippet } from 'svelte';
  let { checked = $bindable(false), disabled = false, onchange, children }: {
    checked?: boolean; disabled?: boolean; onchange?: (v: boolean) => void; children?: Snippet;
  } = $props();
</script>

<button type="button" class="ck" role="checkbox" aria-checked={checked} {disabled}
  onclick={() => { checked = !checked; onchange?.(checked); }}>
  <span class="box" aria-hidden="true">{checked ? '✓' : ''}</span>{@render children?.()}
</button>

<style>
  .ck { display: inline-flex; gap: 8px; align-items: center; border: 0; background: transparent; color: var(--tx); font: 400 13px/18px var(--font); padding: 2px; }
  .ck:disabled { color: var(--tx3); }
  .box {
    width: 16px; height: 16px; border-radius: var(--r-sm); border: 1px solid var(--bd-strong); background: var(--bg-input);
    color: var(--accent-fg); display: grid; place-items: center; font-size: 11px; font-weight: 700; flex: none;
  }
  .ck[aria-checked='true'] .box { background: var(--accent); border-color: var(--accent); }
  .ck:disabled .box { border-color: var(--bd); }
</style>
