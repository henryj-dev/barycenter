<script lang="ts">
  import type { AuditView } from '@web/audit-view';

  let { view, live }: { view: AuditView; live: boolean } = $props();
</script>

{#if !live}
  <p class="empty">연결하면 기록이 여기 온다.</p>
{:else if view.rows.length === 0}
  <p class="empty">기록이 없다.</p>
{:else}
  <ul class="log">
    {#each view.rows as row (row.id)}
      <li>
        <span class="when mono">{row.at ?? '—'}</span>
        <span class="who mono">{row.principal}</span>
        <span class="act">{row.action}</span>
        <span class="sub mono">{row.subject ?? '—'}</span>
        {#if row.revision !== undefined}
          <span class="rev mono">r{row.revision}</span>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .empty { color: var(--mute); }
  .log {
    list-style: none;
    margin: 1.5rem 0 0;
    padding: 0.9rem 0 2rem;
    border-top: 1px solid var(--rule);
  }
  li {
    display: grid;
    grid-template-columns: minmax(8rem, auto) minmax(4rem, auto) 1fr minmax(4rem, auto) auto;
    gap: 0.6rem 0.85rem;
    padding: 0.45rem 0;
    border-bottom: 1px solid var(--rule);
    font-size: 0.8rem;
    align-items: baseline;
  }
  .mono { font-family: var(--data); }
  .when, .who, .sub, .rev { color: var(--mute); }
  .act { color: var(--ink); }
  @media (max-width: 640px) {
    li { grid-template-columns: 1fr 1fr; }
  }
</style>
