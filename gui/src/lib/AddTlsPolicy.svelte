<script lang="ts">
  import type { TlsVersion } from '@web/edit';

  let { editing, add }: {
    editing: boolean;
    add: (key: string, minVersion: TlsVersion) => void;
  } = $props();

  let key = $state('');
  let minVersion = $state<TlsVersion>('1.2');

  const submit = (): void => {
    add(key.trim(), minVersion);
  };
</script>

<form class="add" onsubmit={(e) => { e.preventDefault(); submit(); }}>
  <input bind:value={key} placeholder="정책 키" autocomplete="off" disabled={editing} />
  <select bind:value={minVersion} disabled={editing}>
    <option value="1.2">TLS 1.2</option>
    <option value="1.3">TLS 1.3</option>
  </select>
  <button type="submit" disabled={editing}>TLS 정책을 연다</button>
</form>

<style>
  .add {
    display: grid;
    grid-template-columns: 8rem 7rem auto;
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
