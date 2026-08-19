<script lang="ts">
  let { listeners, editing, add }: {
    listeners: string[];
    editing: boolean;
    add: (input: { key: string; listener: string; snis: string[] }) => void;
  } = $props();

  let key = $state('');
  let listener = $state('');
  let snisText = $state('');

  const submit = (): void => {
    const snis = snisText.split(/[\s,]+/).map((s) => s.trim()).filter((s) => s !== '');
    add({ key: key.trim(), listener, snis });
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
  <button type="submit" disabled={editing || listeners.length === 0}>SNI 를 끊는다</button>
</form>

<style>
  .add {
    display: grid;
    grid-template-columns: 6rem 7rem 1fr auto;
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
