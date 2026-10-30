<script lang="ts">
  /**
   * 설정 쓰기 자리. **전역 모드면 그리지 않는다** — 전역은 읽기 전용이고(설계 §1), 쓰기는 그 지역의 GUI 에서
   * 한다. 그 자리에 지역 GUI 로 가는 링크를 둔다.
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
