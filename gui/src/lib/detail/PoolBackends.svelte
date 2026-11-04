<script lang="ts">
  /**
   * 풀의 소속 백엔드 — 이름 · 호스트:포트 · 가중치 · 헬스(시안 「소속 백엔드」) · 트래픽 수신.
   * 드레인은 백엔드 목록이나 상세에서 한다. `pool` 을 주면 그 풀이다(목록의 분할 상세). 없으면 주소의 풀이다.
   *
   * 전체 합산의 분할 상세에서는 `InRegion` 이 desk · 범위를 그 행의 지역 것으로 덮는다 — 행은 그 지역 것이고,
   * 링크(백엔드 상세 · 백엔드 넣기)는 그 지역으로 좁혀 연다(`?region=`, 범위가 지역 하나에 묶였을 때 `scope.fixed`).
   */
  import { getContext } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { itemsOf, resourcePath } from '@web/resources';
  import { reasonLabels } from '@web/pools-view';
  import { Badge, Button, DataTable, type Column } from '#lib/ui';
  import Writable from '#lib/global/Writable.svelte';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import { inRegion } from '#lib/global/aggregate.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { DRAIN_MARK, HEALTH_MARK, backendDraining, backendHealth, type Mark } from './facts';

  type Row = { key: string; target: string; weight: string; mark: Mark; why?: string };
  let { pool }: { pool?: string } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  /** 합산의 지역 하나에 묶인 범위면 그 지역으로 좁혀 연다. 아니면 주소 그대로. */
  const link = (path: string): string => (scope?.fixed === true && scope.region !== undefined ? inRegion(path, scope.region.name) : path);
  const key = $derived(pool ?? page.params['key'] ?? '');
  const rows = $derived<Row[]>(itemsOf(desk.model, 'backend').filter((b) => b['pool'] === key).map((b) => {
    const k = String(b['key']);
    const t = desk.traffic.get(k);
    return {
      key: k,
      target: `${String(b['host'])}:${String(b['port'])}`,
      weight: String(b['weight'] ?? ''),
      mark: backendDraining(desk, k) ? DRAIN_MARK : HEALTH_MARK[backendHealth(desk, k)],
      ...(t?.receivingTraffic === false ? { why: reasonLabels(t.reasons).join(' · ') } : {}),
    };
  }));
  const columns: Column<Row>[] = [
    { key: 'key', label: '이름', mono: true, sort: (r) => r.key },
    { key: 'target', label: '호스트:포트', mono: true, text: (r) => r.target, sort: (r) => r.target },
    { key: 'weight', label: '가중치', mono: true, align: 'right', text: (r) => r.weight, width: '80px' },
    { key: 'health', label: '헬스', sort: (r) => r.mark.text },
    { key: 'why', label: '트래픽 수신', text: (r) => r.why ?? '수신 중' },
  ];
  const addHref = $derived(link(`/traffic/backend/new?pool=${encodeURIComponent(key)}`));
</script>

{#snippet cell(r: Row, c: Column<Row>)}
  {#if c.key === 'key'}<a class="lnk" href={link(resourcePath('backend', r.key))}>{r.key}</a>
  {:else if c.key === 'health'}<Badge tone={r.mark.tone} icon={r.mark.icon}>{r.mark.text}</Badge>
  {:else if c.key === 'why'}
    {#if r.why !== undefined}<Badge tone="warn" icon="▲">{r.why}</Badge>{:else}<span class="ok">● 수신 중</span>{/if}
  {:else}{c.text?.(r) ?? ''}{/if}
{/snippet}

{#snippet actions()}
  <Writable><Button size="sm" href={addHref}>＋ 이 풀에 백엔드 넣기</Button></Writable>
{/snippet}

{#snippet emptyAction()}
  <Writable><Button variant="primary" href={addHref}>백엔드를 넣어요</Button></Writable>
{/snippet}

<DataTable
  {rows} rowKey={(r) => r.key} {columns} {cell} {actions} {emptyAction} label="소속 백엔드"
  onopen={(r) => { void goto(link(resourcePath('backend', r.key))); }}
  emptyTitle="백엔드가 없어요" emptyBody="이 풀로 가는 요청은 실패해요." minHeight="0"
/>

<style>
  .lnk { color: var(--accent); font-family: var(--mono); text-decoration: none; }
  .lnk:hover { text-decoration: underline; }
  .ok { color: var(--ok); }
</style>
