<script lang="ts">
  /** 렌더 결과 — head 가 만드는 nginx.conf (시안 §8 코드 뷰어). 리비전 · 다이제스트 · 평면을 머리 줄에 쓴다. */
  import { getContext } from 'svelte';
  import { Badge, CodeViewer, FieldMessage, Skeleton } from '#lib/ui';
  import type { createDesk } from '#lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const v = $derived(desk.rendered);
</script>

{#if !desk.live}
  <Skeleton height="320px" label="연결하는 중" />
{:else if v.conf === ''}
  <FieldMessage>산출물이 없어요. 모델이 비면 conf 도 비어요.</FieldMessage>
{:else}
  <CodeViewer code={v.conf} maxHeight="calc(100vh - 240px)">
    {#snippet head()}
      <span class="meta">
        <code>nginx.conf</code>
        {#if v.revision !== undefined}<code class="dim">r{v.revision}</code>{/if}
        {#if v.digest !== undefined}<code class="dim" title={v.digest}>{v.digest.slice(0, 19)}…</code>{/if}
        {#each v.planes as p (p)}<Badge icon={null}>{p}</Badge>{/each}
      </span>
    {/snippet}
  </CodeViewer>
{/if}

<style>
  .meta { display: inline-flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  code { font-family: var(--mono); font-size: 12px; color: var(--tx); }
  .dim { color: var(--tx3); }
</style>
