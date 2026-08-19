<script lang="ts">
  let { pool, editing, add }: {
    pool: string;
    editing: boolean;
    add: (key: string, host: string, port: number) => void;
  } = $props();

  let key = $state('');
  let host = $state('');
  let port = $state('80');

  const submit = (): void => {
    const n = Number(port);
    add(key.trim(), host.trim(), n);
  };
</script>

<form class="add" onsubmit={(e) => { e.preventDefault(); submit(); }}>
  <input bind:value={key} placeholder="키" autocomplete="off" disabled={editing} />
  <input bind:value={host} placeholder="호스트" autocomplete="off" disabled={editing} />
  <input bind:value={port} inputmode="numeric" placeholder="포트" disabled={editing} />
  <button type="submit" disabled={editing}>설정에 넣는다</button>
</form>

<style>
  .add {
    display: grid;
    grid-template-columns: 7rem 1fr 4.5rem auto;
    gap: 0.4rem;
    margin-top: 0.6rem;
    padding-top: 0.6rem;
    border-top: 1px solid var(--rule);
  }
  input {
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
  button:disabled, input:disabled { opacity: 0.5; cursor: not-allowed; }
  @media (max-width: 640px) {
    .add { grid-template-columns: 1fr 1fr; }
  }
</style>
