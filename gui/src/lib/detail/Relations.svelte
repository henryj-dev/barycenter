<script lang="ts">
  /** 연결된 리소스 탭 — 이것이 쓰는 것 · 이것을 쓰는 것 (`relationsOf`). 풀이면 소속 백엔드도 여기 있다(시안). */
  import { getContext } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { RESOURCES, relationsOf, resourcePath, type ResourceKind } from '@web/resources';
  import { Badge, Card, DataTable, FieldMessage, type Column } from '#lib/ui';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import PoolBackends from './PoolBackends.svelte';

  type Row = { id: string; kind: ResourceKind; key: string; via: string; missing: boolean };
  let { kind }: { kind: ResourceKind } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const rel = $derived(relationsOf(desk.model, { kind, key }));
  /** 경유(필드 이름)가 종류 이름과 같으면 같은 말을 두 번 하지 않는다. */
  const via = (v: string, k: ResourceKind): string => (v === RESOURCES[k].label ? '' : v);
  const uses = $derived<Row[]>(rel.uses.map((e) => ({
    id: e.via + e.to.kind + e.to.key, kind: e.to.kind, key: e.to.key, via: via(e.via, e.to.kind), missing: e.missing === true,
  })));
  const usedBy = $derived<Row[]>(rel.usedBy.map((e) => ({
    id: e.via + e.from.kind + e.from.key, kind: e.from.kind, key: e.from.key, via: via(e.via, e.to.kind), missing: false,
  })));
  const columns: Column<Row>[] = [
    { key: 'kind', label: '종류', text: (r) => RESOURCES[r.kind].label, sort: (r) => RESOURCES[r.kind].label, width: '160px' },
    { key: 'key', label: '이름', mono: true, sort: (r) => r.key },
    { key: 'via', label: '경유', muted: true, text: (r) => r.via },
  ];
  const open = (r: Row): void => { if (!r.missing) void goto(resourcePath(r.kind, r.key)); };
</script>

{#snippet cell(r: Row, c: Column<Row>)}
  {#if c.key === 'key'}
    {#if r.missing}<Badge tone="danger">{r.key} — head 에 없어요</Badge>{:else}<a class="lnk" href={resourcePath(r.kind, r.key)}>{r.key}</a>{/if}
  {:else}{c.text?.(r) ?? ''}{/if}
{/snippet}

<div class="rel">
  {#if kind === 'pool'}<Card title="소속 백엔드"><PoolBackends /></Card>{/if}
  <Card title="이것이 쓰는 리소스" padded={false}>
    <DataTable rows={uses} rowKey={(r) => r.id} {columns} {cell} label="이것이 쓰는 리소스" onopen={open} emptyTitle="쓰는 리소스가 없어요" minHeight="0" />
  </Card>
  <Card title="이것을 쓰는 리소스" padded={false}>
    <DataTable rows={usedBy} rowKey={(r) => r.id} {columns} {cell} label="이것을 쓰는 리소스" onopen={open}
      emptyTitle="이것을 쓰는 리소스가 없어요" emptyBody="빼도 다른 리소스가 깨지지 않아요." minHeight="0" />
  </Card>
  {#if usedBy.length > 0}<FieldMessage>이것을 빼면 위 리소스의 저장(plan)이 막혀요. 먼저 그 참조를 바꿔요.</FieldMessage>{/if}
</div>

<style>
  .rel { display: flex; flex-direction: column; gap: 16px; max-width: 960px; }
  .lnk { color: var(--accent); font-family: var(--mono); text-decoration: none; }
  .lnk:hover { text-decoration: underline; }
</style>
