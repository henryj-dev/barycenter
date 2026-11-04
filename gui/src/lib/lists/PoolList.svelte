<script lang="ts">
  /**
   * 풀 목록 — 시안 §5.3. 이름 · 프로토콜 계열 · 알고리즘 · 백엔드(정상 / 전체) · 헬스체크 · 업스트림 TLS.
   * 행을 누르면 아래에 분할 상세가 열린다 — 요약과 소속 백엔드(시안).
   */
  import { getContext } from 'svelte';
  import { goto } from '$app/navigation';
  import { itemOf, resourcePath } from '@web/resources';
  import { Badge, Button, DataTable, type Column, type FilterChip, type MenuItem } from '#lib/ui';
  import { usePageActions } from '#lib/shell/page-actions.svelte.ts';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import WriteNote from '#lib/global/WriteNote.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import ListSplit from '#lib/detail/ListSplit.svelte';
  import { healthCheckText, poolMark, type Mark } from '#lib/detail/facts';
  import DeleteConfirm from './DeleteConfirm.svelte';
  import { listState } from './list-state';

  type Row = { key: string; cls: string; alg: string; total: number; healthy: number; unhealthy: number; mark: Mark; hc: string; tls: boolean };
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  // 쓸 수 없으면(지역을 안 골랐다 · 팔로워 · 고른 지역과 연락 없음) 만들기 · 수정 · 삭제를 안 보인다.
  const ro = $derived(scope?.blocked === true);
  let del = $state<{ kind: 'pool'; key: string } | undefined>();
  let selected = $state<string[]>([]);

  const rows = $derived<Row[]>(desk.pools.rows.map((p) => {
    const m = itemOf(desk.model, 'pool', p.key);
    const tls = (m?.['upstreamTls'] as { enabled?: boolean } | undefined)?.enabled === true;
    return {
      key: p.key, cls: p.protocolClass.toUpperCase(), alg: p.algorithm, total: p.backends.length, healthy: p.healthy, unhealthy: p.unhealthy,
      mark: poolMark(desk, p.key), hc: healthCheckText(m), tls,
    };
  }));
  const columns: Column<Row>[] = [
    { key: 'key', label: '이름', mono: true, sort: (r) => r.key },
    { key: 'cls', label: '프로토콜 계열', sort: (r) => r.cls },
    { key: 'alg', label: '알고리즘', mono: true, sort: (r) => r.alg },
    { key: 'total', label: '백엔드 (정상 / 전체)', sort: (r) => r.healthy / Math.max(1, r.total) },
    { key: 'hc', label: '헬스체크', mono: true, sort: (r) => r.hc },
    { key: 'tls', label: '업스트림 TLS', sort: (r) => (r.tls ? 1 : 0) },
  ];
  const chips: FilterChip<Row>[] = [
    { key: 'bad', label: '비정상 백엔드 있음', tone: 'danger', match: (r) => r.unhealthy > 0 },
    { key: 'empty', label: '백엔드 없음', tone: 'warn', match: (r) => r.total === 0 },
  ];
  const menu = (r: Row): MenuItem[] => [
    { label: '상세 페이지 열기', href: resourcePath('pool', r.key) },
    ...(ro ? [] : [
      { label: '백엔드 넣기', href: `/traffic/backend/new?pool=${encodeURIComponent(r.key)}` },
      { label: '수정', href: resourcePath('pool', r.key, 'settings') },
      { label: '삭제…', danger: true, onselect: () => { del = { kind: 'pool', key: r.key }; } },
    ]),
  ];
  usePageActions(() => (ro ? undefined : create));
</script>

{#snippet create()}<Button variant="primary" href="/traffic/pool/new">＋ 생성</Button>{/snippet}

{#snippet table()}
<WriteNote spaced />
<DataTable label="풀 목록" {rows} rowKey={(r) => r.key} {columns} {chips} {...listState(desk)} bind:selected
  search={{ placeholder: '이름·알고리즘으로 찾기', match: (r, q) => `${r.key} ${r.alg} ${r.cls}`.toLowerCase().includes(q) }}
  emptyTitle="풀이 없어요" emptyBody="풀과 첫 백엔드를 같이 만들어요. 빈 풀은 저장되지 않아요."
  onopen={(r) => { void goto(resourcePath('pool', r.key)); }} rowMenu={menu}>
  {#snippet cell(r, c)}
    {#if c.key === 'key'}<a href={resourcePath('pool', r.key)}>{r.key}</a>
    {:else if c.key === 'total'}<Badge tone={r.mark.tone} icon={r.mark.icon}>{r.mark.text}</Badge>
    {:else if c.key === 'tls'}{#if r.tls}<span>켜짐</span>{:else}<span class="muted">꺼짐</span>{/if}
    {:else}{String(r[c.key as keyof Row])}{/if}
  {/snippet}
</DataTable>
{/snippet}

<ListSplit kind="pool" bind:selected {table} />
<DeleteConfirm bind:target={del} />

<style>.muted { color: var(--tx3); }</style>
