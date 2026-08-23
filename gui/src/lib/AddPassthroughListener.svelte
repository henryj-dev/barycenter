<script lang="ts">
  let { pools, editing, add }: {
    pools: string[];
    editing: boolean;
    add: (key: string, bind: string, port: number, pool?: string, noSniPool?: string) => void;
  } = $props();

  let key = $state('');
  let bind = $state('0.0.0.0');
  let port = $state('443');
  let pool = $state('');
  /**
   * TLS 는 맞는데 SNI 가 없을 때의 폴백 (S9 로 열렸다).
   *
   * **파싱 실패(비-TLS·malformed)에는 이 자리가 없다** — 스파이크가 그 통이 no-SNI 와
   * 갈린다는 것을 실측했고, 갈리기 때문에 이것만 열 수 있었다. 화면에 칸을 만들면
   * 사용자가 "쓰레기 바이트도 여기로 가나" 를 묻게 되므로 아래 설명에 적어 둔다.
   */
  let noSniPool = $state('');

  const submit = (): void => {
    const dest = pool.trim();
    const noSni = noSniPool.trim();
    add(
      key.trim(), bind.trim(), Number(port),
      dest === '' ? undefined : dest,
      noSni === '' ? undefined : noSni,
    );
  };
</script>

<form class="add" onsubmit={(e) => { e.preventDefault(); submit(); }}>
  <input bind:value={key} placeholder="키" autocomplete="off" disabled={editing} />
  <input bind:value={bind} placeholder="바인드" autocomplete="off" disabled={editing} />
  <input bind:value={port} inputmode="numeric" placeholder="포트" disabled={editing} />
  <select bind:value={pool} disabled={editing}>
    <option value="">unmatched 끊음</option>
    {#each pools as p (p)}
      <option value={p}>{p}</option>
    {/each}
  </select>
  <select bind:value={noSniPool} disabled={editing}>
    <option value="">SNI 없음 끊음</option>
    {#each pools as p (p)}
      <option value={p}>{p}</option>
    {/each}
  </select>
  <button type="submit" disabled={editing}>패스스루 포트를 연다</button>
  <p class="note">
    두 폴백은 다른 것이다 — 왼쪽은 <b>유효한 SNI 인데 매칭이 없을 때</b>, 오른쪽은
    <b>TLS 는 맞는데 SNI 가 없을 때</b>다. TLS 로 읽히지 않는 바이트(비-TLS·깨진
    ClientHello)는 <b>어느 쪽으로도 안 간다</b> — 언제나 끊는다.
  </p>
</form>

<style>
  .add {
    display: grid;
    grid-template-columns: 7rem 8rem 4.5rem 9rem 9rem auto;
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
  .note {
    grid-column: 1 / -1;
    margin: 0.35rem 0 0;
    font-size: 0.7rem;
    line-height: 1.5;
    color: var(--mute);
  }
  @media (max-width: 640px) {
    .add { grid-template-columns: 1fr 1fr; }
  }
</style>
