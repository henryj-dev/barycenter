<script lang="ts">
  /** 필터 칩 — 디자인 시스템 §4. 꺼져 있으면 점선, 켜면 그 톤의 색. 누르면 켜고 끈다. */
  import type { Snippet } from 'svelte';
  import { TONE_ICON, type Tone } from './Badge.svelte';
  let { pressed = $bindable(false), tone = 'neutral', icon, onclick, children }: {
    pressed?: boolean; tone?: Tone; icon?: string | null; onclick?: () => void; children: Snippet;
  } = $props();
</script>

<button type="button" class="chip" data-tone={tone} aria-pressed={pressed} onclick={() => { pressed = !pressed; onclick?.(); }}>
  {#if icon !== null}<span aria-hidden="true">{icon ?? TONE_ICON[tone]}</span>{/if}{@render children()}
</button>

<style>
  .chip {
    --c: var(--neutral); --cb: var(--neutral-bg);
    height: 24px; padding: 0 10px; display: inline-flex; align-items: center; gap: 6px;
    border-radius: 12px; border: 1px dashed var(--bd-strong); background: transparent; color: var(--tx2);
    font: 400 12px/1 var(--font);
  }
  .chip[data-tone='ok'] { --c: var(--ok); --cb: var(--ok-bg); }
  .chip[data-tone='warn'] { --c: var(--warn); --cb: var(--warn-bg); }
  .chip[data-tone='danger'] { --c: var(--danger); --cb: var(--danger-bg); }
  .chip[data-tone='info'] { --c: var(--info); --cb: var(--info-bg); }
  .chip[data-tone='pending'] { --c: var(--pending); --cb: var(--pending-bg); }
  .chip[data-tone='drain'] { --c: var(--drain); --cb: var(--drain-bg); }
  .chip[data-tone='accent'] { --c: var(--accent); --cb: var(--accent-bg); }
  .chip[aria-pressed='true'] { border-style: solid; border-color: var(--c); background: var(--cb); color: var(--c); }
</style>
