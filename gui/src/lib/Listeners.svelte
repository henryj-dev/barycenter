<script lang="ts">
  import type { ListenersView } from '@web/listeners-view';
  import type { UdpPreset } from '@web/edit';
  import AddListener from './AddListener.svelte';
  import AddTcpListener from './AddTcpListener.svelte';
  import AddUdpListener from './AddUdpListener.svelte';

  let { view, live, editing, pools, tcpPools, udpPools, withdraw, insert, insertTcp, insertUdp }: {
    view: ListenersView;
    live: boolean;
    editing: boolean;
    pools: string[];
    tcpPools: string[];
    udpPools: string[];
    withdraw: (key: string) => void;
    insert: (key: string, bind: string, port: number, pool: string) => void;
    insertTcp: (key: string, bind: string, port: number, pool: string) => void;
    insertUdp: (key: string, bind: string, port: number, pool: string, preset: UdpPreset) => void;
  } = $props();

  const label = (mark: string): string => {
    if (mark === 'join') return '적용하면 열린다';
    if (mark === 'leave') return '적용하면 닫힌다';
    return '서빙 중';
  };
</script>

{#if !live}
  <p class="empty">연결하면 head 리스너가 여기 온다.</p>
{:else}
  {#if view.rows.length === 0}
    <p class="empty">리스너가 없다. 아래에서 HTTP · TCP · UDP 포트를 연다.</p>
  {:else}
    <ul class="ports">
      {#each view.rows as row (row.socket + row.key)}
        <li data-mark={row.mark} data-enabled={row.enabled}>
          <span class="port mono">{row.bind}:{row.port}</span>
          <span class="proto mono">{row.protocol}</span>
          <span class="key">{row.mark === 'leave' ? row.socket : row.key}</span>
          <span class="mark">{label(row.mark)}</span>
          {#if row.mark !== 'leave'}
            <button type="button" disabled={editing} onclick={() => withdraw(row.key)}>설정에서 뺀다</button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
  <AddListener {pools} {editing} add={insert} />
  <AddTcpListener pools={tcpPools} {editing} add={insertTcp} />
  <AddUdpListener pools={udpPools} {editing} add={insertUdp} />
{/if}

<style>
  .empty { color: var(--mute); }
  .ports { list-style: none; margin: 1.5rem 0 0; padding: 0; border-top: 1px solid var(--rule); }
  li {
    display: grid;
    grid-template-columns: 11rem 5.5rem 1fr auto auto;
    gap: 0.6rem;
    align-items: baseline;
    padding: 0.7rem 0;
    border-bottom: 1px solid var(--rule);
  }
  .mono { font-family: var(--data); }
  .port { font-size: 0.95rem; }
  .proto { color: var(--mute); font-size: 0.8rem; }
  .key { color: var(--mute); font-size: 0.85rem; }
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
  li[data-mark='join'] .port,
  li[data-mark='join'] .mark { color: var(--moss); }
  li[data-mark='leave'] .port,
  li[data-mark='leave'] .mark { color: var(--ember); }
  li[data-mark='leave'] .port { text-decoration: line-through; }
  li[data-enabled='false'] { opacity: 0.45; }
  @media (max-width: 640px) {
    li { grid-template-columns: 1fr auto; }
    .proto, .key { grid-column: 1; }
  }
</style>
