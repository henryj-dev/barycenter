<script lang="ts">
  let { pools, editing, add }: {
    pools: string[];
    editing: boolean;
    add: (key: string, bind: string, port: number, pool: string) => void;
  } = $props();

  let key = $state('');
  let bind = $state('0.0.0.0');
  let port = $state('80');
  let pool = $state('');

  const submit = (): void => {
    add(key.trim(), bind.trim(), Number(port), pool);
  };
</script>

<form class="add" onsubmit={(e) => { e.preventDefault(); submit(); }}>
  <input bind:value={key} placeholder="키" autocomplete="off" disabled={editing} />
  <input bind:value={bind} placeholder="바인드" autocomplete="off" disabled={editing} />
  <input bind:value={port} inputmode="numeric" placeholder="포트" disabled={editing} />
  <select bind:value={pool} disabled={editing || pools.length === 0}>
    <option value="">풀</option>
    {#each pools as p (p)}
      <option value={p}>{p}</option>
    {/each}
  </select>
  <button type="submit" disabled={editing || pools.length === 0}>HTTP 포트를 연다</button>
</form>

<style>
  .add {
    display: grid;
    grid-template-columns: 7rem 8rem 4.5rem 7rem auto;
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
