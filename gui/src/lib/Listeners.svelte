<script lang="ts">
  import type { ListenersView } from '@web/listeners-view';

  let { view, live }: { view: ListenersView; live: boolean } = $props();

  const label = (mark: string): string => {
    if (mark === 'join') return '적용하면 열린다';
    if (mark === 'leave') return '적용하면 닫힌다';
    return '서빙 중';
  };
</script>

{#if !live}
  <p class="empty">연결하면 head 리스너가 여기 온다.</p>
{:else if view.rows.length === 0}
  <p class="empty">리스너가 없다. <code>bary import</code> 로 연다.</p>
{:else}
  <ul class="ports">
    {#each view.rows as row (row.socket + row.key)}
      <li data-mark={row.mark} data-enabled={row.enabled}>
        <span class="port mono">{row.bind}:{row.port}</span>
        <span class="proto mono">{row.protocol}</span>
        <span class="key">{row.mark === 'leave' ? row.socket : row.key}</span>
        <span class="mark">{label(row.mark)}</span>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .empty { color: var(--mute); }
  .empty code { font-family: var(--data); font-size: 0.85em; }
  .ports { list-style: none; margin: 1.5rem 0 0; padding: 0; border-top: 1px solid var(--rule); }
  li {
    display: grid;
    grid-template-columns: 11rem 5.5rem 1fr auto;
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
