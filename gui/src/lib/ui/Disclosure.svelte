<script lang="ts">
  /** 접는 구획 — 「고급 옵션 · 타임아웃, 본문 크기」. 기본은 접혀 있다. */
  import type { Snippet } from 'svelte';
  let { title, hint, open = false, children }: { title: string; hint?: string; open?: boolean; children: Snippet } = $props();
</script>

<details class="dc" {open}>
  <summary>{title}{#if hint}<span> · {hint}</span>{/if}</summary>
  <div class="body">{@render children()}</div>
</details>

<style>
  .dc { border: 1px solid var(--bd); border-radius: var(--r-md); background: var(--bg-page); }
  summary { padding: 10px 12px; cursor: pointer; font: 600 13px/18px var(--font); color: var(--tx2); }
  summary span { font-weight: 400; color: var(--tx3); }
  .body { padding: 4px 12px 14px; }
</style>
