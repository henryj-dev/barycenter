<script lang="ts">
  let { listeners, pools, editing, add }: {
    listeners: string[];
    pools: string[];
    editing: boolean;
    add: (input: {
      key: string; listener: string; hosts: string[]; pool: string;
      pathPrefix?: string; websocket?: boolean;
      rewritePrefix?: string; requestHeaders?: string;
    }) => void;
  } = $props();

  let key = $state('');
  let listener = $state('');
  let hostsText = $state('');
  let pathPrefix = $state('');
  let pool = $state('');
  let websocket = $state(false);
  // #109 — 프록시 옵션. 기본은 접혀 있다.
  let more = $state(false);
  let rewritePrefix = $state('');
  let headersText = $state('');

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
      ...(rewritePrefix.trim() === '' ? {} : { rewritePrefix: rewritePrefix.trim() }),
      ...(headersText.trim() === '' ? {} : { requestHeaders: headersText }),
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
  <div class="more">
    <button type="button" class="toggle" onclick={() => { more = !more; }} disabled={editing}>
      {more ? '▾' : '▸'} 프록시 옵션 — 경로 바꾸기 · 이 라우트의 요청 헤더
    </button>
    {#if more}
      <label>경로 바꾸기
        <input bind:value={rewritePrefix} placeholder="/v1/" autocomplete="off" disabled={editing} />
      </label>
      <label>요청 헤더 (한 줄에 하나, 이름: 값)
        <textarea bind:value={headersText} rows="3" placeholder="Host: api.example.com" spellcheck="false" disabled={editing}></textarea>
      </label>
      <p class="note">
        경로 바꾸기는 맞은 경로 접두사를 이 값으로 바꿔 보낸다. 예: 접두사 <code>/api/</code> + <code>/v1/</code> →
        <code>/api/users</code> 를 <code>/v1/users</code> 로 보낸다. 끝의 <code>/</code> 는 접두사와 같아야 한다.
        요청 헤더는 이 라우트에만 건다. 같은 이름이면 리스너의 헤더를 대신한다.
      </p>
    {/if}
  </div>
</form>

<style>
  .more { grid-column: 1 / -1; display: grid; gap: 0.4rem; }
  .more .toggle { background: transparent; border: none; color: var(--mute); padding: 0.2rem 0; font: inherit; font-size: 0.75rem; cursor: pointer; text-align: left; }
  .more label { display: grid; gap: 0.15rem; font-size: 0.7rem; color: var(--mute); }
  .more textarea { background: var(--plate); border: 1px solid var(--rule); color: var(--ink); padding: 0.3rem 0.45rem; font-family: var(--data, ui-monospace, monospace); font-size: 0.78rem; }
  .more .note { font-size: 0.7rem; color: var(--mute); margin: 0; line-height: 1.5; }
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
