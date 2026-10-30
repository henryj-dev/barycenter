<script lang="ts">
  /**
   * HTTP 라우트를 URL 로 다시 만든다 (시안: 「URL로 다시 만들기」).
   *
   * 라우트의 리스너·호스트·경로는 그대로 두고 대상을 새 URL 로 바꾼다. 이름이 같은 풀과
   * `<이름>-1` 백엔드를 만들거나 덮는다 — 펴는 규칙은 빠른 프록시와 같다(`proxyFromUrlPatch`).
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { proxyFromUrlPatch } from '@web/edit';
  import { itemOf } from '@web/resources';
  import { after } from '#lib/after';
  import Writable from '#lib/global/Writable.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const route = $derived(itemOf(desk.model, 'httpRoute', key));
  let url = $state('');
  let confirmed = $state(false);
  const input = $derived(route === undefined ? undefined : {
    name: key,
    url: url.trim(),
    listener: String(route['listener']),
    hosts: Array.isArray(route['hosts']) ? route['hosts'] as string[] : [],
    ...(typeof route['pathPrefix'] === 'string' ? { pathPrefix: route['pathPrefix'] } : {}),
  });
  const preview = $derived.by((): { ops: { kind: string; key: string }[]; error?: string } => {
    if (input === undefined || input.url === '') return { ops: [], error: '새 URL 을 넣으면 만들 리소스가 여기 보인다.' };
    try {
      return { ops: proxyFromUrlPatch(input).map((o) => ({ kind: o.kind, key: o.key })) };
    } catch (e) {
      return { ops: [], error: e instanceof Error ? e.message : String(e) };
    }
  });
  const existing = $derived(preview.ops.filter((o) => (o.kind === 'pool' || o.kind === 'backend')
    && itemOf(desk.model, o.kind, o.key) !== undefined));
</script>

{#if route !== undefined && input !== undefined}
  <Writable>
    <form class="rb" onsubmit={(e) => { e.preventDefault(); if (confirmed) void desk.proxyFromUrl(input).then(after); }}>
      <p class="d-note">리스너 <span class="d-mono">{String(route['listener'])}</span> · 호스트 <span class="d-mono">{input.hosts.join(', ')}</span> · 경로 <span class="d-mono">{input.pathPrefix ?? '/'}</span> 는 그대로다. 대상만 바뀐다.</p>
      <label><span>새 대상 URL</span><input class="d-mono" bind:value={url} placeholder="http://10.0.0.5:8080/" /></label>
      {#if preview.error !== undefined}
        <p class="d-note">{preview.error}</p>
      {:else}
        <ul class="d-list">{#each preview.ops as o (o.kind + o.key)}<li><span class="d-note">{o.kind}</span><span class="d-mono">{o.key}</span>{#if existing.some((x) => x.kind === o.kind && x.key === o.key)}<span class="d-warn">이미 있다 — 덮는다</span>{/if}</li>{/each}</ul>
      {/if}
      <label class="check"><input type="checkbox" bind:checked={confirmed} /> <span>위 영향을 확인했다</span></label>
      <p><button type="submit" disabled={desk.editing || !confirmed || preview.error !== undefined}>확인</button></p>
    </form>
  </Writable>
{/if}

<style>
  .rb { display: flex; flex-direction: column; gap: 0.8rem; }
  label { display: flex; flex-direction: column; gap: 0.25rem; }
  label span { font-size: 0.8rem; color: var(--mute); }
  .check { flex-direction: row; align-items: center; gap: 0.5rem; }
  input:not([type='checkbox']) { background: var(--plate); border: 1px solid var(--rule); color: var(--ink); padding: 0.45rem 0.6rem; }
  button { background: var(--plate); border: 1px solid var(--rule); color: var(--ink); padding: 0.5rem 0.95rem; cursor: pointer; align-self: flex-start; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
