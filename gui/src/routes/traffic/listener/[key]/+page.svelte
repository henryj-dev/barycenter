<script lang="ts">
  /**
   * 리스너 상세 — `/traffic/listener/<key>` (2026-10-30, 경로 분리).
   * head 모델을 그린다. 수정은 `/edit` 에서, 빼기는 여기서 한다. 둘 다 저장(commit)까지이고 적용은 아니다.
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { detailOfListener } from '@web/listeners-view';
  import { after } from '#lib/after';
  import Writable from '#lib/global/Writable.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const model = $derived(desk.listenerModels.find((l) => l['key'] === key));
  const row = $derived(desk.listeners.rows.find((r) => r.key === key && r.mark !== 'leave'));
  const lines = $derived(model === undefined ? [] : detailOfListener(model));
  const mark = $derived(row?.mark === 'join' ? '적용하면 열린다' : '서빙 중');
</script>

<p class="crumb"><a href="/traffic/listener">리스너</a> / <span class="mono">{key}</span></p>

{#if !desk.live}
  <p class="empty">연결하면 head 리스너가 여기 온다.</p>
{:else if model === undefined}
  <p class="empty">리스너 <span class="mono">{key}</span> 가 head 에 없다. 이름을 확인하거나 <a href="/traffic/listener">목록</a>으로 간다.</p>
{:else}
  <h2 class="mono">{key} <span class="mark" data-mark={row?.mark}>{mark}</span></h2>
  <dl>
    {#each lines as line (line.label)}
      <dt>{line.label}</dt>
      <dd class="mono">{line.value}</dd>
    {/each}
  </dl>
  <Writable>
    <p class="actions">
      <a class="button" href={`/traffic/listener/${encodeURIComponent(key)}/edit`}>수정</a>
      <button type="button" disabled={desk.editing} onclick={() => { void desk.withdraw('listener', key).then(after); }}>
        설정에서 뺀다
      </button>
    </p>
  </Writable>
  <details>
    <summary>전체 정의 (head 모델)</summary>
    <pre class="mono">{JSON.stringify(model, null, 2)}</pre>
  </details>
{/if}

<style>
  .crumb { font-size: 0.8rem; color: var(--mute); margin: 0 0 1rem; }
  .crumb a, .empty a { color: var(--mute); }
  .empty { color: var(--mute); }
  .mono { font-family: var(--data); }
  h2 { font-size: 1.1rem; margin: 0 0 1rem; display: flex; gap: 0.8rem; align-items: baseline; }
  .mark { font-size: 0.75rem; color: var(--mute); font-weight: 400; }
  .mark[data-mark='join'] { color: var(--moss); }
  dl { display: grid; grid-template-columns: 9rem 1fr; gap: 0.45rem 1rem; margin: 0 0 1.25rem; }
  dt { color: var(--mute); font-size: 0.85rem; }
  dd { margin: 0; font-size: 0.9rem; overflow-wrap: anywhere; }
  .actions { display: flex; gap: 0.6rem; }
  .button, button {
    background: var(--plate); border: 1px solid var(--rule); color: var(--ink);
    padding: 0.4rem 0.8rem; font-size: 0.85rem; cursor: pointer; text-decoration: none;
  }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  details { margin-top: 1.5rem; }
  summary { color: var(--mute); font-size: 0.85rem; cursor: pointer; }
  pre { background: var(--plate); border: 1px solid var(--rule); padding: 0.75rem; font-size: 0.78rem; overflow-x: auto; }
</style>
