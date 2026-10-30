<script lang="ts">
  /** 클러스터 노드 하나 — 시안의 노드 상세: 상태 · 마지막 오류 · 노드 GUI 주소 · 최근 적용 기록. */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { Badge, Button, Card, DataTable, DescriptionList, FieldMessage, Skeleton, type Column } from '#lib/ui';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { nodeState, type ClusterNode } from './cluster';

  type Rec = { at: string; revision?: string; generation?: string; phase?: string };
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const name = $derived(page.params['node'] ?? '');
  let node = $state<ClusterNode | undefined | null>();
  let recs = $state<Rec[] | undefined>();
  $effect(() => {
    void desk.head;
    void desk.status;
    if (!desk.live) return;
    const n = name;
    void desk.clusterNodes().then((r) => {
      const nodes = ((r as { nodes?: ClusterNode[] } | undefined)?.nodes ?? []);
      node = nodes.find((x) => x.name === n) ?? null;
    });
    void desk.clusterHistory(n).then((r) => { recs = (r ?? []) as Rec[]; });
  });
  const items = $derived(node == null ? [] : [
    { label: '역할', value: node.role === 'leader' ? '★ 리더' : '☆ 팔로워' },
    { label: '활성 세대', value: node.activeGeneration ?? '—', mono: true },
    { label: '마지막 신호', value: `${new Date(node.lastSeen).toLocaleString()}${node.stale ? ' — 끊겼어요' : ''}`, ...(node.stale ? { tone: 'danger' as const } : {}) },
    { label: '마지막 오류', value: node.lastError ?? '없어요', ...(node.lastError ? { tone: 'danger' as const } : {}) },
  ]);
  const columns: Column<Rec>[] = [
    { key: 'at', label: '시각', muted: true, width: '200px', text: (r) => new Date(r.at).toLocaleString(), sort: (r) => r.at },
    { key: 'generation', label: '세대', mono: true, text: (r) => r.generation ?? '?' },
    { key: 'revision', label: '리비전', mono: true, width: '100px', text: (r) => (r.revision === undefined ? '' : `r${r.revision}`) },
    { key: 'phase', label: '단계', mono: true, muted: true, text: (r) => r.phase ?? '' },
  ];
</script>

{#if !desk.live || node === undefined}
  <Skeleton height="160px" label="노드 상태를 읽는 중" />
{:else if node === null}
  <FieldMessage tone="error">노드 <code>{name}</code> 가 클러스터에 없어요. <a href="/ops/cluster">목록</a>으로 가요.</FieldMessage>
{:else}
  {@const s = nodeState(node)}
  <div class="nd">
    <Card title={node.name}>
      {#snippet actions()}
        <Badge tone={s.tone}>{s.text}</Badge>
        {#if node?.url}<Button size="sm" href={node.url} target="_blank" rel="noopener">노드 GUI 열기 ↗</Button>{/if}
      {/snippet}
      <DescriptionList labelWidth="120px" {items} />
    </Card>
    <Card title="최근 적용 기록" padded={false}>
      <DataTable rows={recs ?? []} loading={recs === undefined} rowKey={(r) => r.at + (r.generation ?? '')} {columns} label="최근 적용 기록"
        emptyTitle="따라간 기록이 없어요" emptyBody="리더는 직접 적용해서 여기 남지 않아요." minHeight="0" />
    </Card>
  </div>
{/if}

<style>
  .nd { display: flex; flex-direction: column; gap: 16px; max-width: 960px; }
  code { font-family: var(--mono); }
</style>
