<script lang="ts">
  /**
   * 전체 합산 목록 위의 알림 — 행이 빠졌거나 아직 안 온 지역마다 한 줄(시안 「○ <지역> 연락 없음 — 이 지역의 행은 빠졌어요」).
   * 연락 없는 지역의 행은 지어내지 않는다(§2.4). 모두 붙어 있으면 아무것도 안 그린다.
   */
  import type { RegionNotice } from './aggregate.ts';

  let { notices }: { notices: readonly RegionNotice[] } = $props();
</script>

{#if notices.length > 0}
  <ul class="rn" role="status" aria-label="빠진 지역">
    {#each notices as n (n.region)}
      <li data-state={n.state}><span class="ic" aria-hidden="true">{n.icon}</span>{n.text}</li>
    {/each}
  </ul>
{/if}

<style>
  .rn { list-style: none; margin: 0 0 12px; padding: 0; display: flex; flex-direction: column; gap: 4px; font: var(--t-small); color: var(--tx2); }
  .ic { display: inline-block; width: 16px; color: var(--neutral); }
  li[data-state='rejected'] .ic { color: var(--danger); }
  li[data-state='loading'] .ic { color: var(--info); }
</style>
