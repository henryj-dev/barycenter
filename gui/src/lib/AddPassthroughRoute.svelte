<script lang="ts">
  let { listeners, pools, editing, add }: {
    listeners: string[];
    pools: string[];
    editing: boolean;
    add: (input: { key: string; listener: string; snis: string[]; pool: string }) => void;
  } = $props();

  let key = $state('');
  let listener = $state('');
  let snisText = $state('');
  let pool = $state('');

  const ready = $derived(listeners.length > 0 && pools.length > 0);

  const submit = (): void => {
    const snis = snisText.split(/[\s,]+/).map((s) => s.trim()).filter((s) => s !== '');
    add({ key: key.trim(), listener, snis, pool });
  };
</script>

<form class="add" onsubmit={(e) => { e.preventDefault(); submit(); }}>
  <input bind:value={key} placeholder="키" autocomplete="off" disabled={editing} />
  <select bind:value={listener} disabled={editing || listeners.length === 0}>
    <option value="">패스스루</option>
    {#each listeners as l (l)}
      <option value={l}>{l}</option>
    {/each}
  </select>
  <input bind:value={snisText} placeholder="SNI" autocomplete="off" disabled={editing} />
  <select bind:value={pool} disabled={editing || pools.length === 0}>
    <option value="">TCP 풀</option>
    {#each pools as p (p)}
      <option value={p}>{p}</option>
    {/each}
  </select>
  <button type="submit" disabled={editing || !ready}>SNI 라우트를 넣는다</button>
</form>

<style>
  .add {
    display: grid;
    grid-template-columns: 6rem 7rem 1fr 7rem auto;
    gap: 0.4rem;
    margin-top: 0.8rem;
    padding-top: 0.8rem;
    border-top: 1px solid var(--rule);
  }
  input, select {
    background: var(--plate);
    border: 1px solid var(--rule);
    color: var(--ink);
    padding: 0.3rem 0.45rem;
    font: inherit;
    font-size: 0.8rem;
  }
  button {
    background: transparent;
    border: 1px solid var(--rule);
    color: var(--mute);
    padding: 0.3rem 0.5rem;
    font-size: 0.75rem;
    cursor: pointer;
  }
  button:disabled, input:disabled, select:disabled { opacity: 0.5; cursor: not-allowed; }
  @media (max-width: 640px) {
    .add { grid-template-columns: 1fr 1fr; }
  }
</style>
