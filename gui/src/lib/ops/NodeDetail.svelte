<script lang="ts">
  /**
   * 노드 하나의 상세 — 시안 클러스터 화면의 「선택 상세」: 상태 · 활성 세대 · 마지막 신호 · 마지막 오류 · 최근 적용 기록 ·
   * 노드 GUI 주소. 목록 아래(선택한 노드)와 노드 화면(`/ops/cluster/<노드>`)이 같이 쓴다.
   */
  import { getContext } from 'svelte';
  import { Badge, Button, FieldMessage, Skeleton } from '#lib/ui';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { nodeState, seenText, type ClusterNode, type NodeRecord } from './cluster';

  let { node, self, page = false }: { node: ClusterNode; self?: string | undefined; page?: boolean } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const s = $derived(nodeState(node));

  let recs = $state<NodeRecord[] | undefined>();
  let failed = $state(false);
  $effect(() => {
    void desk.head;
    if (!desk.live) return;
    const n = node.name;
    recs = undefined;
    void desk.clusterHistory(n).then((r) => {
      if (n !== node.name) return;
      failed = r === undefined;
      recs = (r ?? []) as NodeRecord[];
    });
  });
  const line = (r: NodeRecord): string =>
    [new Date(r.at).toLocaleString(), r.generation ?? '?', r.revision === undefined ? '' : `r${r.revision}`, r.phase ?? ''].filter(Boolean).join(' · ');
</script>

<section class="nd" aria-label="{node.name} 상세">
  <div class="hd">
    <span class="nm">{node.name}</span>
    <Badge tone={s.tone}>{s.text}</Badge>
    {#if node.role === 'leader'}<Badge tone="accent">리더</Badge>{:else}<Badge icon="☆">팔로워</Badge>{/if}
    {#if node.name === self}<span class="dim">이 노드</span>{/if}
    <span class="meta">활성 세대 <code>{node.activeGeneration ?? '—'}</code> · 마지막 신호 {seenText(node.lastSeen)}</span>
    {#if !page}<Button size="sm" variant="text" href={`/ops/cluster/${encodeURIComponent(node.name)}`}>상세 화면</Button>{/if}
    {#if node.url}<Button size="sm" href={node.url} target="_blank" rel="noopener">이 노드에서 열기 ↗</Button>{/if}
  </div>
  <div class="cols">
    <div>
      <h4>마지막 오류</h4>
      <pre class:err={!!node.lastError}>{node.lastError ? node.lastError : '오류가 없어요.'}</pre>
    </div>
    <div>
      <h4>최근 적용 기록</h4>
      {#if recs === undefined}
        <Skeleton height="60px" label="적용 기록을 읽는 중" />
      {:else if failed}
        <FieldMessage tone="error">적용 기록을 못 읽었어요.</FieldMessage>
      {:else if recs.length === 0}
        <p class="dim">따라간 기록이 없어요. 리더는 직접 적용해서 여기 남지 않아요.</p>
      {:else}
        <ol class="hist">{#each recs as r, i (i)}<li>{line(r)}</li>{/each}</ol>
      {/if}
      <p class="gui">노드 GUI 주소: <code>{node.url ?? '알려 주지 않았어요'}</code></p>
    </div>
  </div>
</section>

<style>
  .nd { display: flex; flex-direction: column; gap: 12px; padding: 14px 16px; background: var(--bg-panel); border: 1px solid var(--bd); border-radius: var(--r-lg); }
  .hd { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .nm { font: 600 15px/22px var(--mono); }
  .meta { flex: 1; font: var(--t-cap); color: var(--tx3); }
  .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
  h4 { margin: 0 0 6px; font: 600 12px/18px var(--font); color: var(--tx2); }
  pre {
    margin: 0; padding: 8px 10px; background: var(--bg-input); border: 1px solid var(--bd); border-radius: var(--r-sm);
    font: 400 12px/18px var(--mono); white-space: pre-wrap; color: var(--tx3);
  }
  pre.err { color: var(--danger); }
  .hist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; font: 400 12px/18px var(--mono); color: var(--tx2); }
  .gui { margin: 10px 0 0; font: var(--t-cap); color: var(--tx3); }
  code { font-family: var(--mono); color: var(--tx2); }
  .dim { margin: 0; font: var(--t-cap); color: var(--tx3); }
</style>
