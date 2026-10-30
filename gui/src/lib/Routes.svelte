<script lang="ts">
  import { getContext } from 'svelte';
  import type { Scope } from './global/scope.svelte.ts';
  import Writable from './global/Writable.svelte';
  import type { RoutesView } from '@web/routes-view';
  import AddRoute from './AddRoute.svelte';
  import AddRedirect from './AddRedirect.svelte';
  import AddReject from './AddReject.svelte';
  import AddPassthroughRoute from './AddPassthroughRoute.svelte';
  import AddPassthroughReject from './AddPassthroughReject.svelte';
  import type { RedirectStatus, RejectStatus } from '@web/edit';

  let { mode = 'list-http', view, live, editing, listeners, pools, ptListeners, tcpPools, withdraw, withdrawPt, insert, insertRedirect, insertReject, insertPt, insertPtReject }: {
    view: RoutesView;
    live: boolean;
    editing: boolean;
    listeners: string[];
    pools: string[];
    ptListeners: string[];
    tcpPools: string[];
    withdraw: (key: string) => void;
    withdrawPt: (key: string) => void;
    insert: (input: {
      key: string; listener: string; hosts: string[]; pool: string;
      pathPrefix?: string; websocket?: boolean;
      rewritePrefix?: string; requestHeaders?: string;
    }) => void;
    insertRedirect: (input: {
      key: string; listener: string; hosts: string[]; to: string;
      status: RedirectStatus; pathPrefix?: string;
    }) => void;
    insertReject: (input: {
      key: string; listener: string; hosts: string[];
      status: RejectStatus; pathPrefix?: string;
    }) => void;
    insertPt: (input: { key: string; listener: string; snis: string[]; pool: string }) => void;
    insertPtReject: (input: { key: string; listener: string; snis: string[] }) => void;
    /**
     * `list-http`·`list-passthrough` 는 목록 세그먼트(`/traffic/route/<종류>`),
     * `http`·`passthrough` 는 그 라우트의 만들기 폼(`/traffic/route/<종류>/new`).
     */
    mode?: 'list-http' | 'list-passthrough' | 'http' | 'passthrough';
  } = $props();
  // 전역 모드면 설정을 읽기만 한다 — 쓰기 버튼을 안 그린다(설계 §1).
  const scope = getContext<Scope | undefined>('scope');
  const ro = $derived(scope?.readOnly === true);
</script>

