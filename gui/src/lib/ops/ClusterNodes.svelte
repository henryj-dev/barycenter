<script lang="ts">
  /**
   * 클러스터 — 노드마다 역할 · 활성 세대 · 상태 · 마지막 신호 · 오류 (시안 「클러스터」 · 디자인 시스템 §14).
   * 행을 누르거나 Enter · Space 면 고르고, 아래에 그 노드의 상세가 나온다(시안 `clRows`). 두 번 누르면 노드 화면
   * (`/ops/cluster/<노드>`)으로 간다. 칸은 링크가 아니다 — 평문이다.
   */
  import { getContext } from 'svelte';
  import { goto } from '$app/navigation';
  import { Badge, FieldMessage, Skeleton } from '#lib/ui';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { nodeState, seenText, type ClusterBody, type ClusterNode } from './cluster';
  import NodeDetail from './NodeDetail.svelte';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  let body = $state<ClusterBody | undefined>();
  let failed = $state(false);
  let selected = $state<string | undefined>();
  $effect(() => {
    void desk.head;
    void desk.status;
    if (!desk.live) return;
    void desk.clusterNodes().then((r) => { failed = r === undefined; body = r as ClusterBody | undefined; });
  });
  const href = (n: ClusterNode): string => `/ops/cluster/${encodeURIComponent(n.name)}`;
  const nodes = $derived(body?.nodes ?? []);
  const cur = $derived(nodes.find((n) => n.name === selected));
  /** 시안 머리 줄 — 「N대 중 M대가 <리더의 활성 세대>이에요」. 리더 세대를 모르면 「맞음」 을 센다. */
  const leaderGen = $derived(nodes.find((n) => n.role === 'leader')?.activeGeneration);
  const summary = $derived(leaderGen !== undefined
    ? `${nodes.length}대 중 ${nodes.filter((n) => n.activeGeneration === leaderGen).length}대가 ${leaderGen}이에요`
    : `${nodes.length}대 중 ${nodes.filter((n) => nodeState(n).tone === 'ok').length}대가 맞아요`);
  const pick = (n: ClusterNode): void => { selected = n.name; };
  const onKey = (e: KeyboardEvent, n: ClusterNode): void => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(n); }
  };
</script>

{#if !desk.live || (body === undefined && !failed)}
  <Skeleton height="160px" label="노드 상태를 읽는 중" />
{:else if failed || body === undefined}
  <FieldMessage tone="error">노드 상태를 못 읽었어요.</FieldMessage>
{:else if !body.enabled}
  <div class="off">
    <div class="off-t">이 인스턴스는 클러스터 모드가 아니에요</div>
    <div class="off-b">클러스터 모드를 켜면 여러 호스트가 같은 설정으로 같은 트래픽을 받아요. 환경 변수를 설정하고 다시 시작해요.</div>
    <code class="env">BARY_CLUSTER=1</code>
  </div>
{:else}
  <div class="cl">
    <div class="sum">
      <span class="big">{summary}</span>
      <span class="hint">같은 설정, 같은 트래픽이에요. 쓰기는 리더가 해요.</span>
    </div>
    <div class="tbl" role="group" aria-label="클러스터 노드">
      <div class="row head" aria-hidden="true">
        <span>노드</span><span>역할</span><span>활성 세대</span><span>상태</span><span>마지막 신호</span><span>오류</span>
      </div>
      {#each nodes as n (n.name)}
        {@const s = nodeState(n)}
        {@const on = cur?.name === n.name}
        <div class="row node" role="button" tabindex="0" aria-pressed={on} data-on={on}
          onclick={() => pick(n)} onkeydown={(e) => onKey(e, n)} ondblclick={() => { void goto(href(n)); }}>
          <span class="nm">{n.name}{#if n.name === body.self}<span class="self"> · 이 노드</span>{/if}</span>
          <span class="role" data-leader={n.role === 'leader'}>{n.role === 'leader' ? '★ 리더' : '팔로워'}</span>
          <span class="gen">{n.activeGeneration ?? '—'}</span>
          <span class="st"><Badge tone={s.tone}>{s.text}</Badge></span>
          <span class="seen">{seenText(n.lastSeen)}</span>
          <span class="err" title={n.lastError}>{n.lastError ? n.lastError.split('\n')[0] : '—'}</span>
        </div>
      {:else}
        <div class="empty">노드가 없어요.</div>
      {/each}
    </div>
    {#if cur}
      <NodeDetail node={cur} self={body.self} />
    {:else}
      <div class="nosel">노드를 선택하면 상세가 나와요.</div>
    {/if}
  </div>
{/if}

<style>
  /* 값은 시안 「클러스터」 마크업의 인라인 style 그대로다. */
  .cl { display: flex; flex-direction: column; gap: 12px; }
  .sum { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .big { font-size: 15px; font-weight: 600; }
  .hint { font-size: 12px; color: var(--tx3); flex: 1; }
  .tbl { background: var(--bg-panel); border: 1px solid var(--bd); border-radius: var(--r-lg); overflow: hidden; }
  .row { display: grid; grid-template-columns: 1fr .8fr .8fr 1.2fr .8fr 2.4fr; gap: 12px; padding: 0 16px; align-items: center; }
  .head { height: 32px; background: var(--bg-hover); font-size: 12px; font-weight: 600; color: var(--tx2); }
  .node {
    height: var(--row-h); border-top: 1px solid var(--bd); font-size: 13px; cursor: pointer;
    background: transparent; box-shadow: none; color: var(--tx);
  }
  .node[data-on='true'] { background: var(--bg-sel); box-shadow: inset 3px 0 0 var(--accent); }
  .node:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
  .nm { font-family: var(--mono); font-weight: 500; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .self { font-family: var(--font); font-weight: 400; font-size: 12px; color: var(--tx3); }
  .role { font-size: 12px; color: var(--tx2); }
  .role[data-leader='true'] { color: var(--accent); }
  .gen { font-family: var(--mono); font-size: 12px; }
  .st { display: inline-flex; width: fit-content; }
  .seen { font-size: 12px; color: var(--tx3); }
  .err { font-size: 12px; color: var(--tx2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty { padding: 20px 16px; border-top: 1px solid var(--bd); color: var(--tx3); font-size: 13px; text-align: center; }
  .nosel {
    display: grid; place-items: center; padding: 20px; border: 1px dashed var(--bd-strong); border-radius: var(--r-lg);
    color: var(--tx3); font-size: 13px;
  }
  .off {
    display: flex; flex-direction: column; gap: 10px; max-width: 560px; padding: 24px;
    background: var(--bg-panel); border: 1px solid var(--bd); border-radius: var(--r-lg);
  }
  .off-t { font-size: 15px; font-weight: 600; }
  .off-b { font-size: 13px; color: var(--tx2); }
  .env {
    font-family: var(--mono); font-size: 13px; padding: 8px 10px; background: var(--bg-input);
    border: 1px solid var(--bd); border-radius: var(--r-sm);
  }
</style>
