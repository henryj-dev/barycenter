<script lang="ts">
  /**
   * 폼 구획 — 제목 아래 줄 하나, 그 아래 라벨·입력 2열(`FormRow` 들).
   * `stack` 이면 라벨이 입력 위에 온다 — 로그인 카드 · 대화상자처럼 좁은 자리용.
   */
  import type { Snippet } from 'svelte';
  let { title, hint, stack = false, children }: { title?: string; hint?: string; stack?: boolean; children: Snippet } = $props();
</script>

<section class="fs">
  {#if title}<h3>{title}{#if hint}<span>· {hint}</span>{/if}</h3>{/if}
  <div class="grid" class:stack>{@render children()}</div>
</section>

<style>
  h3 {
    margin: 0 0 14px; padding-bottom: 6px; border-bottom: 1px solid var(--bd);
    font: 600 12px/16px var(--font); letter-spacing: .4px; color: var(--tx2);
  }
  h3 span { font-weight: 400; color: var(--tx3); margin-left: 4px; }
  .grid { display: grid; grid-template-columns: 200px minmax(0, 560px); gap: 12px 24px; align-items: start; }
  .grid.stack { grid-template-columns: minmax(0, 1fr); gap: 6px; }
  @media (max-width: 720px) { .grid { grid-template-columns: minmax(0, 1fr); gap: 6px; } }
</style>