{#if !live}
  <p class="empty">연결하면 head 라우트가 여기 온다.</p>
{:else if mode === 'list-http' || mode === 'list-passthrough'}
  <div class="seg-row">
    <nav class="seg" aria-label="라우트 종류">
      <a href="/traffic/route/http" aria-current={mode === 'list-http' ? 'page' : undefined}>HTTP</a>
      <a href="/traffic/route/passthrough" aria-current={mode === 'list-passthrough' ? 'page' : undefined}>패스스루</a>
    </nav>
    <Writable>
      {#if mode === 'list-http'}
        <a class="new" href="/traffic/route/http/new">HTTP 라우트 만들기</a>
      {:else}
        <a class="new" href="/traffic/route/passthrough/new">패스스루 라우트 만들기</a>
      {/if}
    </Writable>
  </div>
  {#if mode === 'list-http'}
  {#if view.errors.length > 0}
    <ul class="notes" data-kind="error">
      {#each view.errors as note (note.kind + note.message)}
        <li>{note.message}</li>
      {/each}
    </ul>
  {/if}
  {#if view.warnings.length > 0}
    <ul class="notes" data-kind="shadow">
      {#each view.warnings as note (note.kind + note.message)}
        <li>{note.message}</li>
      {/each}
    </ul>
  {/if}

  {#if view.order.length === 0 && view.errors.length === 0}
    <p class="empty">HTTP 라우트가 없다. 「HTTP 라우트 만들기」 에서 호스트 라우트를 넣는다.</p>
  {:else if view.order.length > 0}
    <ol class="order">
      {#each view.order as row, i (row.key + row.host + row.pathPrefix)}
        <li>
          <span class="n mono">{i + 1}</span>
          <span class="host mono">{row.host}{row.pathPrefix}</span>
          <span class="cls mono">{row.matchClass}</span>
          <a class="key" href={`/traffic/route/http/${encodeURIComponent(row.key)}`}>{row.key}</a>
          <span class="pri mono">p{row.priority}</span>
          {#if !ro}
          <button type="button" disabled={editing} onclick={() => withdraw(row.key)}>설정에서 뺀다</button>
          {/if}
        </li>
      {/each}
    </ol>
  {/if}

  {:else}
  {#if view.passthrough.length === 0}
    <p class="empty">패스스루 라우트가 없다. 「패스스루 라우트 만들기」 에서 SNI 를 붙인다.</p>
  {:else}
    <ul class="pass">
      {#each view.passthrough as row (row.key)}
        <li>
          <a class="key" href={`/traffic/route/passthrough/${encodeURIComponent(row.key)}`}>{row.key}</a>
          <span class="host mono">{row.snis.join(', ')}</span>
          <span class="cls mono">{row.action}</span>
          {#if !ro}
          <button type="button" disabled={editing} onclick={() => withdrawPt(row.key)}>설정에서 뺀다</button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
  {/if}
{:else if mode === 'http'}
  <Writable>
  <AddRoute {listeners} {pools} {editing} add={insert} />
  <AddRedirect {listeners} {editing} add={insertRedirect} />
  <AddReject {listeners} {editing} add={insertReject} />
  </Writable>
{:else}
  <Writable>
  <AddPassthroughRoute listeners={ptListeners} pools={tcpPools} {editing} add={insertPt} />
  <AddPassthroughReject listeners={ptListeners} {editing} add={insertPtReject} />
  </Writable>
{/if}

<style>
  .seg-row { display: flex; justify-content: space-between; align-items: center; gap: 1rem; margin: 0 0 0.75rem; }
  .seg { display: flex; border: 1px solid var(--rule); }
  .seg a { padding: 0.3rem 0.8rem; font-size: 0.8rem; color: var(--mute); text-decoration: none; }
  .seg a[aria-current='page'] { background: var(--plate); color: var(--ink); }
  .new { color: var(--ink); font-size: 0.85rem; }
  a.key { color: inherit; text-decoration: none; border-bottom: 1px solid var(--rule); }
  .empty { color: var(--mute); }
  .notes {
    list-style: none;
    margin: 1.25rem 0 0;
    padding: 0;
    border-top: 1px solid var(--rule);
  }
  .notes li {
    font-size: 0.85rem;
    padding: 0.55rem 0;
    border-bottom: 1px solid var(--rule);
  }
  .notes[data-kind='shadow'] li { color: var(--ember); }
  .notes[data-kind='error'] li { color: var(--ember); }
  .order, .pass { list-style: none; margin: 1.25rem 0 0; padding: 0; border-top: 1px solid var(--rule); }
  .order li, .pass li {
    display: grid;
    grid-template-columns: 2rem 1fr auto auto auto auto;
    gap: 0.5rem;
    align-items: baseline;
    padding: 0.55rem 0;
    border-bottom: 1px solid var(--rule);
  }
  .pass li { grid-template-columns: 7rem 1fr auto auto; }
  .mono { font-family: var(--data); }
  .n { color: var(--mute); font-size: 0.75rem; }
  .host { font-size: 0.9rem; }
  .cls, .pri { color: var(--mute); font-size: 0.75rem; }
  .key { color: var(--mute); font-size: 0.8rem; }
  button {
    background: transparent;
    border: 1px solid var(--rule);
    color: var(--mute);
    padding: 0.2rem 0.45rem;
    font-size: 0.75rem;
    cursor: pointer;
  }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  @media (max-width: 640px) {
    .order li { grid-template-columns: 2rem 1fr auto; }
    .cls, .key { grid-column: 2; }
  }
</style>
