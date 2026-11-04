<script lang="ts">
  /**
   * 노드 하나의 상세 — 시안 클러스터 화면의 「선택 상세」: 상태 · 활성 세대 · 마지막 신호 · 마지막 오류 · 최근 적용 기록 ·
   * 노드 GUI 주소. 목록 아래(선택한 노드)와 노드 화면(`/ops/cluster/<노드>`)이 같이 쓴다. 값은 시안의 인라인 style 그대로다.
   */
  import { getContext } from 'svelte';
  import { Badge, FieldMessage, Skeleton } from '#lib/ui';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { nodeState, seenText, type ClusterNode, type NodeRecord } from './cluster';

  let { node, page = false }: { node: ClusterNode; self?: string | undefined; page?: boolean } = $props();
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
    <span class="meta">활성 세대 {node.activeGeneration ?? '—'} · 마지막 신호 {seenText(node.lastSeen)}</span>
    {#if !page}<a class="btn" href={`/ops/cluster/${encodeURIComponent(node.name)}`}>상세 화면</a>{/if}
    {#if node.url}<a class="btn open" href={node.url} target="_blank" rel="noopener">이 노드에서 열기 ↗</a>{/if}
  </div>
  <div class="cols">
    <div>
      <div class="h">마지막 오류</div>
      <pre class:err={!!node.lastError}>{node.lastError ? node.lastError : '오류가 없어요.'}</pre>
    </div>
    <div>
      <div class="h">최근 적용 기록</div>
      {#if recs === undefined}
        <Skeleton height="60px" label="적용 기록을 읽는 중" />
      {:else if failed}
        <FieldMessage tone="error">적용 기록을 못 읽었어요.</FieldMessage>
      {:else if recs.length === 0}
        <div class="dim">따라간 기록이 없어요. 리더는 직접 적용해서 여기 남지 않아요.</div>
      {:else}
        <div class="hist">{#each recs as r, i (i)}<div>{line(r)}</div>{/each}</div>
      {/if}
      <div class="gui">노드 GUI 주소: <span class="u">{node.url ?? '알려 주지 않았어요'}</span></div>
    </div>
  </div>
</section>

<style>
  .nd { display: flex; flex-direction: column; gap: 12px; background: var(--bg-panel); border: 1px solid var(--bd); border-radius: var(--r-lg); padding: 14px 16px; }
  .hd { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .nm { font-family: var(--mono); font-weight: 600; font-size: 15px; }
  .meta { font-size: 12px; color: var(--tx3); flex: 1; }
  .btn {
    display: inline-flex; align-items: center; height: 28px; padding: 0 12px; border: 1px solid var(--bd-strong); background: transparent;
    color: var(--tx); border-radius: var(--r-md); font-weight: 600; font-size: 12px; text-decoration: none;
  }
  .btn.open { border-color: var(--accent); color: var(--accent); }
  .btn:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
  .h { font-size: 12px; font-weight: 600; color: var(--tx2); margin-bottom: 6px; }
  pre {
    margin: 0; padding: 8px 10px; background: var(--bg-input); border: 1px solid var(--bd); border-radius: var(--r-sm);
    font-family: var(--mono); font-size: 12px; line-height: 18px; white-space: pre-wrap; color: var(--tx3);
  }
  pre.err { color: var(--danger); }
  .hist { display: flex; flex-direction: column; gap: 4px; font-size: 12px; font-family: var(--mono); color: var(--tx2); }
  .dim { font-size: 12px; color: var(--tx3); }
  .gui { font-size: 12px; color: var(--tx3); margin-top: 10px; }
  .u { font-family: var(--mono); color: var(--tx2); }
</style>
