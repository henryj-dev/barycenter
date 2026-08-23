<script lang="ts">
  import { trafficMarkOf } from '@web/pools-view';
  import type { PoolsView } from '@web/pools-view';
  import type { ProtocolClass } from '@web/edit';
  import AddBackend from './AddBackend.svelte';
  import AddPool from './AddPool.svelte';
  import AddHashPool from './AddHashPool.svelte';
  import AddSourceIpHashPool from './AddSourceIpHashPool.svelte';

  let { view, live, editing, traffic, withdraw, withdrawPool, drain, insert, openPool, openHashPool, openSourceIpHashPool }: {
    view: PoolsView;
    live: boolean;
    editing: boolean;
    withdraw: (key: string) => void;
    withdrawPool: (key: string) => void;
    /** 제안 #9. 없으면 아무 말도 안 한다 — 못 읽은 것과 받는 중은 다르다. */
    traffic?: Map<string, { receivingTraffic: boolean; reasons: string[] }>;
    drain: (key: string) => void;
    insert: (pool: string, key: string, host: string, port: number) => void;
    openPool: (input: {
      pool: string; protocolClass: ProtocolClass; backend: string; host: string; port: number;
    }) => void;
    openHashPool: (input: {
      pool: string; protocolClass: ProtocolClass; hashKey: string;
      backend: string; host: string; port: number;
    }) => void;
    openSourceIpHashPool: (input: {
      pool: string; protocolClass: ProtocolClass; backend: string; host: string; port: number;
    }) => void;
  } = $props();

  const label = (state: string): string => {
    if (state === 'healthy') return '살아 있다';
    if (state === 'unhealthy') return '빠진다';
    return '아직 안 쟀다';
  };
</script>

{#if !live}
  <p class="empty">연결하면 head 풀이 여기 온다.</p>
{:else}
  {#if view.rows.length === 0}
    <p class="empty">풀이 없다. 아래에서 풀과 첫 백엔드를 같이 연다.</p>
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
          <button
            type="button"
            disabled={editing}
            onclick={() => withdrawPool(pool.key)}
          >설정에서 뺀다</button>
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
                {#if trafficMarkOf(traffic?.get(be.key)) !== undefined}
                  <!--
                    **헬스 칸을 덮어쓰지 않는다** (제안 #9). 이 API 가 답하려던 것은
                    정확히 "헬스는 초록인데 트래픽이 0" 인 경우다 — 같은 칸에 쓰면
                    그 구분이 사라진다.
                  -->
                  <span class="why" title={trafficMarkOf(traffic?.get(be.key))!.reasons.join(' · ')}>
                    트래픽 없음{#if trafficMarkOf(traffic?.get(be.key))!.reasons.length > 0}
                      — {trafficMarkOf(traffic?.get(be.key))!.reasons.join(' · ')}
                    {/if}
                  </span>
                {/if}
                <button
                  type="button"
                  disabled={editing}
                  onclick={() => drain(be.key)}
                >드레인</button>
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
  <AddPool {editing} add={openPool} />
  <AddHashPool {editing} add={openHashPool} />
  <AddSourceIpHashPool {editing} add={openSourceIpHashPool} />
{/if}

<style>
  .empty { color: var(--mute); }
  .pools { margin-top: 1.5rem; }
  section { border-top: 1px solid var(--rule); padding: 1rem 0 0.4rem; }
  header {
    display: grid;
    grid-template-columns: 1fr auto auto;
    gap: 0.2rem 1rem;
    margin-bottom: 0.5rem;
    align-items: center;
  }
  h2 { font-size: 1.05rem; margin: 0; font-weight: 600; }
  .meta { margin: 0; color: var(--mute); font-size: 0.75rem; }
  .tally { margin: 0; font-family: var(--data); font-size: 0.8rem; }
  .tally span { margin-left: 0.55rem; }
  .tally [data-state='healthy'] { color: var(--moss); }
  .tally [data-state='unknown'] { color: var(--mute); }
  .tally [data-state='unhealthy'] { color: var(--ember); }
  ul { list-style: none; margin: 0; padding: 0; }
  li {
    display: grid;
    grid-template-columns: 7rem 1fr auto auto auto;
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
  .why {
    grid-column: 1 / -1;
    font-size: 0.7rem;
    color: var(--mute);
    padding-left: 0.2rem;
  }
</style>
