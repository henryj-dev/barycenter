<script lang="ts">
  /**
   * 설정 쓰기 자리. 쓸 수 없으면(`scope.blocked`) 쓰는 자리를 안 그리고 `WriteNote` 로 까닭을 둔다:
   * 전역에서 지역을 고르기 전 · 고른 지역과 연락이 없음(시안 `roMsg`) · 이 노드가 팔로워.
   * 지역을 고른 뒤에는 쓰기가 그 지역으로 간다(설계 §1.1) — 보는 사람의 자격으로 중계하고, 권한은 지역이 판정한다(`src/global/relay.ts`).
   *
   * `target` 이면 쓰는 자리 위에 「쓸 지역」 한 줄을 둔다(시안 드로어 머리의 `wreg`). 지역은 하나만 본다 —
   * 다른 지역에 쓰려면 지역 화면에서 그 지역을 고른다.
   */
  import { getContext, type Snippet } from 'svelte';
  import type { Scope } from './scope.svelte.ts';
  import WriteNote from './WriteNote.svelte';

  let { children, target = false }: { children: Snippet; target?: boolean } = $props();
  const scope = getContext<Scope | undefined>('scope');
  const region = $derived(scope?.mode === 'global' ? scope.region : undefined);
</script>

{#if scope?.blocked === true}
  <div class="elsewhere"><WriteNote /></div>
{:else}
  {#if target && region !== undefined}
    <div class="wreg">쓸 지역 <code>{region.name}</code> <a href="/regions">다른 지역 고르기</a></div>
  {/if}
  {@render children()}
{/if}

<style>
  .elsewhere { margin: 16px 0; }
  .wreg { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; font: var(--t-small); color: var(--tx2); }
  .wreg code { font-family: var(--mono); color: var(--tx); }
  .wreg a { color: var(--accent); margin-left: auto; }
</style>
