<script lang="ts">
  let { listeners, certificates, editing, add }: {
    listeners: string[];
    certificates: string[];
    editing: boolean;
    add: (input: { key: string; listener: string; hosts: string[]; certificate: string }) => void;
  } = $props();

  let key = $state('');
  let listener = $state('');
  let hostsText = $state('');
  let certificate = $state('');

  const ready = $derived(listeners.length > 0 && certificates.length > 0);

  const submit = (): void => {
    const hosts = hostsText.split(/[\s,]+/).map((h) => h.trim()).filter((h) => h !== '');
    add({ key: key.trim(), listener, hosts, certificate });
  };
</script>

<form class="add" onsubmit={(e) => { e.preventDefault(); submit(); }}>
  <input bind:value={key} placeholder="키" autocomplete="off" disabled={editing} />
  <select bind:value={listener} disabled={editing || listeners.length === 0}>
    <option value="">HTTPS 리스너</option>
    {#each listeners as l (l)}
      <option value={l}>{l}</option>
    {/each}
  </select>
  <input bind:value={hostsText} placeholder="호스트" autocomplete="off" disabled={editing} />
  <select bind:value={certificate} disabled={editing || certificates.length === 0}>
    <option value="">인증서</option>
    {#each certificates as c (c)}
      <option value={c}>{c}</option>
    {/each}
  </select>
  <button type="submit" disabled={editing || !ready}>SNI 를 묶는다</button>
</form>

<style>
  .add {
    display: grid;
    grid-template-columns: 6rem 8rem 1fr 7rem auto;
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
