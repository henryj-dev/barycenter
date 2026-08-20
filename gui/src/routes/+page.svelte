<script lang="ts">
  import { getContext } from 'svelte';
  import Impact from '$lib/Impact.svelte';
  import type { createDesk } from '$lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
</script>

{#if desk.view}
  <Impact view={desk.view} applying={desk.applying} apply={() => { void desk.apply(); }} />
{:else if desk.live}
  <p class="empty">커밋됐지만 적용되지 않은 plan 이 없다. <code>bary import</code> 또는 <code>changeset commit</code> 뒤에 여기로 온다.</p>
{/if}

<style>
  .empty { color: var(--mute); }
  .empty code { font-family: var(--data); font-size: 0.85em; }
</style>
