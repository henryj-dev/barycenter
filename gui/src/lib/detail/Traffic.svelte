<script lang="ts">
  /** 트래픽 경로 탭 — 들어온 요청이 라우트 → 풀 → 백엔드로 어떻게 가는가 (`trafficOf`). */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { RESOURCES, resourcePath, trafficOf, type ResourceKind } from '@web/resources';
  import type { createDesk } from '#lib/desk.svelte.ts';

  let { kind }: { kind: ResourceKind } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const healthOf = (b: string): string => desk.health.find((h) => h.backendKey === b)?.state ?? 'unknown';
  const lines = $derived(trafficOf(desk.model, { kind, key }, healthOf));
</script>

{#if lines.length === 0}
  <p class="d-empty">이 리소스로 들어오는 트래픽 경로가 없다.</p>
{:else}
  <ol class="d-list path">
    {#each lines as line, i (i)}
      <li>
        <span class="d-mono match">{line.match}</span>
        {#if line.route !== undefined && line.route.key !== key}
          <span class="d-note">{RESOURCES[line.route.kind].label}</span>
          <a class="d-mono" href={resourcePath(line.route.kind, line.route.key)}>{line.route.key}</a>
        {/if}
        <span class="arrow">→</span>
        {#if line.target.kind === 'pool'}
          {#if line.target.missing}
            <span class="d-warn d-mono">풀 {line.target.pool} — head 에 없다</span>
          {:else}
            <a class="d-mono" href={resourcePath('pool', line.target.pool)}>풀 {line.target.pool}</a>
            {#if line.target.backends.length === 0}
              <span class="d-warn">백엔드가 없다</span>
            {:else}
              <ul class="backends">
                {#each line.target.backends as b (b.key)}
                  <li data-health={b.health}>
                    <a class="d-mono" href={resourcePath('backend', b.key)}>{b.key}</a>
                    <span class="d-mono d-note">{b.target} · w{b.weight}</span>
                    <span class="h">{b.health}</span>
                  </li>
                {/each}
              </ul>
            {/if}
          {/if}
        {:else if line.target.kind === 'redirect'}
          <span class="d-mono">redirect {line.target.status} → {line.target.to}</span>
        {:else}
          <span class="d-warn">거절{line.target.status === undefined ? ' (연결을 끊는다)' : ` ${line.target.status}`}</span>
        {/if}
      </li>
    {/each}
  </ol>
  <p class="d-note">라우트는 우선순위 순서다. 엔진이 실제로 보는 순서(매치 클래스)는 <a class="d-link" href="/traffic/route/http">라우트</a> 화면이 정본이다.</p>
{/if}

<style>
  .match { min-width: 10rem; }
  .arrow { color: var(--mute); }
  .backends { list-style: none; margin: 0.3rem 0 0; padding: 0 0 0 1rem; width: 100%; }
  .backends li { display: flex; gap: 0.7rem; padding: 0.15rem 0; }
  .h { font-size: 0.75rem; color: var(--mute); }
  li[data-health='healthy'] .h { color: var(--moss); }
  li[data-health='unhealthy'] .h { color: var(--ember); }
</style>
