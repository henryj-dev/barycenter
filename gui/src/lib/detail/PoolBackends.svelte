<script lang="ts">
  /** 풀의 백엔드 탭 — 소속 백엔드와 헬스·트래픽 수신. 드레인은 백엔드 상세에서 한다. */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { itemsOf, resourcePath } from '@web/resources';
  import Writable from '#lib/global/Writable.svelte';
  import { reasonLabels } from '@web/pools-view';
  import type { createDesk } from '#lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const backends = $derived(itemsOf(desk.model, 'backend').filter((b) => b['pool'] === key));
  const healthOf = (b: string): string => desk.health.find((h) => h.backendKey === b)?.state ?? 'unknown';
</script>

<Writable><p class="d-note"><a class="d-link" href="/traffic/backend/new?pool={encodeURIComponent(key)}">이 풀에 백엔드 넣기</a></p></Writable>
{#if backends.length === 0}
  <p class="d-warn">백엔드가 없다 — 이 풀로 가는 요청은 실패한다.</p>
{:else}
  <ul class="d-list">
    {#each backends as b (b['key'])}
      {@const k = String(b['key'])}
      <li>
        <a class="d-mono" href={resourcePath('backend', k)}>{k}</a>
        <span class="d-mono d-note">{String(b['host'])}:{String(b['port'])} · w{String(b['weight'])}</span>
        <span class={healthOf(k) === 'healthy' ? 'd-ok' : healthOf(k) === 'unhealthy' ? 'd-warn' : 'd-note'}>{healthOf(k)}</span>
        {#if desk.traffic.get(k)?.receivingTraffic === false}
          <span class="d-warn">트래픽 없음 — {reasonLabels(desk.traffic.get(k)?.reasons ?? []).join(' · ')}</span>
        {/if}
      </li>
    {/each}
  </ul>
{/if}
