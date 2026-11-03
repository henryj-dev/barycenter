<script lang="ts">
  /**
   * 상태 — head · 리더 · 게시 · 미완 전환 · 엔진 · 드라이버 (`/api/v1/status` 의 4-way). 시안대로 카드 여섯 장이다.
   * 미완 전환이 있으면 위에 배너를 띄우고 「이어받기」 를 둔다. 전역 모드면 버튼을 안 그린다(설계 §1).
   * 클러스터면 노드별 상태로 가는 길을 둔다. 전역이면 지역 요약(`/api/v1/regions`)으로 지역별 표를 그린다.
   */
  import { getContext } from 'svelte';
  import { viewOfStatus, type StatusFact } from '@web/status-view';
  import { Badge, Banner, Button, Card, DataTable, FieldMessage, Skeleton, type Column, type Tone } from '#lib/ui';
  import type { RegionSummary, Scope } from '#lib/global/scope.svelte.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { loadRegions } from './fetch';

  type Pend = { planId: string; revision: string };
  type StatCard = { label: string; value: string; sub: string; badge?: { tone: Tone; text: string } };
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const ro = $derived(scope?.readOnly === true);
  const global = $derived(scope?.mode === 'global');
  const v = $derived(desk.status);

  const cards = $derived<StatCard[]>([
    {
      label: 'head 리비전', value: v.head === undefined ? '—' : `r${v.head}`,
      sub: '커밋된 가장 새 리비전이에요.',
      badge: v.pending.length > 0 ? { tone: 'pending', text: `적용 대기 ${v.pending.length}건` } : { tone: 'ok', text: '적용 대기 없음' },
    },
    {
      label: '리더', value: v.leader.isLeader ? '★ 이 인스턴스' : `☆ ${v.leader.holder}`,
      sub: v.leader.isLeader ? `잠금을 쥔 곳: ${v.leader.holder}` : `쓰기는 리더가 해요.${v.leader.reason ? ` ${v.leader.reason}` : ''}`,
      badge: v.leader.isLeader ? { tone: 'ok', text: '정상' } : { tone: 'warn', text: '스탠바이' },
    },
    { label: '게시 세대', value: v.published.generation ?? '—', sub: `게시: ${v.published.kind}` },
    {
      label: '미완 전환', value: v.unfinished ? '1건' : '0건',
      sub: v.unfinished ? '끝나지 않은 전환이 있어요. 복구 대상이에요.' : '진행 중인 전환이 없어요.',
      badge: v.unfinished ? { tone: 'warn', text: '있음' } : { tone: 'ok', text: '없음' },
    },
    { label: '엔진', value: v.engine.label, sub: v.engine.probed ? '엔진에 물어 확인했어요.' : '엔진을 못 물었어요.' },
    {
      label: '드라이버', value: v.driver.loaded ? (v.driver.name ?? '실었어요') : '안 실었어요',
      sub: '백엔드 목록을 외부에서 받는 플러그인이에요. 서비스 디스커버리 드라이버를 실으면 여기에 나와요.',
    },
  ]);

  /** 클러스터면 노드별 상태 화면으로 가는 길을 보인다. 전역은 지역마다 다르므로 묻지 않는다. */
  let clustered = $state(false);
  $effect(() => {
    if (!desk.live || global) return;
    void desk.clusterNodes().then((r) => { clustered = (r as { enabled?: boolean } | undefined)?.enabled === true; });
  });

  type RegRow = { name: string; reachable: boolean; v: ReturnType<typeof viewOfStatus> | undefined; error: string | undefined };
  let regions = $state<RegRow[] | undefined>();
  let regionsFailed = $state(false);
  $effect(() => {
    if (!global) return;
    void desk.head;
    void loadRegions(desk.token).then((rs: RegionSummary[] | undefined) => {
      regionsFailed = rs === undefined;
      regions = (rs ?? []).map((r) => ({
        name: r.name, reachable: r.reachable, error: r.error,
        v: r.status === undefined ? undefined : viewOfStatus(r.status as StatusFact),
      }));
    });
  });
  const unknown = '모름';
  const regColumns: Column<RegRow>[] = [
    { key: 'name', label: '지역', mono: true, sort: (r) => r.name },
    { key: 'head', label: 'head', mono: true, width: '90px', text: (r) => (r.v?.head === undefined ? unknown : `r${r.v.head}`) },
    { key: 'leader', label: '리더', mono: true, text: (r) => r.v?.leader.holder ?? unknown },
    { key: 'gen', label: '게시 세대', mono: true, text: (r) => (r.v === undefined ? unknown : r.v.published.generation ?? '—') },
    { key: 'unf', label: '미완 전환', mono: true, width: '100px', text: (r) => (r.v === undefined ? unknown : r.v.unfinished ? '1' : '0') },
    { key: 'engine', label: '엔진', mono: true, text: (r) => (r.v === undefined ? (r.error ?? '닿지 않아요') : r.v.engine.label) },
  ];

  const columns: Column<Pend>[] = [
    { key: 'planId', label: 'plan', mono: true, text: (r) => r.planId },
    { key: 'revision', label: '리비전', mono: true, text: (r) => `r${r.revision}`, width: '120px' },
  ];
