<script lang="ts">
  /**
   * 패스스루 라우트 목록 — 시안 `page === 'routes'` 의 패스스루 세그먼트. 이름 · 리스너 · SNI · 우선순위 · 동작 · 평가 순서.
   * 복호화하지 않고 SNI 만 본다 — 경로 · 출발지 규칙 · 요청 헤더가 없다. 평가 순서는 우선순위 → 이름(`viewOfRoutes`)이다.
   * 행을 누르면 아래에 분할 상세가 열린다(`ListSplit`).
   */
  import { getContext } from 'svelte';
  import { goto } from '$app/navigation';
  import { itemOf, resourcePath } from '@web/resources';
  import { Badge, Button, DataTable, type Column, type MenuItem } from '#lib/ui';
  import { usePageActions } from '#lib/shell/page-actions.svelte.ts';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import WriteNote from '#lib/global/WriteNote.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import ListSplit from '#lib/detail/ListSplit.svelte';
  import DeleteConfirm from './DeleteConfirm.svelte';
  import PendingMark from './PendingMark.svelte';
  import RouteSegments from './RouteSegments.svelte';

  type Row = { key: string; listener: string; snis: string[]; priority: number; action: string; ord: number };
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  // 쓸 수 없으면(지역을 안 골랐다 · 팔로워 · 고른 지역과 연락 없음) 만들기 · 수정 · 삭제를 안 보인다.
  const ro = $derived(scope?.blocked === true);
  let del = $state<{ kind: 'passthroughRoute'; key: string } | undefined>();
  let selected = $state<string[]>([]);

  const rows = $derived<Row[]>(desk.routes.passthrough.map((r, i) => ({ key: r.key, listener: r.listener, snis: r.snis, priority: r.priority, action: r.action, ord: i + 1 })));
  /** 풀로 보내는 라우트의 풀 — 표의 사실(`viewOfRoutes`)에는 동작 종류만 있어서 모델에서 읽는다. */
  const poolText = (key: string): string => {
    const a = itemOf(desk.model, 'passthroughRoute', key)?.['action'] as { pool?: unknown } | undefined;
    return typeof a?.pool === 'string' ? `프록시 → ${a.pool}` : 'proxy';
  };
  const columns: Column<Row>[] = [
    { key: 'key', label: '이름', mono: true, sort: (r) => r.key },
    { key: 'listener', label: '리스너', mono: true, sort: (r) => r.listener },
    { key: 'snis', label: 'SNI', mono: true, sort: (r) => r.snis.join(' ') },
    { key: 'priority', label: '우선순위', mono: true, align: 'right', sort: (r) => r.priority },
    { key: 'action', label: '동작', mono: true, sort: (r) => r.action },
    { key: 'ord', label: '평가 순서', mono: true, align: 'right', sort: (r) => r.ord },
  ];
  const menu = (r: Row): MenuItem[] => [
    { label: '상세 페이지 열기', href: resourcePath('passthroughRoute', r.key) },
    ...(ro ? [] : [
      { label: '수정', href: resourcePath('passthroughRoute', r.key, 'settings') },
      { label: '삭제…', danger: true, onselect: () => { del = { kind: 'passthroughRoute', key: r.key }; } },
    ]),
  ];
  usePageActions(() => (ro ? undefined : create));
</script>

{#snippet create()}<Button variant="primary" href="/traffic/route/passthrough/new">＋ 만들기</Button>{/snippet}

<RouteSegments current="passthrough" />
{#snippet table()}
<WriteNote spaced />
<DataTable label="패스스루 라우트" {rows} rowKey={(r) => r.key} {columns} loading={!desk.live} bind:selected
  search={{ placeholder: '이름·SNI·리스너로 찾기', match: (r, q) => `${r.key} ${r.snis.join(' ')} ${r.listener}`.toLowerCase().includes(q) }}
  emptyTitle="패스스루 라우트가 없어요" emptyBody="SNI 로 TLS 연결을 복호화 없이 풀에 보내요."
  onopen={(r) => { void goto(resourcePath('passthroughRoute', r.key)); }} rowMenu={menu}>
  {#snippet cell(r, c)}
    {#if c.key === 'key'}<a href={resourcePath('passthroughRoute', r.key)}>{r.key}</a><PendingMark kind="passthroughRoute" key={r.key} />
    {:else if c.key === 'listener'}<a class="sub" href={resourcePath('listener', r.listener)}>{r.listener}</a>
    {:else if c.key === 'snis'}
      <span title={r.snis.length > 1 ? r.snis.join('\n') : undefined}>{r.snis[0] ?? '—'}{#if r.snis.length > 1}<span class="more"><Badge tone="neutral" icon={null}>+{r.snis.length - 1}</Badge></span>{/if}</span>
    {:else if c.key === 'action'}{#if r.action.startsWith('reject')}<Badge tone="danger" icon="✕">연결을 끊어요</Badge>{:else}{poolText(r.key)}{/if}
    {:else if c.key === 'ord'}#{r.ord}
    {:else}{String(r[c.key as keyof Row])}{/if}
  {/snippet}
</DataTable>
{/snippet}

<ListSplit kind="passthroughRoute" bind:selected {table} />
<DeleteConfirm bind:target={del} />

<style>
  .sub { color: var(--tx2); }
  .more { margin-left: 6px; }
</style>
