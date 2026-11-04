<script lang="ts">
  /**
   * 전체 합산 목록 위의 알림 — 행이 빠졌거나 아직 안 온 지역마다 한 줄(시안 「○ <지역> 연락 없음 — 이 지역의 행은 빠졌어요」).
   * 연락 없는 지역의 행은 지어내지 않는다(§2.4). 모두 붙어 있으면 아무것도 안 그린다.
   */
  import type { RegionNotice } from './aggregate.ts';

  /** `strip`: 표 카드 맨 위 띠(목록). 끄면 카드 밖 한 줄(대시보드 · 기록). */
  let { notices, strip = true }: { notices: readonly RegionNotice[]; strip?: boolean } = $props();
</script>

{#if notices.length > 0}
  <ul class="rn" class:strip role="status" aria-label="빠진 지역">
    {#each notices as n (n.region)}
      <li data-state={n.state}><span class="ic" aria-hidden="true">{n.icon}</span>{n.text}</li>
    {/each}
  </ul>
{/if}

<style>
  /* 표 카드 맨 위 띠 — 시안 표 안 띠(일괄 줄)와 같은 여백 · 아래 선. */
  .rn { list-style: none; margin: 0 0 12px; padding: 0; display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--tx2); }
  .rn.strip { margin: 0; padding: 8px 12px; border-bottom: 1px solid var(--bd); }
  .ic { display: inline-block; width: 16px; color: var(--neutral); }
  li[data-state='rejected'] .ic { color: var(--danger); }
  li[data-state='loading'] .ic { color: var(--info); }
</style>
