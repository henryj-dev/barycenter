<script lang="ts">
  /** 주소 집합 목록 — 이름(@) · 대역 수 · 출처 · 사용처. 리스너의 출발지 제한이 `@이름` 으로 참조한다(#114). */
  import { getContext } from 'svelte';
  import { goto } from '$app/navigation';
  import { itemsOf, relationsOf, resourcePath } from '@web/resources';
  import { Badge, Button, DataTable, type Column, type MenuItem } from '#lib/ui';
  import { usePageActions } from '#lib/shell/page-actions.svelte.ts';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import DeleteConfirm from './DeleteConfirm.svelte';

  type Row = { key: string; count: number; source: string; used: number };
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const ro = $derived(scope?.readOnly === true);
  let del = $state<{ kind: 'addressSet'; key: string } | undefined>();

  const rows = $derived<Row[]>(itemsOf(desk.model, 'addressSet').map((s) => {
    const key = String(s['key']);
    return {
      key, count: Array.isArray(s['cidrs']) ? s['cidrs'].length : 0,
      source: typeof s['source'] === 'string' ? s['source'] : '직접 입력',
      used: relationsOf(desk.model, { kind: 'addressSet', key }).usedBy.length,
    };
  }));
  const columns: Column<Row>[] = [
    { key: 'key', label: '이름', mono: true, sort: (r) => r.key },
    { key: 'count', label: '대역 수', mono: true, align: 'right', sort: (r) => r.count },
    { key: 'source', label: '출처', sort: (r) => r.source },
    { key: 'used', label: '사용처', mono: true, align: 'right', sort: (r) => r.used },
  ];
  const menu = (r: Row): MenuItem[] => [
    { label: '상세를 봐요', href: resourcePath('addressSet', r.key) },
    ...(ro ? [] : [
      { label: '수정해요', href: resourcePath('addressSet', r.key, 'settings') },
      { label: '삭제…', danger: true, onselect: () => { del = { kind: 'addressSet', key: r.key }; } },
    ]),
  ];
  usePageActions(() => (ro ? undefined : create));
</script>

{#snippet create()}<Button variant="primary" href="/traffic/address-set/new">＋ 주소 집합 만들기</Button>{/snippet}

<DataTable label="주소 집합 목록" {rows} rowKey={(r) => r.key} {columns} loading={!desk.live}
  emptyTitle="주소 집합이 없어요" emptyBody="CLI 의 bary address-set sync cloudflare 로도 만들어요."
  onopen={(r) => { void goto(resourcePath('addressSet', r.key)); }} rowMenu={menu}>
  {#snippet cell(r, c)}
    {#if c.key === 'key'}<a href={resourcePath('addressSet', r.key)}>@{r.key}</a>
    {:else if c.key === 'source'}{#if r.source === '직접 입력'}<span class="sub">직접 입력</span>{:else}<Badge tone="info" icon="↻">{r.source}</Badge>{/if}
    {:else}{String(r[c.key as keyof Row])}{/if}
  {/snippet}
</DataTable>
<DeleteConfirm bind:target={del} />

<style>.sub { color: var(--tx2); }</style>
