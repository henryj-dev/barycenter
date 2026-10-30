<script lang="ts">
  /** 풀 목록 — 시안 §5.3. 이름 · 프로토콜 계열 · 알고리즘 · 백엔드(정상 / 전체) · 헬스체크 · 업스트림 TLS. */
  import { getContext } from 'svelte';
  import { goto } from '$app/navigation';
  import { itemOf, resourcePath } from '@web/resources';
  import { Badge, Button, DataTable, type Column, type FilterChip, type MenuItem } from '#lib/ui';
  import { usePageActions } from '#lib/shell/page-actions.svelte.ts';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import DeleteConfirm from './DeleteConfirm.svelte';

  type Row = { key: string; cls: string; alg: string; total: number; healthy: number; unhealthy: number; hc: boolean; tls: boolean };
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const ro = $derived(scope?.readOnly === true);
  let del = $state<{ kind: 'pool'; key: string } | undefined>();

  const rows = $derived<Row[]>(desk.pools.rows.map((p) => {
    const m = itemOf(desk.model, 'pool', p.key);
    const tls = (m?.['upstreamTls'] as { enabled?: boolean } | undefined)?.enabled === true;
    return { key: p.key, cls: p.protocolClass, alg: p.algorithm, total: p.backends.length, healthy: p.healthy, unhealthy: p.unhealthy, hc: m?.['healthCheck'] !== undefined, tls };
  }));
  const columns: Column<Row>[] = [
    { key: 'key', label: '이름', mono: true, sort: (r) => r.key },
    { key: 'cls', label: '프로토콜 계열', mono: true, sort: (r) => r.cls },
    { key: 'alg', label: '알고리즘', mono: true, muted: true, sort: (r) => r.alg },
    { key: 'total', label: '백엔드 (정상 / 전체)', sort: (r) => r.healthy / Math.max(1, r.total) },
    { key: 'hc', label: '헬스체크', sort: (r) => (r.hc ? 1 : 0) },
    { key: 'tls', label: '업스트림 TLS', sort: (r) => (r.tls ? 1 : 0) },
  ];
  const chips: FilterChip<Row>[] = [
    { key: 'bad', label: '비정상 백엔드 있음', tone: 'danger', match: (r) => r.unhealthy > 0 },
    { key: 'empty', label: '백엔드 없음', tone: 'warn', match: (r) => r.total === 0 },
  ];
  const menu = (r: Row): MenuItem[] => [
    { label: '상세를 봐요', href: resourcePath('pool', r.key) },
    ...(ro ? [] : [
      { label: '백엔드를 더해요', href: `/traffic/backend/new?pool=${encodeURIComponent(r.key)}` },
      { label: '수정해요', href: resourcePath('pool', r.key, 'settings') },
      { label: '삭제…', danger: true, onselect: () => { del = { kind: 'pool', key: r.key }; } },
    ]),
  ];
  usePageActions(() => (ro ? undefined : create));
</script>

{#snippet create()}<Button variant="primary" href="/traffic/pool/new">＋ 풀 만들기</Button>{/snippet}

<DataTable label="풀 목록" {rows} rowKey={(r) => r.key} {columns} {chips} loading={!desk.live}
  search={{ placeholder: '이름·알고리즘으로 찾기', match: (r, q) => `${r.key} ${r.alg} ${r.cls}`.toLowerCase().includes(q) }}
  emptyTitle="풀이 없어요" emptyBody="풀과 첫 백엔드를 같이 만들어요. 빈 풀은 저장되지 않아요."
  onopen={(r) => { void goto(resourcePath('pool', r.key)); }} rowMenu={menu}>
  {#snippet cell(r, c)}
    {#if c.key === 'key'}<a href={resourcePath('pool', r.key)}>{r.key}</a>
    {:else if c.key === 'total'}
      {#if r.total === 0}<Badge tone="warn">백엔드 없음</Badge>
      {:else}<Badge tone={r.unhealthy > 0 ? 'danger' : r.healthy === r.total ? 'ok' : 'info'}>{r.healthy} / {r.total}</Badge>{/if}
    {:else if c.key === 'hc'}{#if r.hc}<Badge tone="ok" icon="●">있음</Badge>{:else}<span class="muted">없음</span>{/if}
    {:else if c.key === 'tls'}{#if r.tls}<Badge tone="accent" icon="◆">켜짐</Badge>{:else}<span class="muted">꺼짐</span>{/if}
    {:else}{String(r[c.key as keyof Row])}{/if}
  {/snippet}
</DataTable>
<DeleteConfirm bind:target={del} />

<style>.muted { color: var(--tx3); }</style>
