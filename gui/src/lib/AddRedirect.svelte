<script lang="ts">
  import type { RedirectStatus } from '@web/edit';

  let { listeners, editing, add }: {
    listeners: string[];
    editing: boolean;
    add: (input: {
      key: string; listener: string; hosts: string[]; to: string;
      status: RedirectStatus; pathPrefix?: string;
    }) => void;
  } = $props();

  let key = $state('');
  let listener = $state('');
  let hostsText = $state('');
  let pathPrefix = $state('');
  let to = $state('');
  let status = $state<RedirectStatus>(302);

  const submit = (): void => {
    const hosts = hostsText.split(/[\s,]+/).map((h) => h.trim()).filter((h) => h !== '');
    const prefix = pathPrefix.trim();
    add({
      key: key.trim(),
      listener,
      hosts,
      to: to.trim(),
      status,
      ...(prefix === '' ? {} : { pathPrefix: prefix }),
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
  <input bind:value={to} placeholder="대상" autocomplete="off" disabled={editing} />
  <select bind:value={status} disabled={editing}>
    <option value={301}>301</option>
    <option value={302}>302</option>
    <option value={307}>307</option>
    <option value={308}>308</option>
  </select>
  <button type="submit" disabled={editing || listeners.length === 0}>redirect 를 넣는다</button>
</form>

<style>
  .add {
    display: grid;
    grid-template-columns: 5rem 6rem 1fr 5rem 1fr 4.5rem auto;
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
