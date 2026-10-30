<script lang="ts">
  /** 백엔드 넣기 — 풀을 먼저 고른다. `?pool=` 이 있으면 그 풀로 시작한다(풀 상세에서 온다). */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import AddBackend from '#lib/AddBackend.svelte';
  import { after } from '#lib/after';
  import Writable from '#lib/global/Writable.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const poolKeys = $derived(desk.pools.rows.map((p) => p.key));
  let pool = $state(page.url.searchParams.get('pool') ?? '');
  $effect(() => { if (pool === '' && poolKeys.length > 0) pool = poolKeys[0]!; });
</script>

{#if !desk.live}
  <p class="d-empty">연결하면 head 풀이 여기 온다.</p>
{:else if poolKeys.length === 0}
  <p class="d-empty">풀이 없다. <a class="d-link" href="/traffic/pool/new">풀 만들기</a>에서 풀과 첫 백엔드를 같이 연다.</p>
{:else}
  <Writable>
    <label class="pick"><span>풀</span>
      <select bind:value={pool} disabled={desk.editing}>
        {#each poolKeys as p (p)}<option value={p}>{p}</option>{/each}
      </select>
    </label>
    {#key pool}
      <AddBackend {pool} editing={desk.editing} add={(key, host, port) => { void desk.insertBackend(key, { pool, host, port }).then(after); }} />
    {/key}
  </Writable>
{/if}

<style>
  .pick { display: flex; flex-direction: column; gap: 0.25rem; max-width: 20rem; margin-bottom: 1rem; }
  .pick span { font-size: 0.8rem; color: var(--mute); }
  select { background: var(--plate); border: 1px solid var(--rule); color: var(--ink); padding: 0.45rem 0.6rem; }
</style>
