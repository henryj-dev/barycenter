<script lang="ts" module>
  import type { Tone } from '#lib/ui';
  /**
   * 트래픽 경로 그림의 노드 하나 — 콘솔 시안 `pathData` 의 `N(cap, head, o)` 그대로.
   * `href` 가 있으면 노드를 누르면 그 상세로 간다(시안 `go`). `arrow` 가 거짓이면 앞에 「→」 를 안 단다(시안 `arrowD: 'none'`).
   */
  export type PathNode = {
    cap: string;
    head?: string;
    sub?: string;
    badge?: { tone: Tone; icon: string; text: string; title?: string };
    /** 백엔드 줄 — 이름 · 작은 배지 · 「수신 중」. */
    items?: readonly { n: string; tone: Tone; icon: string; text: string; recv: string; href?: string }[];
    href?: string;
    dashed?: boolean;
    arrow?: boolean;
  };
  export type PathData = {
    help: string;
    /** 줄 하나의 칸 수(시안 `cols`). */
    cols: number;
    /** 바깥 격자(시안 `grid`) — 왼쪽 리스너 · 줄들, 또는 줄들 · 오른쪽 풀. */
    grid: string;
    left?: PathNode;
    right?: PathNode;
    lanes: readonly { nodes: readonly PathNode[] }[];
  };
</script>

<script lang="ts">
  /**
   * 트래픽 경로 탭의 그림 — 콘솔 시안 `tPath` 블록의 마크업 · 인라인 style 그대로.
   * 위에 도움말(「… 노드를 누르면 상세로 가요.」), 아래 격자: 왼쪽 노드 · 줄(lane)들 · 오른쪽 노드. 줄이 없으면
   * 「이 리소스로 이어지는 경로가 없어요.」. 노드는 누르면 그 상세로 가는 링크다(시안의 노드 단추).
   */
  let { data }: { data: PathData } = $props();
</script>

{#snippet node(n: PathNode)}
  <svelte:element this={n.href === undefined ? 'div' : 'a'} href={n.href} class="nd" class:dashed={n.dashed === true}>
    <span class="cap">{n.cap}</span>
    {#if n.head !== undefined && n.head !== ''}<span class="head">{n.head}</span>{/if}
    {#if n.sub !== undefined && n.sub !== ''}<span class="sub">{n.sub}</span>{/if}
    {#if n.badge !== undefined}<span class="bdg" title={n.badge.title} style:background="var(--{n.badge.tone}-bg)" style:color="var(--{n.badge.tone})">{n.badge.icon} {n.badge.text}</span>{/if}
    {#each n.items ?? [] as it (it.n)}
      <span class="it"><span class="mono">{it.n}</span><span class="mini" style:background="var(--{it.tone}-bg)" style:color="var(--{it.tone})">{it.icon} {it.text}</span>{#if it.recv !== ''}<span class="recv">{it.recv}</span>{/if}</span>
    {/each}
  </svelte:element>
{/snippet}

<div class="path">
  <div class="help">{data.help} 노드를 누르면 상세로 가요.</div>
  <div class="grid" style:grid-template-columns={data.grid}>
    {#if data.left !== undefined}<div class="side">{@render node(data.left)}</div>{/if}
    <div class="lanes">
      {#each data.lanes as ln, i (i)}
        <div class="lane" style:grid-template-columns="repeat({data.cols}, minmax(0, 1fr))">
          {#each ln.nodes as nd, j (j)}
            <div class="cell">{#if nd.arrow !== false}<span class="arrow" aria-hidden="true">→</span>{/if}{@render node(nd)}</div>
          {/each}
        </div>
      {/each}
      {#if data.lanes.length === 0}<div class="none">이 리소스로 이어지는 경로가 없어요.</div>{/if}
    </div>
    {#if data.right !== undefined}<div class="side right"><span class="arrow" aria-hidden="true">→</span>{@render node(data.right)}</div>{/if}
  </div>
</div>

<style>
  /* 값은 시안 `tPath` 블록의 인라인 style 그대로다. */
  .path { display: flex; flex-direction: column; gap: 12px; }
  .help { font-size: 12px; color: var(--tx3); }
  .grid { display: grid; gap: 12px; align-items: center; overflow-x: auto; }
  .side { min-width: 0; display: flex; }
  .side.right { align-items: center; gap: 6px; }
  .lanes { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .lane { display: grid; gap: 6px; align-items: start; }
  .cell { display: flex; gap: 6px; align-items: flex-start; min-width: 0; }
  .arrow { color: var(--tx3); padding-top: 10px; }
  .side.right .arrow { padding-top: 0; }
  .nd {
    flex: 1; min-width: 0; text-align: left; display: flex; flex-direction: column; gap: 4px; padding: 8px 10px;
    border: 1px solid var(--bd-strong); border-radius: var(--r-md); background: var(--bg-input); color: var(--tx); text-decoration: none;
  }
  .nd.dashed { border-style: dashed; }
  a.nd:hover { border-color: var(--accent); }
  a.nd:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  .cap { font-size: 11px; color: var(--tx3); }
  .head { font-family: var(--mono); font-size: 13px; font-weight: 500; word-break: break-all; }
  .sub { font-size: 12px; color: var(--tx2); }
  .bdg {
    align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 8px;
    border-radius: var(--r-sm); font-size: 12px; font-weight: 500;
  }
  .it { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12px; }
  .mono { font-family: var(--mono); }
  .mini { display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 6px; border-radius: var(--r-sm); }
  .recv { color: var(--tx3); }
  .none { color: var(--tx3); font-size: 13px; }
</style>
