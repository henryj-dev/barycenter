<script lang="ts">
  /**
   * 클러스터 — 노드마다 역할 · 활성 세대 · 상태 · 마지막 신호 · 오류 (시안 「클러스터」).
   * 행을 누르면 아래에 그 노드의 상세가 나온다. 두 번 누르거나 Enter 면 노드 화면(`/ops/cluster/<노드>`)으로 간다.
   */
  import { getContext } from 'svelte';
  import { goto } from '$app/navigation';
  import { Badge, Card, DataTable, FieldMessage, Skeleton, type Column, type FilterChip } from '#lib/ui';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { nodeState, seenText, type ClusterBody, type ClusterNode } from './cluster';
  import NodeDetail from './NodeDetail.svelte';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  let body = $state<ClusterBody | undefined>();
  let failed = $state(false);
  let selected = $state<string[]>([]);
  $effect(() => {
    void desk.head;
    void desk.status;
    if (!desk.live) return;
    void desk.clusterNodes().then((r) => { failed = r === undefined; body = r as ClusterBody | undefined; });
  });
  const href = (n: ClusterNode): string => `/ops/cluster/${encodeURIComponent(n.name)}`;
  const nodes = $derived(body?.nodes ?? []);
  const cur = $derived(nodes.find((n) => n.name === selected[0]));
  /** 시안 머리 줄 — 「N대 중 M대가 <리더의 활성 세대>이에요」. 리더 세대를 모르면 「맞음」 을 센다. */
  const leaderGen = $derived(nodes.find((n) => n.role === 'leader')?.activeGeneration);
  const summary = $derived(leaderGen !== undefined
    ? `${nodes.length}대 중 ${nodes.filter((n) => n.activeGeneration === leaderGen).length}대가 ${leaderGen}이에요`
    : `${nodes.length}대 중 ${nodes.filter((n) => nodeState(n).tone === 'ok').length}대가 맞아요`);
  const columns: Column<ClusterNode>[] = [
    { key: 'name', label: '노드', mono: true, sort: (r) => r.name },
    { key: 'role', label: '역할', width: '110px', sort: (r) => r.role },
    { key: 'gen', label: '활성 세대', mono: true, text: (r) => r.activeGeneration ?? '—', sort: (r) => r.activeGeneration ?? '' },
    { key: 'state', label: '상태', sort: (r) => nodeState(r).text },
    { key: 'seen', label: '마지막 신호', muted: true, hideable: true, text: (r) => seenText(r.lastSeen), sort: (r) => r.lastSeen },
    { key: 'err', label: '오류', hideable: true, text: (r) => (r.lastError ? r.lastError.split('\n')[0]! : '—') },
  ];
  const chips: FilterChip<ClusterNode>[] = [
    { key: 'ok', label: '맞음', tone: 'ok', match: (r) => nodeState(r).tone === 'ok' },
    { key: 'bad', label: '확인 필요', tone: 'warn', match: (r) => nodeState(r).tone !== 'ok' },
  ];
</script>

{#snippet cell(r: ClusterNode, c: Column<ClusterNode>)}
  {#if c.key === 'name'}
    <a class="lnk" href={href(r)}>{r.name}</a>{#if r.name === body?.self}<span class="self"> · 이 노드</span>{/if}
  {:else if c.key === 'role'}
    {#if r.role === 'leader'}<span class="leader-tx">★ 리더</span>{:else}<span class="muted">팔로워</span>{/if}
  {:else if c.key === 'state'}
    {@const s = nodeState(r)}<Badge tone={s.tone}>{s.text}</Badge>
  {:else if c.key === 'err'}
    <span class:err={!!r.lastError} class="one" title={r.lastError}>{c.text?.(r)}</span>
  {:else}{c.text?.(r) ?? ''}{/if}
{/snippet}

{#if !desk.live || (body === undefined && !failed)}
  <Skeleton height="160px" label="노드 상태를 읽는 중" />
{:else if failed || body === undefined}
  <FieldMessage tone="error">노드 상태를 못 읽었어요.</FieldMessage>
{:else if !body.enabled}
  <Card title="이 인스턴스는 클러스터 모드가 아니에요">
    <div class="off">
      <FieldMessage>클러스터 모드를 켜면 여러 호스트가 같은 설정으로 같은 트래픽을 받아요. 환경 변수를 설정하고 다시 시작해요.</FieldMessage>
      <code class="env">BARY_CLUSTER=1</code>
    </div>
  </Card>
{:else}
  <div class="cl">
    <div class="sum">
      <span class="big">{summary}</span>
      <span class="hint">
        같은 설정, 같은 트래픽이에요. 쓰기는 리더가 해요.
        {#if body.leader}리더 <code>{body.leader.name}</code> · {new Date(body.leader.since).toLocaleString()}부터.{/if}
      </span>
    </div>
    <DataTable rows={nodes} rowKey={(r) => r.name} {columns} {cell} {chips} bind:selected label="클러스터 노드"
      onopen={(r) => { void goto(href(r)); }} emptyTitle="노드가 없어요" minHeight="0" />
    {#if cur}
      <NodeDetail node={cur} self={body.self} />
    {:else}
      <div class="nosel">노드를 선택하면 상세가 나와요.</div>
    {/if}
  </div>
{/if}

<style>
  .cl { display: flex; flex-direction: column; gap: 12px; }
  .sum { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
  .big { font: 600 15px/22px var(--font); }
  .hint { flex: 1; font: var(--t-cap); color: var(--tx3); }
  code { font-family: var(--mono); color: var(--tx2); }
  .lnk { color: var(--accent); font-family: var(--mono); font-weight: 500; text-decoration: none; }
  .lnk:hover { text-decoration: underline; }
  .self { color: var(--tx3); font: var(--t-cap); }
  .leader-tx { color: var(--accent); font: var(--t-cap); }
  .muted { color: var(--tx2); font: var(--t-cap); }
  .one { display: inline-block; max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; font: var(--t-cap); color: var(--tx2); }
  .err { color: var(--danger); }
  .nosel {
    display: grid; place-items: center; padding: 20px; border: 1px dashed var(--bd-strong); border-radius: var(--r-lg);
    color: var(--tx3); font: var(--t-small);
  }
  .off { display: flex; flex-direction: column; gap: 10px; max-width: 560px; }
  .env { font: 400 13px/1.4 var(--mono); padding: 8px 10px; background: var(--bg-input); border: 1px solid var(--bd); border-radius: var(--r-sm); color: var(--tx); }
</style>
