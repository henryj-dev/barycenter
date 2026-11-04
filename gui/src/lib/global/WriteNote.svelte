<script lang="ts">
  /**
   * **왜 여기서 못 쓰는가** 한 줄 — 쓰기가 막혔을 때(`scope.blocked`) 쓰는 자리 대신 둔다. 막히지 않았으면 아무것도 안 그린다.
   *
   * - 전체 합산(전역에서 지역을 안 골랐다): 이 자리는 지역 하나에 쓰는 곳이라 지역을 골라 좁혀야 한다 + 지역 고르기.
   *   합산 목록은 이것을 안 쓴다 — 행마다 그 지역에 쓰고, 목록 위에는 `RegionNotices` 를 둔다(2026-11-04, §2.5).
   * - 고른 지역과 연락이 없다(시안 `roMsg`): 사유 + 「이 지역에서 열기 ↗」.
   * - 이 노드가 팔로워다: 「이 노드는 팔로워예요. 수정은 리더(<이름>)에서 해요.」 + 「리더에서 열기 ↗」(주소를 알 때).
   */
  import { getContext } from 'svelte';
  import { LOST_MESSAGE, followerMessage, type Scope } from './scope.svelte.ts';

  /** `spaced`: 아래 표와 띄운다(목록 위에 둘 때). */
  let { spaced = false }: { spaced?: boolean } = $props();
  const scope = getContext<Scope | undefined>('scope');
</script>

{#if scope?.blocked === true}
  {#if scope.mode === 'global' && scope.region === undefined}
    <p class="note" class:spaced role="status">전체 합산에서는 여기서 쓰지 않아요. 지역을 골라 좁혀 보면 그 지역에 써요. <a href="/regions">지역 고르기</a></p>
  {:else if scope.lost && scope.region !== undefined}
    <p class="note" class:spaced role="status">
      <span class="lost">✕ {LOST_MESSAGE}</span>
      <a href={scope.region.gui} target="_blank" rel="noopener">이 지역에서 열기 ↗</a>
    </p>
  {:else if scope.follower !== undefined}
    <p class="note" class:spaced role="status">
      <span>{followerMessage(scope.follower.leader)}</span>
      {#if scope.follower.gui !== undefined}<a href={scope.follower.gui} target="_blank" rel="noopener">리더에서 열기 ↗</a>{/if}
    </p>
  {/if}
{/if}

<style>
  .note { margin: 0; font: var(--t-small); color: var(--tx2); display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .note.spaced { margin-bottom: 12px; }
  .note a { color: var(--accent); }
  .lost { color: var(--danger); }
</style>
