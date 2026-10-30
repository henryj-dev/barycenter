<script lang="ts">
  /** 패스스루 라우트 목록 — 시안 §5.3. 이름 · 리스너 · SNI · 우선순위 · 동작. 복호화하지 않고 SNI 만 본다. */
  import { getContext } from 'svelte';
  import { goto } from '$app/navigation';
  import { resourcePath } from '@web/resources';
  import { Badge, Button, DataTable, type Column, type MenuItem } from '#lib/ui';
  import { usePageActions } from '#lib/shell/page-actions.svelte.ts';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import DeleteConfirm from './DeleteConfirm.svelte';
  import RouteSegments from './RouteSegments.svelte';

  type Row = { key: string; listener: string; snis: string; priority: number; action: string };
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const ro = $derived(scope?.readOnly === true);
  let del = $state<{ kind: 'passthroughRoute'; key: string } | undefined>();

  const rows = $derived<Row[]>(desk.routes.passthrough.map((r) => ({ key: r.key, listener: r.listener, snis: r.snis.join(', '), priority: r.priority, action: r.action })));
  const columns: Column<Row>[] = [
    { key: 'key', label: '이름', mono: true, sort: (r) => r.key },
    { key: 'listener', label: '리스너', mono: true, sort: (r) => r.listener },
    { key: 'snis', label: 'SNI', mono: true, sort: (r) => r.snis },
    { key: 'priority', label: '우선순위', mono: true, align: 'right', sort: (r) => r.priority },
    { key: 'action', label: '동작', mono: true, sort: (r) => r.action },
  ];
  const menu = (r: Row): MenuItem[] => [
    { label: '상세를 봐요', href: resourcePath('passthroughRoute', r.key) },
    ...(ro ? [] : [
      { label: '수정해요', href: resourcePath('passthroughRoute', r.key, 'settings') },
      { label: '삭제…', danger: true, onselect: () => { del = { kind: 'passthroughRoute', key: r.key }; } },
    ]),
  ];
  usePageActions(() => (ro ? undefined : create));
</script>

{#snippet create()}<Button variant="primary" href="/traffic/route/passthrough/new">＋ 패스스루 라우트 만들기</Button>{/snippet}

<RouteSegments current="passthrough" />
<DataTable label="패스스루 라우트" {rows} rowKey={(r) => r.key} {columns} loading={!desk.live}
  search={{ placeholder: '이름·SNI·리스너로 찾기', match: (r, q) => `${r.key} ${r.snis} ${r.listener}`.toLowerCase().includes(q) }}
  emptyTitle="패스스루 라우트가 없어요" emptyBody="SNI 로 TLS 연결을 복호화 없이 풀에 보내요."
  onopen={(r) => { void goto(resourcePath('passthroughRoute', r.key)); }} rowMenu={menu}>
  {#snippet cell(r, c)}
    {#if c.key === 'key'}<a href={resourcePath('passthroughRoute', r.key)}>{r.key}</a>
    {:else if c.key === 'listener'}<a class="sub" href={resourcePath('listener', r.listener)}>{r.listener}</a>
    {:else if c.key === 'action'}{#if r.action.startsWith('reject')}<Badge tone="danger" icon="⊘">{r.action}</Badge>{:else}{r.action}{/if}
    {:else}{String(r[c.key as keyof Row])}{/if}
  {/snippet}
</DataTable>
<DeleteConfirm bind:target={del} />

<style>.sub { color: var(--tx2); }</style>
