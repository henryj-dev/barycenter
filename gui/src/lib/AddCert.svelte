<script lang="ts">
  let { editing, add }: {
    editing: boolean;
    add: (key: string, fullchain: string, privkey: string) => void;
  } = $props();

  let key = $state('');
  let fullchain = $state('');
  let privkey = $state('');

  const submit = (): void => {
    add(key.trim(), fullchain.trim(), privkey.trim());
  };
</script>

<form class="add" onsubmit={(e) => { e.preventDefault(); submit(); }}>
  <input bind:value={key} placeholder="키" autocomplete="off" disabled={editing} />
  <textarea bind:value={fullchain} placeholder="fullchain PEM" spellcheck="false" disabled={editing}></textarea>
  <textarea bind:value={privkey} placeholder="privkey PEM" spellcheck="false" disabled={editing}></textarea>
  <button type="submit" disabled={editing}>자료를 넣는다</button>
</form>

<style>
  .add {
    display: grid;
    grid-template-columns: 8rem 1fr 1fr auto;
    gap: 0.4rem;
    margin-top: 0.8rem;
    padding-top: 0.8rem;
    border-top: 1px solid var(--rule);
    align-items: start;
  }
  input, textarea {
    background: var(--plate);
    border: 1px solid var(--rule);
    color: var(--ink);
    padding: 0.3rem 0.45rem;
    font: inherit;
    font-size: 0.8rem;
  }
  textarea {
    font-family: var(--data);
    min-height: 6rem;
    resize: vertical;
  }
  button {
    background: transparent;
    border: 1px solid var(--rule);
    color: var(--mute);
    padding: 0.3rem 0.5rem;
    font-size: 0.75rem;
    cursor: pointer;
  }
  button:disabled, input:disabled, textarea:disabled { opacity: 0.5; cursor: not-allowed; }
  @media (max-width: 640px) {
    .add { grid-template-columns: 1fr; }
  }
</style>
