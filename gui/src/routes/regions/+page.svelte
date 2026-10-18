<script lang="ts">
  /**
   * 전역 첫 화면 — 지역마다 닿는가·판이 맞는가·head. 못 닿은 지역은 **모른다**로 보인다(지난 값을 지금처럼
   * 보이지 않는다). 고르면 그 지역의 읽기 화면들로 간다.
   */
  import { getContext, onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import type { Scope, RegionSummary } from '$lib/global/scope.svelte.ts';
  import type { createDesk } from '$lib/desk.svelte.ts';

  const scope = getContext<Scope>('scope');
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  let regions = $state<RegionSummary[]>([]);
  let error = $state<string | undefined>();

  const load = async (): Promise<void> => {
    const r = await fetch('/api/v1/regions', { credentials: 'same-origin' });
    if (!r.ok) { error = r.status === 401 ? '로그인이 필요하다' : `regions ${r.status}`; return; }
    regions = ((await r.json()) as { regions: RegionSummary[] }).regions;
  };
  onMount(() => { void load(); });

  const pick = async (r: RegionSummary): Promise<void> => {
    desk.disconnect();
    scope.choose(r);
    await desk.connect();
    await goto('/');
  };
  const stateOf = (r: RegionSummary): string => {
    if (!r.reachable) return '모른다 — 닿지 않는다';
    if (r.auth === 'rejected') return '인증 거절 — 전역 토큰 설정을 본다';
    if (r.status === undefined) return '모른다 — 응답이 이상하다';
    return `head r${r.status.head ?? '?'}`;
  };
</script>

{#if error !== undefined}<p class="err" role="alert">{error}</p>{/if}
<table>
  <thead><tr><th>지역</th><th>상태</th><th>판</th><th>마지막 확인</th><th></th></tr></thead>
  <tbody>
    {#each regions as r (r.name)}
      <tr class:down={!r.reachable || r.auth === 'rejected'}>
        <td>{r.name}</td>
        <td>{stateOf(r)}</td>
        <td>
          {r.regionBuild ?? '모른다'}
          {#if r.buildMismatch === true}<span class="warn" title="전역과 판이 다르다 — 화면이 어긋날 수 있다">판 다름</span>{/if}
        </td>
        <td class="mono">{(r.lastOkAt ?? '').slice(0, 19).replace('T', ' ') || '—'}</td>
        <td class="ops">
          {#if r.reachable && r.auth === undefined}<button type="button" onclick={() => { void pick(r); }}>보기</button>{/if}
          <a href={r.gui} target="_blank" rel="noopener">지역 GUI</a>
        </td>
      </tr>
    {/each}
  </tbody>
</table>
<button type="button" class="quiet" onclick={() => { void load(); }}>다시 묻기</button>

<style>
  table { border-collapse: collapse; width: 100%; font-size: 0.9rem; margin: 1rem 0; }
  th, td { text-align: left; padding: 0.4rem; border-bottom: 1px solid var(--rule); }
  th { color: var(--mute); font-weight: 400; font-size: 0.8rem; }
  .down td { color: var(--mute); }
  .warn { margin-left: 0.4rem; color: var(--ember); font-size: 0.8rem; }
  .mono { font-family: var(--data); }
  .ops { white-space: nowrap; display: flex; gap: 0.6rem; align-items: center; }
  button { background: var(--plate); border: 1px solid var(--rule); color: var(--ink); padding: 0.3rem 0.7rem; cursor: pointer; }
  .quiet { border-color: transparent; color: var(--mute); }
  .err { color: var(--ember); }
</style>
