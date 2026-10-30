<script lang="ts">
  /** 적용 대기 — 위는 영향과 적용, 아래는 리비전 롤백 (시안). */
  import { getContext } from 'svelte';
  import PendingImpact from '#lib/ops/PendingImpact.svelte';
  import RevisionRollback from '#lib/ops/RevisionRollback.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
</script>

<div class="pend">
  <PendingImpact />
  {#if desk.live}<RevisionRollback />{/if}
</div>

<style>
  .pend { display: flex; flex-direction: column; gap: 24px; max-width: 960px; }
</style>
