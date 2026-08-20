<script lang="ts">
  import type { CertsView } from '@web/certs-view';
  import AddCert from './AddCert.svelte';
  import AddSniBinding from './AddSniBinding.svelte';

  let { view, live, editing, insert, listeners, certificates, bindings, insertSni, withdrawSni, withdraw }: {
    view: CertsView;
    live: boolean;
    editing: boolean;
    insert: (key: string, fullchain: string, privkey: string) => void;
    listeners: string[];
    certificates: string[];
    bindings: { key: string; listener: string; hosts: string[]; certificate: string }[];
    insertSni: (input: { key: string; listener: string; hosts: string[]; certificate: string }) => void;
    withdrawSni: (key: string) => void;
    withdraw: (key: string) => void;
  } = $props();

  const label = (mark: string, days: number | undefined): string => {
    if (mark === 'missing') return '자료가 없다';
    if (mark === 'expired') return `${Math.abs(days ?? 0)}일 전에 죽었다`;
    if (days === undefined) return '만료를 모른다';
    return `${days}일 남았다`;
  };
</script>

{#if !live}
  <p class="empty">연결하면 head 인증서가 여기 온다.</p>
{:else if view.rows.length === 0}
  <p class="empty">인증서가 없다. 아래에서 자료를 넣는다.</p>
{:else}
  <ul class="certs">
    {#each view.rows as row (row.key)}
      <li data-mark={row.mark}>
        <span class="key">{row.key}</span>
        <span class="dom mono">{row.domains.join(', ') || '—'}</span>
        <span class="src">{row.acme ? (row.orderState ?? 'acme') : '자료'}</span>
        <span class="mark">{label(row.mark, row.expiresInDays)}</span>
        <button type="button" disabled={editing} onclick={() => withdraw(row.key)}>설정에서 뺀다</button>
      </li>
    {/each}
  </ul>
{/if}
{#if live}
  <AddCert {editing} add={insert} />
  {#if bindings.length > 0}
    <h2>SNI</h2>
    <ul class="binds">
      {#each bindings as row (row.key)}
        <li>
          <span class="key">{row.key}</span>
          <span class="dom mono">{row.hosts.join(', ')}</span>
          <span class="src">{row.listener} → {row.certificate}</span>
          <button type="button" disabled={editing} onclick={() => withdrawSni(row.key)}>설정에서 뺀다</button>
        </li>
      {/each}
    </ul>
  {/if}
  <AddSniBinding {listeners} {certificates} {editing} add={insertSni} />
{/if}

<style>
  .empty { color: var(--mute); }
  .certs { list-style: none; margin: 1.5rem 0 0; padding: 0; border-top: 1px solid var(--rule); }
  li {
    display: grid;
    grid-template-columns: 8rem 1fr auto auto auto;
    gap: 0.6rem;
    align-items: baseline;
    padding: 0.65rem 0;
    border-bottom: 1px solid var(--rule);
  }
  .mono { font-family: var(--data); }
  .key { font-size: 0.95rem; }
  .dom { color: var(--mute); font-size: 0.8rem; }
  .src { color: var(--mute); font-size: 0.75rem; }
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
  li[data-mark='expired'] .key,
  li[data-mark='expired'] .mark { color: var(--ember); }
  li[data-mark='missing'] .mark { color: var(--ember); }
  h2 { font-size: 0.85rem; color: var(--mute); font-weight: 600; margin: 1.5rem 0 0; }
  .binds { list-style: none; margin: 0.4rem 0 0; padding: 0; border-top: 1px solid var(--rule); }
  .binds li {
    display: grid;
    grid-template-columns: 7rem 1fr auto auto;
    gap: 0.5rem;
    align-items: baseline;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--rule);
  }
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
    li, .binds li { grid-template-columns: 1fr auto; }
    .dom, .src { grid-column: 1; }
  }
</style>
