<script lang="ts">
  import type { RoutesView } from '@web/routes-view';
  import AddRoute from './AddRoute.svelte';

  let { view, live, editing, listeners, pools, withdraw, insert }: {
    view: RoutesView;
    live: boolean;
    editing: boolean;
    listeners: string[];
    pools: string[];
    withdraw: (key: string) => void;
    insert: (input: {
      key: string; listener: string; hosts: string[]; pool: string; pathPrefix?: string;
    }) => void;
  } = $props();
</script>

{#if !live}
  <p class="empty">연결하면 head 라우트가 여기 온다.</p>
{:else}
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
    <p class="empty">HTTP 라우트가 없다. 아래에서 호스트 라우트를 넣는다.</p>
  {:else if view.order.length > 0}
    <ol class="order">
      {#each view.order as row, i (row.key + row.host + row.pathPrefix)}
        <li>
          <span class="n mono">{i + 1}</span>
          <span class="host mono">{row.host}{row.pathPrefix}</span>
          <span class="cls mono">{row.matchClass}</span>
          <span class="key">{row.key}</span>
          <span class="pri mono">p{row.priority}</span>
          <button type="button" disabled={editing} onclick={() => withdraw(row.key)}>설정에서 뺀다</button>
        </li>
      {/each}
    </ol>
  {/if}

  {#if view.passthrough.length > 0}
    <h2>패스스루</h2>
    <ul class="pass">
      {#each view.passthrough as row (row.key)}
        <li>
          <span class="key">{row.key}</span>
          <span class="host mono">{row.snis.join(', ')}</span>
          <span class="cls mono">{row.action}</span>
        </li>
      {/each}
    </ul>
  {/if}
  <AddRoute {listeners} {pools} {editing} add={insert} />
{/if}

<style>
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
  .pass li { grid-template-columns: 7rem 1fr auto; }
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
  h2 { font-size: 0.85rem; color: var(--mute); font-weight: 600; margin: 1.5rem 0 0; }
  @media (max-width: 640px) {
    .order li { grid-template-columns: 2rem 1fr auto; }
    .cls, .key { grid-column: 2; }
  }
</style>
