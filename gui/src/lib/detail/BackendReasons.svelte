<script lang="ts">
  /**
   * 「트래픽을 받지 않는 이유」 (시안) — 백엔드 분할 상세와 개요가 같이 쓴다.
   * 줄마다 아이콘 하나 · 한 문장. 다 맞으면 「모든 조건을 충족해요」 한 줄이다.
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { backendReasons } from './facts';

  let { backend }: { backend?: string } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(backend ?? page.params['key'] ?? '');
  const lines = $derived(backendReasons(desk, key));
  const blocked = $derived(lines.some((l) => l.tone !== 'ok'));
</script>

{#if lines.length > 0}
  <div class="why" role="group" aria-label="트래픽을 받지 않는 이유">
    <div class="t">트래픽을 받지 않는 이유</div>
    {#each lines as l, i (i)}
      <div class="l"><span class="i" style:color="var(--{l.tone})" aria-hidden="true">{l.icon}</span><span>{l.text}</span></div>
    {/each}
  </div>
{/if}

<style>
  .why {
    display: flex; flex-direction: column; gap: 6px; padding: 10px 12px;
    background: var(--bg-page); border: 1px solid var(--bd); border-radius: var(--r-md); font: var(--t-small);
  }
  .t { font: var(--t-cap); font-weight: 600; color: var(--tx2); }
  .l { display: flex; gap: 8px; }
  .i { flex: none; }
</style>
