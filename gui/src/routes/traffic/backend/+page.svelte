<script lang="ts">
  /** 백엔드 목록 — 모든 풀의 백엔드를 한 표에. 풀 화면은 풀 단위로 묶어 보여 준다. */
  import { getContext } from 'svelte';
  import { itemsOf, resourcePath } from '@web/resources';
  import Writable from '#lib/global/Writable.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const rows = $derived(itemsOf(desk.model, 'backend').slice().sort((a, b) => String(a['key']).localeCompare(String(b['key']))));
  const healthOf = (b: string): string => desk.health.find((h) => h.backendKey === b)?.state ?? 'unknown';
</script>

{#if !desk.live}
  <p class="d-empty">연결하면 head 백엔드가 여기 온다.</p>
{:else}
  <Writable><p class="new"><a class="d-link" href="/traffic/backend/new">백엔드 넣기</a></p></Writable>
  {#if rows.length === 0}
    <p class="d-empty">백엔드가 없다.</p>
  {:else}
    <ul class="d-list">
      {#each rows as b (b['key'])}
        {@const k = String(b['key'])}
        <li>
          <a class="d-mono" href={resourcePath('backend', k)}>{k}</a>
          <a class="d-mono d-note" href={resourcePath('pool', String(b['pool']))}>풀 {String(b['pool'])}</a>
          <span class="d-mono d-note">{String(b['host'])}:{String(b['port'])} · w{String(b['weight'])}</span>
          <span class={healthOf(k) === 'healthy' ? 'd-ok' : healthOf(k) === 'unhealthy' ? 'd-warn' : 'd-note'}>{healthOf(k)}</span>
          {#if desk.traffic.get(k)?.receivingTraffic === false}<span class="d-warn">트래픽 없음</span>{/if}
        </li>
      {/each}
    </ul>
  {/if}
{/if}

<style>.new { text-align: right; margin: 0 0 0.5rem; }</style>
