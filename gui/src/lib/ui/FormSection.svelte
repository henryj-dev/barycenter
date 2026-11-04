<script lang="ts">
  /**
   * 폼 구획 — 제목 아래 줄 하나, 그 아래 라벨·입력 2열(`FormRow` 들).
   * `stack` 이면 라벨이 입력 위에 온다 — 로그인 카드 · 대화상자처럼 좁은 자리용.
   */
  import type { Snippet } from 'svelte';
  import { formLayout } from './form-layout.ts';
  let { title, hint, stack = false, children }: { title?: string; hint?: string; stack?: boolean; children: Snippet } = $props();
  /** 드로어 · 인라인 수정 안이면 콘솔 격자(150px · 480px). */
  const compact = formLayout() === 'compact';
</script>

<section class="fs" class:compact>
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
  /* 콘솔 `fieldsFor` 마크업: 구획 제목 아래 10px, 줄 사이 10px, 라벨 150px, 칸 사이 16px. */
  .compact h3 { margin-bottom: 10px; }
  .compact .grid:not(.stack) { grid-template-columns: 150px minmax(0, 480px); gap: 10px 16px; }
  @media (max-width: 720px) { .grid { grid-template-columns: minmax(0, 1fr); gap: 6px; } }
</style>
