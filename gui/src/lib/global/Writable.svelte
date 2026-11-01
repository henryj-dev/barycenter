<script lang="ts">
  /**
   * 설정 쓰기 자리. 전역에서 지역을 고르기 전에만 그리지 않는다. 고른 뒤에는 쓰기가 그 지역으로 간다(설계 §1.1).
   */
  import { getContext, type Snippet } from 'svelte';
  import type { Scope } from './scope.svelte.ts';

  let { children }: { children: Snippet } = $props();
  const scope = getContext<Scope | undefined>('scope');
</script>

{#if scope === undefined || !scope.readOnly}
  {@render children()}
{:else if scope.region !== undefined}
  <p class="elsewhere">
    전역 화면은 읽기만 한다 —
    <a href={scope.region.gui} target="_blank" rel="noopener">{scope.region.name} 에서 편집</a>
  </p>
{/if}

<style>
  .elsewhere { margin: 16px 0; font: var(--t-small); color: var(--tx2); }
  .elsewhere a { color: var(--accent); }
</style>