</script>

{#snippet regCell(r: RegRow, c: Column<RegRow>)}
  {#if c.key === 'head'}<span class="acc">{c.text?.(r)}</span>
  {:else if c.key === 'unf' && r.v?.unfinished}<Badge tone="warn">1건</Badge>
  {:else if c.key === 'engine' && r.v === undefined}<span class="muted">{c.text?.(r)}</span>
  {:else}{c.text?.(r) ?? ''}{/if}
{/snippet}

{#if !desk.live}
  <Skeleton height="160px" label="연결하는 중" />
{:else}
  <div class="st">
    {#if v.unfinished}
      <Banner tone="warn">
        끝나지 않은 전환이 있어요. 복구가 이어받아야 다음 적용을 할 수 있어요.
        {#snippet action()}
          {#if !ro}<Button size="sm" loading={desk.recovering} onclick={() => { void desk.recover(); }}>{desk.recovering ? '이어받는 중' : '이어받기'}</Button>{/if}
        {/snippet}
      </Banner>
    {/if}

    <div class="cards">
      {#each cards as c (c.label)}
        <section class="card" aria-label={c.label}>
          <span class="l">{c.label}</span>
          <span class="v">{c.value}</span>
          <span class="sub">{c.sub}</span>
          {#if c.badge}<span><Badge tone={c.badge.tone}>{c.badge.text}</Badge></span>{/if}
        </section>
      {/each}
    </div>

    {#if clustered}
      <div><Button size="sm" href="/ops/cluster">클러스터 화면에서 노드별 상태 보기 →</Button></div>
    {/if}

    {#if global}
      <Card title="지역별 상태" padded={false}>
        {#if regionsFailed}
          <div class="pad"><FieldMessage tone="error">지역 요약을 못 읽었어요.</FieldMessage></div>
        {:else}
          <DataTable rows={regions ?? []} loading={regions === undefined} rowKey={(r) => r.name} columns={regColumns} cell={regCell}
            label="지역별 상태" emptyTitle="지역이 없어요" minHeight="0" />
        {/if}
      </Card>
    {/if}

    <Card title="적용 대기 plan" sub={v.pending.length > 0 ? `${v.pending.length}개` : undefined} padded={false}>
      {#if v.pending.length === 0}
        <div class="pad"><FieldMessage>대기 중인 plan 이 없어요.</FieldMessage></div>
      {:else}
        <DataTable rows={v.pending} rowKey={(r) => r.planId} {columns} label="적용 대기 plan" minHeight="0" />
      {/if}
    </Card>
  </div>
{/if}

<style>
  .st { display: flex; flex-direction: column; gap: 16px; max-width: 1080px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
  .card {
    display: flex; flex-direction: column; gap: 6px; padding: 14px 16px; min-width: 0;
    background: var(--bg-panel); border: 1px solid var(--bd); border-radius: var(--r-lg);
  }
  .l { font: var(--t-cap); color: var(--tx3); }
  .v { font: 600 22px/30px var(--mono); overflow-wrap: anywhere; }
  .sub { font: var(--t-cap); color: var(--tx2); }
  .pad { padding: 12px 16px; }
  .acc { color: var(--accent); }
  .muted { color: var(--tx3); }
</style>
