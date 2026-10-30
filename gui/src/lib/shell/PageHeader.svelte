<script lang="ts">
  /** 페이지 머리 — 제목(22/30) · 한 줄 설명 · 오른쪽 버튼(만들기 등). 시안 「Console」 의 Page header. */
  import type { Snippet } from 'svelte';
  let { title, desc, actions }: { title: string; desc?: string; actions?: Snippet } = $props();
</script>

<div class="ph">
  <div class="tx"><h1>{title}</h1>{#if desc}<p>{desc}</p>{/if}</div>
  {#if actions}<div class="act">{@render actions()}</div>{/if}
</div>

<style>
  .ph { display: flex; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
  .tx { flex: 1; min-width: 240px; }
  h1 { margin: 0; font: var(--t-title); }
  p { margin: 2px 0 0; color: var(--tx2); font: var(--t-small); max-width: 640px; }
  .act { display: flex; gap: 8px; align-items: center; }
</style>
