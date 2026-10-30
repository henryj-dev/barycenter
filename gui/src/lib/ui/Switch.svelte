<script lang="ts">
  /** 스위치 — 디자인 시스템 §3. 바로 켜고 끄는 것(설정 저장과 같은 결정)에 쓴다. */
  import type { Snippet } from 'svelte';
  let { checked = $bindable(false), disabled = false, onchange, children }: {
    checked?: boolean; disabled?: boolean; onchange?: (v: boolean) => void; children?: Snippet;
  } = $props();
</script>

<button type="button" class="sw" role="switch" aria-checked={checked} {disabled}
  onclick={() => { checked = !checked; onchange?.(checked); }}>
  <span class="track" aria-hidden="true"><span class="knob"></span></span>{@render children?.()}
</button>

<style>
  .sw { display: inline-flex; gap: 8px; align-items: center; border: 0; background: transparent; color: var(--tx); font: 400 13px/18px var(--font); padding: 2px; }
  .sw:disabled { color: var(--tx3); opacity: .7; }
  .track { width: 32px; height: 18px; border-radius: 9px; background: var(--bd-strong); position: relative; transition: background var(--dur) var(--ease); flex: none; }
  .knob { position: absolute; left: 2px; top: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--bg-panel); transition: left var(--dur) var(--ease); }
  .sw[aria-checked='true'] .track { background: var(--accent); }
  .sw[aria-checked='true'] .knob { left: 16px; background: var(--accent-fg); }
</style>
