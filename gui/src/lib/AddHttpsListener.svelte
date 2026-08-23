<script lang="ts">
  import type { ListenerOptionFlags } from '@web/edit';
  import ListenerOptions from './ListenerOptions.svelte';

  let { pools, policies, certificates, editing, add }: {
    pools: string[];
    policies: string[];
    certificates: string[];
    editing: boolean;
    add: (
      key: string, bind: string, port: number, pool: string,
      policy: string, certificate: string, opts: ListenerOptionFlags,
    ) => void;
  } = $props();

  let key = $state('');
  let bind = $state('0.0.0.0');
  let port = $state('443');
  let pool = $state('');
  let policy = $state('');
  let certificate = $state('');
  // **HTTP 와 같은 컴포넌트를 쓴다.** 두 벌로 두면 한쪽만 고치는 날이 온다.
  let opts = $state<ListenerOptionFlags>({});

  const ready = $derived(pools.length > 0 && policies.length > 0 && certificates.length > 0);

  const submit = (): void => {
    add(key.trim(), bind.trim(), Number(port), pool, policy, certificate, opts);
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
  <select bind:value={policy} disabled={editing || policies.length === 0}>
    <option value="">정책</option>
    {#each policies as p (p)}
      <option value={p}>{p}</option>
    {/each}
  </select>
  <select bind:value={certificate} disabled={editing || certificates.length === 0}>
    <option value="">인증서</option>
    {#each certificates as c (c)}
      <option value={c}>{c}</option>
    {/each}
  </select>
  <button type="submit" disabled={editing || !ready}>HTTPS 포트를 연다</button>
  <ListenerOptions {editing} bind:value={opts} />
</form>

<style>
  .add {
    display: grid;
    grid-template-columns: 6rem 7rem 4.5rem 6rem 6rem 7rem auto;
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
