<script lang="ts">
  /** 인증서의 ACME 탭 — 발급 의도와 주문 상태. */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { flattenFields, itemOf } from '@web/resources';
  import type { createDesk } from '#lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const item = $derived(itemOf(desk.model, 'certificate', key));
  const acme = $derived(item?.['acme'] as Record<string, unknown> | undefined);
  const orders = $derived(desk.acmeOrders.filter((o) => o['certificate'] === key));
</script>

{#if acme === undefined}
  <p class="d-empty">ACME 로 발급하는 인증서가 아니다 — 자료를 직접 넣었다.</p>
{:else}
  <dl class="d-dl">
    {#each flattenFields(acme) as f (f.path)}<dt>{f.path}</dt><dd>{f.value}</dd>{/each}
  </dl>
  <h3 class="d-h3">주문</h3>
  {#if orders.length === 0}
    <p class="d-empty">주문이 없다.</p>
  {:else}
    <ul class="d-list">
      {#each orders as o (o['id'])}
        <li><span class="d-mono">{String(o['id'])}</span><span>{String(o['state'])}</span></li>
      {/each}
    </ul>
  {/if}
{/if}
