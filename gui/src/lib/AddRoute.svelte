<script lang="ts">
  let { listeners, pools, editing, add }: {
    listeners: string[];
    pools: string[];
    editing: boolean;
    add: (input: {
      key: string; listener: string; hosts: string[]; pool: string;
      pathPrefix?: string; websocket?: boolean;
    }) => void;
  } = $props();

  let key = $state('');
  let listener = $state('');
  let hostsText = $state('');
  let pathPrefix = $state('');
  let pool = $state('');
  let websocket = $state(false);

  const ready = $derived(listeners.length > 0 && pools.length > 0);

  const submit = (): void => {
    const hosts = hostsText.split(/[\s,]+/).map((h) => h.trim()).filter((h) => h !== '');
    const prefix = pathPrefix.trim();
    add({
      key: key.trim(),
      listener,
      hosts,
      pool,
      ...(prefix === '' ? {} : { pathPrefix: prefix }),
      ...(websocket ? { websocket: true } : {}),
    });
  };
</script>

<form class="add" onsubmit={(e) => { e.preventDefault(); submit(); }}>
  <input bind:value={key} placeholder="키" autocomplete="off" disabled={editing} />
  <select bind:value={listener} disabled={editing || listeners.length === 0}>
    <option value="">리스너</option>
    {#each listeners as l (l)}
      <option value={l}>{l}</option>
    {/each}
  </select>
  <input bind:value={hostsText} placeholder="호스트" autocomplete="off" disabled={editing} />
  <input bind:value={pathPrefix} placeholder="경로 (선택)" autocomplete="off" disabled={editing} />
  <select bind:value={pool} disabled={editing || pools.length === 0}>
    <option value="">풀</option>
    {#each pools as p (p)}
      <option value={p}>{p}</option>
    {/each}
  </select>
  <label class="ws">
    <input type="checkbox" bind:checked={websocket} disabled={editing} />
    websocket
  </label>
  <button type="submit" disabled={editing || !ready}>호스트 라우트를 넣는다</button>
</form>

<style>
  .add {
    display: grid;
    grid-template-columns: 6rem 7rem 1fr 6rem 7rem auto auto;
    gap: 0.4rem;
    margin-top: 0.8rem;
    padding-top: 0.8rem;
    border-top: 1px solid var(--rule);
    align-items: center;
  }
  .ws {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.75rem;
    color: var(--mute);
    white-space: nowrap;
  }
  .ws input { margin: 0; }
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
  button:disabled, input:disabled, select:disabled, .ws:has(input:disabled) { opacity: 0.5; cursor: not-allowed; }
  @media (max-width: 640px) {
    .add { grid-template-columns: 1fr 1fr; }
  }
</style>
