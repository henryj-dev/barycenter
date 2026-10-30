<script lang="ts">
  /** 클러스터 — 노드마다 세대·상태·뒤처짐 (`GET /api/v1/cluster/nodes`, ADR-CLUSTER). */
  import { getContext } from 'svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';

  type Node = {
    name: string; url?: string; role: 'leader' | 'follower'; state: string; behind: boolean;
    activeGeneration?: string; lastError?: string; lastSeen: string; stale: boolean;
  };
  type Body = { enabled: boolean; self?: string; leader?: { name: string; since: string } | null; nodes: Node[] };
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  let body = $state<Body | undefined>();
  let failed = $state(false);
  $effect(() => {
    void desk.head;
    void desk.status;
    if (!desk.live) return;
    void desk.clusterNodes().then((r) => { failed = r === undefined; body = r as Body | undefined; });
  });
</script>

{#if !desk.live}
  <p class="d-empty">연결하면 노드 상태가 여기 온다.</p>
{:else if failed}
  <p class="d-empty">노드 상태를 못 읽었다.</p>
{:else if body === undefined}
  <p class="d-empty">읽는 중이다.</p>
{:else if !body.enabled}
  <p class="d-empty">클러스터 모드가 아니다(<code>BARY_CLUSTER</code>). 이 호스트 하나가 서빙한다.</p>
{:else}
  {#if body.leader}<p class="d-note">리더 <span class="d-mono">{body.leader.name}</span> · {new Date(body.leader.since).toLocaleString()}부터</p>{/if}
  <ul class="d-list">
    {#each body.nodes as n (n.name)}
      <li>
        <a class="d-mono" href={`/ops/cluster/${encodeURIComponent(n.name)}`}>{n.name}</a>{#if n.name === body.self}<span class="d-note">이 노드</span>{/if}
        <span class="d-note">{n.role === 'leader' ? '리더' : '팔로워'}</span>
        <span class={n.state === 'in_sync' && !n.stale ? 'd-ok' : 'd-warn'}>{n.state}</span>
        {#if n.stale}<span class="d-warn">보고가 끊겼다 — {new Date(n.lastSeen).toLocaleString()} 이후</span>{/if}
        {#if n.behind}<span class="d-warn">뒤처짐</span>{/if}
        <span class="d-mono d-note">{n.activeGeneration ?? '—'}</span>
        {#if n.lastError}<span class="d-warn">{n.lastError}</span>{/if}
      </li>
    {/each}
  </ul>
{/if}
