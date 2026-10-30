<script lang="ts">
  /** 클러스터 — 노드마다 역할 · 상태 · 활성 세대 · 마지막 신호 · 오류. 행을 열면 노드 상세다. */
  import { getContext } from 'svelte';
  import { goto } from '$app/navigation';
  import { Badge, Card, DataTable, FieldMessage, Skeleton, type Column, type FilterChip } from '#lib/ui';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { nodeState, type ClusterBody, type ClusterNode } from './cluster';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  let body = $state<ClusterBody | undefined>();
  let failed = $state(false);
  $effect(() => {
    void desk.head;
    void desk.status;
    if (!desk.live) return;
    void desk.clusterNodes().then((r) => { failed = r === undefined; body = r as ClusterBody | undefined; });
  });
  const href = (n: ClusterNode): string => `/ops/cluster/${encodeURIComponent(n.name)}`;
  const columns: Column<ClusterNode>[] = [
    { key: 'name', label: '노드', mono: true, sort: (r) => r.name },
    { key: 'role', label: '역할', width: '110px', sort: (r) => r.role },
    { key: 'state', label: '상태', sort: (r) => nodeState(r).text },
    { key: 'gen', label: '활성 세대', mono: true, muted: true, text: (r) => r.activeGeneration ?? '—', sort: (r) => r.activeGeneration ?? '' },
    { key: 'seen', label: '마지막 신호', muted: true, hideable: true, text: (r) => new Date(r.lastSeen).toLocaleString(), sort: (r) => r.lastSeen },
    { key: 'err', label: '마지막 오류', hideable: true, text: (r) => r.lastError ?? '' },
  ];
  const chips: FilterChip<ClusterNode>[] = [
    { key: 'ok', label: '따라가는 중', tone: 'ok', match: (r) => nodeState(r).tone === 'ok' },
    { key: 'bad', label: '문제', tone: 'danger', match: (r) => nodeState(r).tone !== 'ok' },
  ];
</script>

{#snippet cell(r: ClusterNode, c: Column<ClusterNode>)}
  {#if c.key === 'name'}
    <a class="lnk" href={href(r)}>{r.name}</a>{#if r.name === body?.self}<span class="self"> · 이 노드</span>{/if}
  {:else if c.key === 'role'}
    {#if r.role === 'leader'}<Badge tone="accent">리더</Badge>{:else}<Badge icon="☆">팔로워</Badge>{/if}
  {:else if c.key === 'state'}
    {@const s = nodeState(r)}<Badge tone={s.tone}>{s.text}</Badge>
  {:else if c.key === 'err'}
    {#if r.lastError}<span class="err">{r.lastError}</span>{/if}
  {:else}{c.text?.(r) ?? ''}{/if}
{/snippet}

{#if !desk.live || (body === undefined && !failed)}
  <Skeleton height="160px" label="노드 상태를 읽는 중" />
{:else if failed || body === undefined}
  <FieldMessage tone="error">노드 상태를 못 읽었어요.</FieldMessage>
{:else if !body.enabled}
  <Card title="클러스터 모드가 아니에요">
    <FieldMessage>이 호스트 하나가 서빙해요. 여러 노드로 나누려면 <code>BARY_CLUSTER</code> 를 켜요.</FieldMessage>
  </Card>
{:else}
  <div class="cl">
    {#if body.leader}
      <p class="leader"><Badge tone="accent">리더</Badge> <code>{body.leader.name}</code> · {new Date(body.leader.since).toLocaleString()}부터</p>
    {/if}
    <DataTable rows={body.nodes} rowKey={(r) => r.name} {columns} {cell} {chips} label="클러스터 노드"
      onopen={(r) => { void goto(href(r)); }} emptyTitle="노드가 없어요" />
  </div>
{/if}

<style>
  .cl { display: flex; flex-direction: column; gap: 12px; }
  .leader { margin: 0; display: flex; gap: 8px; align-items: center; font: var(--t-small); color: var(--tx2); }
  code { font-family: var(--mono); color: var(--tx); }
  .lnk { color: var(--accent); font-family: var(--mono); text-decoration: none; }
  .lnk:hover { text-decoration: underline; }
  .self { color: var(--tx3); font: var(--t-cap); }
  .err { color: var(--danger); font: var(--t-cap); }
</style>
