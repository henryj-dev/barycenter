<script lang="ts">
  /** 클러스터 노드 하나 — 시안의 노드 상세: 마지막 오류 · 최근 적용 기록 · 노드 GUI 주소. */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import type { createDesk } from '#lib/desk.svelte.ts';

  type Node = {
    name: string; url?: string; role: 'leader' | 'follower'; state: string; behind: boolean;
    activeGeneration?: string; lastError?: string; lastSeen: string; stale: boolean;
  };
  type Rec = { at: string; revision?: string; generation?: string; phase?: string };
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const name = $derived(page.params['node'] ?? '');
  let node = $state<Node | undefined | null>();
  let recs = $state<Rec[] | undefined>();
  $effect(() => {
    void desk.head;
    void desk.status;
    if (!desk.live) return;
    const n = name;
    void desk.clusterNodes().then((r) => {
      const nodes = ((r as { nodes?: Node[] } | undefined)?.nodes ?? []);
      node = nodes.find((x) => x.name === n) ?? null;
    });
    void desk.clusterHistory(n).then((r) => { recs = (r ?? []) as Rec[]; });
  });
</script>

<p class="crumb"><a href="/ops/cluster">클러스터</a> / <span class="d-mono">{name}</span></p>
{#if !desk.live}
  <p class="d-empty">연결하면 노드 상태가 여기 온다.</p>
{:else if node === undefined}
  <p class="d-empty">읽는 중이다.</p>
{:else if node === null}
  <p class="d-empty">노드 <span class="d-mono">{name}</span> 가 클러스터에 없다. <a class="d-link" href="/ops/cluster">목록</a>으로 간다.</p>
{:else}
  <dl class="d-dl">
    <dt>역할</dt><dd>{node.role === 'leader' ? '리더' : '팔로워'}</dd>
    <dt>상태</dt><dd class={node.state === 'in_sync' && !node.stale ? 'd-ok' : 'd-warn'}>{node.state}{node.behind ? ' · 뒤처짐' : ''}</dd>
    <dt>활성 세대</dt><dd>{node.activeGeneration ?? '—'}</dd>
    <dt>마지막 신호</dt><dd>{new Date(node.lastSeen).toLocaleString()}{node.stale ? ' — 끊겼다' : ''}</dd>
    <dt>마지막 오류</dt><dd class={node.lastError ? 'd-warn' : ''}>{node.lastError ?? '없음'}</dd>
    {#if node.url}<dt>노드 GUI</dt><dd><a class="d-link" href={node.url} target="_blank" rel="noopener">{node.url} ↗</a></dd>{/if}
  </dl>
  <h3 class="d-h3">최근 적용 기록</h3>
  {#if recs === undefined}
    <p class="d-empty">읽는 중이다.</p>
  {:else if recs.length === 0}
    <p class="d-empty">따라간 기록이 없다. 리더는 직접 적용하므로 여기 안 남는다.</p>
  {:else}
    <ol class="d-list">
      {#each recs as r, i (i)}
        <li><span class="d-mono">{r.generation ?? '?'}</span><span class="d-note">{r.phase ?? ''}</span><span class="d-note">{new Date(r.at).toLocaleString()}</span></li>
      {/each}
    </ol>
  {/if}
{/if}

<style>
  .crumb { font-size: 0.8rem; color: var(--mute); margin: 0 0 1rem; }
  .crumb a { color: var(--mute); }
</style>
