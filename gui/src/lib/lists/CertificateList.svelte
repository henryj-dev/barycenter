<script lang="ts">
  /** 인증서 목록 — 시안 §5.3. 이름 · 도메인 · 발급(ACME / 업로드) · 만료(임박 강조) · 사용처. */
  import { getContext } from 'svelte';
  import { goto } from '$app/navigation';
  import { relationsOf, resourcePath } from '@web/resources';
  import { Badge, Button, DataTable, type Column, type FilterChip, type MenuItem } from '#lib/ui';
  import { usePageActions } from '#lib/shell/page-actions.svelte.ts';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import DeleteConfirm from './DeleteConfirm.svelte';

  type Row = { key: string; domains: string; acme: boolean; order?: string; days?: number; notAfter?: string; mark: 'missing' | 'expired' | 'ok'; used: number };
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const ro = $derived(scope?.readOnly === true);
  let del = $state<{ kind: 'certificate'; key: string } | undefined>();
  /** 만료 임박 — 시안의 「만료 12일 전」 경고 기준. ACME 자동 갱신(30일 전)과 같다. */
  const SOON = 30;

  const rows = $derived<Row[]>(desk.certs.rows.map((c) => ({
    key: c.key, domains: c.domains.join(', '), acme: c.acme, mark: c.mark,
    ...(c.orderState === undefined ? {} : { order: c.orderState }),
    ...(c.expiresInDays === undefined ? {} : { days: c.expiresInDays }),
    ...(c.notAfter === undefined ? {} : { notAfter: c.notAfter }),
    used: relationsOf(desk.model, { kind: 'certificate', key: c.key }).usedBy.length,
  })));
  const columns: Column<Row>[] = [
    { key: 'key', label: '이름', mono: true, sort: (r) => r.key },
    { key: 'domains', label: '도메인', mono: true, sort: (r) => r.domains },
    { key: 'acme', label: '발급', sort: (r) => (r.acme ? 1 : 0) },
    { key: 'days', label: '만료', sort: (r) => r.days ?? -1 },
    { key: 'used', label: '사용처', align: 'right', mono: true, sort: (r) => r.used },
  ];
  const chips: FilterChip<Row>[] = [
    { key: 'soon', label: '만료 임박', tone: 'warn', match: (r) => r.mark === 'ok' && r.days !== undefined && r.days < SOON },
    { key: 'expired', label: '만료됨', tone: 'danger', match: (r) => r.mark === 'expired' },
    { key: 'missing', label: '자료 없음', tone: 'neutral', match: (r) => r.mark === 'missing' },
  ];
  const menu = (r: Row): MenuItem[] => [
    { label: '상세를 봐요', href: resourcePath('certificate', r.key) },
    ...(ro ? [] : [
      { label: '자료를 교체해요', href: '/tls/certificate/new' },
      { label: '삭제…', danger: true, onselect: () => { del = { kind: 'certificate', key: r.key }; } },
    ]),
  ];
  usePageActions(() => (ro ? undefined : create));
</script>

{#snippet create()}<Button variant="primary" href="/tls/certificate/new">＋ 인증서 넣기</Button>{/snippet}

<DataTable label="인증서 목록" {rows} rowKey={(r) => r.key} {columns} {chips} loading={!desk.live}
  search={{ placeholder: '이름·도메인으로 찾기', match: (r, q) => `${r.key} ${r.domains}`.toLowerCase().includes(q) }}
  emptyTitle="인증서가 없어요" emptyBody="자료를 올리거나 ACME 로 발급해요. HTTPS 리스너에 필요해요."
  onopen={(r) => { void goto(resourcePath('certificate', r.key)); }} rowMenu={menu}>
  {#snippet cell(r, c)}
    {#if c.key === 'key'}<a href={resourcePath('certificate', r.key)}>{r.key}</a>
    {:else if c.key === 'domains'}{r.domains || '—'}
    {:else if c.key === 'acme'}{#if r.acme}<Badge tone="info" icon="↻">ACME{r.order ? ` · ${r.order}` : ''}</Badge>{:else}<span class="sub">업로드</span>{/if}
    {:else if c.key === 'days'}
      {#if r.mark === 'missing'}<Badge tone="neutral">자료 없음</Badge>
      {:else if r.mark === 'expired'}<Badge tone="danger">만료됨</Badge>
      {:else if r.days !== undefined && r.days < SOON}<Badge tone="warn">만료 {r.days}일 전</Badge>
      {:else}<span class="mono">{r.notAfter?.slice(0, 10) ?? '—'}</span>{#if r.days !== undefined}<span class="sub"> · {r.days}일</span>{/if}{/if}
    {:else if c.key === 'used'}{r.used}
    {/if}
  {/snippet}
</DataTable>
<DeleteConfirm bind:target={del} />

<style>
  .sub { color: var(--tx2); }
  .mono { font-family: var(--mono); }
</style>
