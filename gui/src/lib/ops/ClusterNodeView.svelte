<script lang="ts">
  /** 클러스터 노드 하나 — 목록 아래의 선택 상세(`NodeDetail`)와 같은 것에 역할 · 리더 시작 시각을 더한다. */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { DescriptionList, FieldMessage, Skeleton } from '#lib/ui';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { type ClusterBody, type ClusterNode } from './cluster';
  import NodeDetail from './NodeDetail.svelte';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const name = $derived(page.params['node'] ?? '');
  let body = $state<ClusterBody | undefined>();
  let node = $state<ClusterNode | undefined | null>();
  $effect(() => {
    void desk.head;
    void desk.status;
    if (!desk.live) return;
    const n = name;
    void desk.clusterNodes().then((r) => {
      body = r as ClusterBody | undefined;
      node = (body?.nodes ?? []).find((x) => x.name === n) ?? null;
    });
  });
  const items = $derived(node == null ? [] : [
    { label: '역할', value: node.role === 'leader' ? '★ 리더' : '☆ 팔로워' },
    ...(node.role === 'leader' && body?.leader?.name === node.name
      ? [{ label: '리더가 된 때', value: new Date(body.leader.since).toLocaleString() }] : []),
    { label: '마지막 신호', value: `${new Date(node.lastSeen).toLocaleString()}${node.stale ? ' — 연락이 없어요' : ''}`, ...(node.stale ? { tone: 'warn' as const } : {}) },
    { label: '뒤처짐', value: node.behind ? '리더보다 뒤예요' : '아니에요', ...(node.behind ? { tone: 'warn' as const } : {}) },
  ]);
</script>

{#if !desk.live || node === undefined}
  <Skeleton height="160px" label="노드 상태를 읽는 중" />
{:else if node === null}
  <FieldMessage tone="error">노드 <code>{name}</code> 가 클러스터에 없어요. <a href="/ops/cluster">목록</a>으로 가요.</FieldMessage>
{:else}
  <div class="nv">
    <NodeDetail {node} self={body?.self} page />
    <section class="more" aria-label="노드 정보"><DescriptionList labelWidth="120px" {items} /></section>
  </div>
{/if}

<style>
  .nv { display: flex; flex-direction: column; gap: 16px; max-width: 960px; }
  .more { padding: 14px 16px; background: var(--bg-panel); border: 1px solid var(--bd); border-radius: var(--r-lg); }
  code { font-family: var(--mono); }
</style>
