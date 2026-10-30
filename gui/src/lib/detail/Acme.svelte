<script lang="ts">
  /** 인증서의 ACME — 발급 의도와 주문 상태. */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { flattenFields, itemOf } from '@web/resources';
  import { DataTable, DescriptionList, FieldMessage, type Column } from '#lib/ui';
  import type { createDesk } from '#lib/desk.svelte.ts';

  type Order = { id: string; state: string };
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const item = $derived(itemOf(desk.model, 'certificate', key));
  const acme = $derived(item?.['acme'] as Record<string, unknown> | undefined);
  const orders = $derived<Order[]>(desk.acmeOrders.filter((o) => o['certificate'] === key)
    .map((o) => ({ id: String(o['id']), state: String(o['state']) })));
  const columns: Column<Order>[] = [
    { key: 'id', label: '주문', mono: true, text: (r) => r.id },
    { key: 'state', label: '상태', mono: true, text: (r) => r.state, sort: (r) => r.state },
  ];
</script>

{#if acme === undefined}
  <FieldMessage>ACME 로 발급하는 인증서가 아니에요. 자료를 직접 넣었어요.</FieldMessage>
{:else}
  <DescriptionList labelWidth="160px" items={flattenFields(acme).map((f) => ({ label: f.path, value: f.value, mono: true }))} />
  <div class="orders">
    <DataTable rows={orders} rowKey={(r) => r.id} {columns} label="ACME 주문" emptyTitle="주문이 없어요" minHeight="0" />
  </div>
{/if}

<style>
  .orders { margin-top: 12px; }
</style>
