<script lang="ts">
  import { getContext } from 'svelte';
  import type { Scope } from './global/scope.svelte.ts';
  import Writable from './global/Writable.svelte';
  import type { KeylessAlgorithm } from '@web/edit';
  import { trafficMarkOf } from '@web/pools-view';
  import type { PoolsView } from '@web/pools-view';
  import type { ProtocolClass } from '@web/edit';
    import AddPool from './AddPool.svelte';
  import AddHashPool from './AddHashPool.svelte';
  import AddSourceIpHashPool from './AddSourceIpHashPool.svelte';

  let { mode = 'list', view, live, editing, traffic, withdraw, withdrawPool, drain, insert, openPool, openHashPool, openSourceIpHashPool }: {
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
      algorithm: KeylessAlgorithm;
    }) => void;
    openHashPool: (input: {
      pool: string; protocolClass: ProtocolClass; hashKey: string;
      backend: string; host: string; port: number;
    }) => void;
    openSourceIpHashPool: (input: {
      pool: string; protocolClass: ProtocolClass; backend: string; host: string; port: number;
    }) => void;
    /** `list` 는 풀·백엔드 표, `new` 는 풀 만들기 폼 (`/traffic/pool/new`). */
    mode?: 'list' | 'new';
  } = $props();
  // 전역 모드면 설정을 읽기만 한다 — 쓰기 버튼을 안 그린다(설계 §1).
  const scope = getContext<Scope | undefined>('scope');
  const ro = $derived(scope?.readOnly === true);

  const label = (state: string): string => {
    if (state === 'healthy') return '살아 있다';
    if (state === 'unhealthy') return '빠진다';
    return '아직 안 쟀다';
  };
</script>

{#if !live}
  <p class="empty">연결하면 head 풀이 여기 온다.</p>
{:else if mode === 'list'}
  <Writable><p class="new"><a href="/traffic/pool/new">풀 만들기</a> · <a href="/traffic/backend/new">백엔드 넣기</a></p></Writable>
  {#if view.rows.length === 0}
    <p class="empty">풀이 없다. 「풀 만들기」 에서 풀과 첫 백엔드를 같이 연다.</p>
  {:else}
  <div class="pools">
    {#each view.rows as pool (pool.key)}
      <section>
        <header>
          <h2><a href={`/traffic/pool/${encodeURIComponent(pool.key)}`}>{pool.key}</a></h2>
          <p class="meta mono">{pool.protocolClass} · {pool.algorithm}</p>
          <p class="tally">
            <span data-state="healthy">{pool.healthy}</span>
            <span data-state="unknown">{pool.unknown}</span>
            <span data-state="unhealthy">{pool.unhealthy}</span>
          </p>
          {#if !ro}
          <button
            type="button"
            disabled={editing}
            onclick={() => withdrawPool(pool.key)}
          >설정에서 뺀다</button>
          {/if}
        </header>
        {#if pool.backends.length === 0}
          <p class="empty">백엔드가 없다.</p>
        {:else}
          <ul>
            {#each pool.backends as be (be.key)}
              <li data-state={be.state}>
                <a class="name" href={`/traffic/backend/${encodeURIComponent(be.key)}`}>{be.key}</a>
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
                {#if !ro}
                <button
                  type="button"
                  disabled={editing}
                  onclick={() => drain(be.key)}
                >드레인</button>
                {/if}
                {#if !ro}
                <button
                  type="button"
                  disabled={editing}
                  onclick={() => withdraw(be.key)}
                >설정에서 뺀다</button>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/each}
  </div>
  {/if}
{:else}
  <Writable>
  <AddPool {editing} add={openPool} />
  <AddHashPool {editing} add={openHashPool} />
  <AddSourceIpHashPool {editing} add={openSourceIpHashPool} />
  </Writable>
{/if}

<style>
  .new { margin: 0 0 0.5rem; text-align: right; }
  .new a { color: var(--ink); font-size: 0.85rem; }
  h2 a, a.name { color: inherit; text-decoration: none; border-bottom: 1px solid var(--rule); }
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
