<script lang="ts">
  /** 설정 탭 — 항목의 **모든 칸**. 리소스마다 화면을 따로 짜지 않는다(`flattenFields`). */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { flattenFields, itemOf, type ResourceKind } from '@web/resources';
  import type { createDesk } from '#lib/desk.svelte.ts';

  let { kind }: { kind: ResourceKind } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const item = $derived(itemOf(desk.model, kind, key));
  const fields = $derived(item === undefined ? [] : flattenFields(item));
</script>

{#if item !== undefined}
  <dl class="d-dl">
    {#each fields as f (f.path)}
      <dt>{f.path}</dt><dd>{f.value}</dd>
    {/each}
  </dl>
  <details>
    <summary class="d-note">전체 정의 (head 모델, JSON)</summary>
    <pre class="d-pre">{JSON.stringify(item, null, 2)}</pre>
  </details>
{/if}
