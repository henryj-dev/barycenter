<script lang="ts">
  /** 패널 — 테두리·둥근 모서리 상자. 제목이 있으면 머리 줄을 그린다. 오른쪽 `actions`. */
  import type { Snippet } from 'svelte';
  let { title, sub, actions, padded = true, children }: {
    title?: string; sub?: string; actions?: Snippet; padded?: boolean; children: Snippet;
  } = $props();
</script>

<section class="card">
  {#if title || actions}
    <header>
      <div>{#if title}<h3>{title}</h3>{/if}{#if sub}<p>{sub}</p>{/if}</div>
      {#if actions}<div class="act">{@render actions()}</div>{/if}
    </header>
  {/if}
  <div class:pad={padded}>{@render children()}</div>
</section>

<style>
  .card { background: var(--bg-panel); border: 1px solid var(--bd); border-radius: var(--r-lg); overflow: hidden; min-width: 0; }
  header { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--bd); }
  h3 { margin: 0; font: 600 15px/22px var(--font); }
  p { margin: 2px 0 0; color: var(--tx3); font: var(--t-cap); }
  .act { display: flex; gap: 8px; align-items: center; }
  .pad { padding: 16px 20px; }
</style>
