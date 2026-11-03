<script lang="ts">
  /**
   * 설정 쓰기 자리. 전역에서 지역을 고르기 전에만 그리지 않는다. 고른 뒤에는 쓰기가 그 지역으로 간다(설계 §1.1) —
   * 보는 사람의 자격으로 중계하고, 권한은 지역이 판정한다(`src/global/relay.ts`).
   *
   * **연락 없는 지역에는 쓰는 자리를 안 그린다** (시안 `roMsg`). 그 자리에 사유와 「이 지역에서 열기 ↗」 를 둔다.
   * `target` 이면 쓰는 자리 위에 「쓸 지역」 한 줄을 둔다(시안 드로어 머리의 `wreg`). 지역은 하나만 본다 —
   * 다른 지역에 쓰려면 지역 화면에서 그 지역을 고른다.
   */
  import { getContext, type Snippet } from 'svelte';
  import { LOST_MESSAGE, type Scope } from './scope.svelte.ts';

  let { children, target = false }: { children: Snippet; target?: boolean } = $props();
  const scope = getContext<Scope | undefined>('scope');
  const region = $derived(scope?.mode === 'global' ? scope.region : undefined);
</script>

{#if scope === undefined || !scope.readOnly}
  {#if region !== undefined && scope?.lost === true}
    <p class="elsewhere" role="status">
      <span class="lost">✕ {LOST_MESSAGE}</span>
      <a href={region.gui} target="_blank" rel="noopener">이 지역에서 열기 ↗</a>
    </p>
  {:else}
    {#if target && region !== undefined}
      <div class="wreg">쓸 지역 <code>{region.name}</code> <a href="/regions">다른 지역 고르기</a></div>
    {/if}
    {@render children()}
  {/if}
{:else if scope.region !== undefined}
  <p class="elsewhere">
    전역 화면은 읽기만 해요 —
    <a href={scope.region.gui} target="_blank" rel="noopener">{scope.region.name} 에서 편집</a>
  </p>
{/if}

<style>
  .elsewhere { margin: 16px 0; font: var(--t-small); color: var(--tx2); display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .elsewhere a { color: var(--accent); }
  .lost { color: var(--danger); }
  .wreg { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; font: var(--t-small); color: var(--tx2); }
  .wreg code { font-family: var(--mono); color: var(--tx); }
  .wreg a { color: var(--accent); margin-left: auto; }
</style>
