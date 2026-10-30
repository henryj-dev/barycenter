<script lang="ts">
  /**
   * 대시보드 — `/` (2026-10-30, 경로 분리). 적용 대기는 `/change/pending` 으로 옮겼다.
   * 디자인을 들이기 전까지 쓰는 요약이다. 숫자는 이미 받은 head 모델에서 센다 — 따로 묻지 않는다.
   */
  import { getContext } from 'svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const cards = $derived([
    { href: '/traffic/listener', label: '리스너', n: desk.listeners.rows.filter((r) => r.mark !== 'leave').length },
    { href: '/traffic/pool', label: '풀', n: desk.pools.rows.length },
    { href: '/traffic/route', label: '라우트', n: desk.routes.order.length + desk.routes.passthrough.length },
    { href: '/tls/certificate', label: '인증서', n: desk.certs.rows.length },
  ]);
</script>

{#if !desk.live}
  <p class="empty">연결하면 head 요약이 여기 온다.</p>
{:else}
  <a class="pending" href="/change/pending" data-pending={desk.view !== undefined}>
    {#if desk.view !== undefined}
      적용 대기가 있다 — 커밋됐지만 트래픽에 아직 안 걸렸다. 영향을 보고 적용한다.
    {:else}
      적용 대기 없음 — head 가 트래픽에 걸려 있다.
    {/if}
  </a>
  <ul class="cards">
    {#each cards as c (c.href)}
      <li><a href={c.href}><span class="n mono">{c.n}</span><span class="label">{c.label}</span></a></li>
    {/each}
  </ul>
{/if}

<style>
  .empty { color: var(--mute); }
  .mono { font-family: var(--data); }
  .pending {
    display: block; padding: 0.8rem 1rem; border: 1px solid var(--rule); color: var(--mute);
    text-decoration: none; margin-bottom: 1.25rem;
  }
  .pending[data-pending='true'] { color: var(--ink); border-color: var(--ember); }
  .cards { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(8rem, 1fr)); gap: 0.8rem; }
  .cards a {
    display: flex; flex-direction: column; gap: 0.3rem; padding: 0.9rem 1rem;
    border: 1px solid var(--rule); background: var(--plate); color: var(--ink); text-decoration: none;
  }
  .cards a:hover { border-color: var(--ember); }
  .n { font-size: 1.6rem; }
  .label { font-size: 0.8rem; color: var(--mute); }
</style>
