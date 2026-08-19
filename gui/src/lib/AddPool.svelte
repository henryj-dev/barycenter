<script lang="ts">
  import type { ProtocolClass } from '@web/edit';

  let { editing, add }: {
    editing: boolean;
    add: (input: {
      pool: string; protocolClass: ProtocolClass; backend: string; host: string; port: number;
    }) => void;
  } = $props();

  let pool = $state('');
  let protocolClass = $state<ProtocolClass>('http');
  let backend = $state('');
  let host = $state('');
  let port = $state('80');

  const submit = (): void => {
    add({
      pool: pool.trim(),
      protocolClass,
      backend: backend.trim(),
      host: host.trim(),
      port: Number(port),
    });
  };
</script>

<form class="add" onsubmit={(e) => { e.preventDefault(); submit(); }}>
  <input bind:value={pool} placeholder="풀 키" autocomplete="off" disabled={editing} />
  <select bind:value={protocolClass} disabled={editing}>
    <option value="http">http</option>
    <option value="tcp">tcp</option>
    <option value="udp">udp</option>
  </select>
  <input bind:value={backend} placeholder="첫 백엔드 키" autocomplete="off" disabled={editing} />
  <input bind:value={host} placeholder="호스트" autocomplete="off" disabled={editing} />
  <input bind:value={port} inputmode="numeric" placeholder="포트" disabled={editing} />
  <button type="submit" disabled={editing}>풀을 연다</button>
</form>

<style>
  .add {
    display: grid;
    grid-template-columns: 7rem 5rem 8rem 1fr 4.5rem auto;
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
