<script lang="ts">
  /** 백엔드의 헬스 탭 — 헬스 판정 · 트래픽을 안 받는 이유 · 드레인. */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import Writable from '#lib/global/Writable.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const health = $derived(desk.health.find((h) => h.backendKey === key)?.state ?? 'unknown');
  const traffic = $derived(desk.traffic.get(key));
</script>

<dl class="d-dl">
  <dt>헬스</dt>
  <dd class={health === 'healthy' ? 'd-ok' : health === 'unhealthy' ? 'd-warn' : ''}>{health === 'unknown' ? 'unknown — 아직 재지 못했다' : health}</dd>
  <dt>트래픽 수신</dt>
  <dd>
    {#if traffic === undefined}
      모른다 — 상태 API 를 못 읽었다
    {:else if traffic.receivingTraffic}
      <span class="d-ok">받는 중</span>
    {:else}
      <span class="d-warn">안 받는다</span>
    {/if}
  </dd>
  {#if traffic !== undefined && traffic.reasons.length > 0}
    <dt>이유</dt>
    <dd>{traffic.reasons.join(' · ')}</dd>
  {/if}
</dl>
<Writable>
  <p><button type="button" disabled={desk.editing} onclick={() => { void desk.drain(key); }}>드레인</button>
  <span class="d-note">새 연결을 안 보낸다. 진행 중인 연결은 끝까지 간다. 설정(commit)이 아니다.</span></p>
</Writable>

<style>
  button { background: var(--plate); border: 1px solid var(--rule); color: var(--ink); padding: 0.35rem 0.75rem; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
