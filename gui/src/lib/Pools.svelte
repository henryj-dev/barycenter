<script lang="ts">
  import type { PoolsView } from '@web/pools-view';
  import AddBackend from './AddBackend.svelte';

  let { view, live, editing, withdraw, insert }: {
    view: PoolsView;
    live: boolean;
    editing: boolean;
    withdraw: (key: string) => void;
    insert: (pool: string, key: string, host: string, port: number) => void;
  } = $props();

  const label = (state: string): string => {
    if (state === 'healthy') return '살아 있다';
    if (state === 'unhealthy') return '빠진다';
    return '아직 안 쟀다';
  };
</script>

{#if !live}
  <p class="empty">연결하면 head 풀이 여기 온다.</p>
{:else if view.rows.length === 0}
  <p class="empty">풀이 없다. <code>bary import</code> 로 연다.</p>
{:else}
  <div class="pools">
    {#each view.rows as pool (pool.key)}
      <section>
        <header>
          <h2>{pool.key}</h2>
          <p class="meta mono">{pool.protocolClass} · {pool.algorithm}</p>
          <p class="tally">
            <span data-state="healthy">{pool.healthy}</span>
            <span data-state="unknown">{pool.unknown}</span>
            <span data-state="unhealthy">{pool.unhealthy}</span>
          </p>
        </header>
        {#if pool.backends.length === 0}
          <p class="empty">백엔드가 없다.</p>
        {:else}
          <ul>
            {#each pool.backends as be (be.key)}
              <li data-state={be.state}>
                <span class="name">{be.key}</span>
                <span class="addr mono">{be.host}:{be.port}</span>
                <span class="mark">{label(be.state)}</span>
                <button
                  type="button"
                  disabled={editing}
                  onclick={() => withdraw(be.key)}
                >설정에서 뺀다</button>
              </li>
            {/each}
          </ul>
        {/if}
        <AddBackend
          pool={pool.key}
          {editing}
          add={(key, host, port) => insert(pool.key, key, host, port)}
        />
      </section>
    {/each}
  </div>
{/if}

<style>
  .empty { color: var(--mute); }
  .empty code { font-family: var(--data); font-size: 0.85em; }
  .pools { margin-top: 1.5rem; }
  section { border-top: 1px solid var(--rule); padding: 1rem 0 0.4rem; }
  header {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0.2rem 1rem;
    margin-bottom: 0.5rem;
  }
  h2 { font-size: 1.05rem; margin: 0; font-weight: 600; }
  .meta { margin: 0; color: var(--mute); font-size: 0.75rem; }
  .tally { margin: 0; grid-row: 1 / span 2; align-self: center; font-family: var(--data); font-size: 0.8rem; }
  .tally span { margin-left: 0.55rem; }
  .tally [data-state='healthy'] { color: var(--moss); }
  .tally [data-state='unknown'] { color: var(--mute); }
  .tally [data-state='unhealthy'] { color: var(--ember); }
  ul { list-style: none; margin: 0; padding: 0; }
  li {
    display: grid;
    grid-template-columns: 7rem 1fr auto auto;
    gap: 0.6rem;
    padding: 0.45rem 0;
    border-top: 1px solid var(--rule);
  }
  .mono { font-family: var(--data); }
  .name { font-size: 0.9rem; }
  .addr { color: var(--mute); font-size: 0.8rem; }
  .mark { font-size: 0.75rem; color: var(--mute); }
  button {
    background: transparent;
    border: 1px solid var(--rule);
    color: var(--mute);
    padding: 0.2rem 0.45rem;
    font-size: 0.75rem;
    cursor: pointer;
  }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  li[data-state='healthy'] .mark { color: var(--moss); }
  li[data-state='unhealthy'] .mark { color: var(--ember); }
  li[data-state='unhealthy'] .name { text-decoration: line-through; color: var(--ember); }
  @media (max-width: 640px) {
    li { grid-template-columns: 1fr auto; }
    .addr { grid-column: 1; }
  }
</style>
