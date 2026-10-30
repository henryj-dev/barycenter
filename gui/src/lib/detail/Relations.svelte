<script lang="ts">
  /** 연결된 리소스 탭 — 이것이 쓰는 것 · 이것을 쓰는 것 (`relationsOf`). */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { RESOURCES, relationsOf, resourcePath, type ResourceKind } from '@web/resources';
  import type { createDesk } from '#lib/desk.svelte.ts';

  let { kind }: { kind: ResourceKind } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const rel = $derived(relationsOf(desk.model, { kind, key }));
</script>

<h3 class="d-h3">이것이 쓰는 리소스</h3>
{#if rel.uses.length === 0}
  <p class="d-empty">없다.</p>
{:else}
  <ul class="d-list">
    {#each rel.uses as e (e.via + e.to.kind + e.to.key)}
      <li>
        <span class="d-note">{e.via}</span>
        <span>{RESOURCES[e.to.kind].label}</span>
        {#if e.missing}
          <span class="d-mono d-warn">{e.to.key} — head 에 없다</span>
        {:else}
          <a class="d-mono" href={resourcePath(e.to.kind, e.to.key)}>{e.to.key}</a>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

<h3 class="d-h3">이것을 쓰는 리소스</h3>
{#if rel.usedBy.length === 0}
  <p class="d-empty">없다. 빼도 다른 리소스가 깨지지 않는다.</p>
{:else}
  <ul class="d-list">
    {#each rel.usedBy as e (e.via + e.from.kind + e.from.key)}
      <li>
        <span>{RESOURCES[e.from.kind].label}</span>
        <a class="d-mono" href={resourcePath(e.from.kind, e.from.key)}>{e.from.key}</a>
        <span class="d-note">{e.via}</span>
      </li>
    {/each}
  </ul>
  <p class="d-note">이것을 빼면 위 리소스의 저장(plan)이 막힌다. 먼저 그 참조를 바꾼다.</p>
{/if}
