<script lang="ts">
  /**
   * 리스너 옵션 — 제안 6·7·8 (2026-08-23).
   *
   * **HTTP 와 HTTPS 폼이 이 하나를 함께 쓴다.** 두 벌로 두면 한쪽만 고치는 날이 오고,
   * 그때 "HTTPS 에서는 레이트리밋이 안 걸린다" 가 된다.
   *
   * 기본은 **접혀 있다.** 리스너를 여는 사람 대부분은 이 셋을 안 건드리고, 늘 펼쳐 두면
   * 포트 하나 여는 화면이 열두 칸짜리가 된다.
   *
   * 값은 문자열 그대로 올린다 — 단위 해석(`50m` → 바이트, `120s` → ms)은
   * `parseListenerOptions` 한 자리다. 여기서 또 바꾸면 GUI 와 CLI 가 갈린다.
   */
  import type { ListenerOptionFlags } from '@web/edit';

  let { editing, value = $bindable() }: {
    editing: boolean;
    value: ListenerOptionFlags;
  } = $props();

  let open = $state(false);

  /** 헤더 행. 빈 행은 patch 를 만들 때 버려진다 — 여기서 지우게 강요하지 않는다. */
  let rows = $state<{ dir: 'req' | 'res'; name: string; value: string }[]>([]);

  const sync = (): void => {
    const specs = rows
      .filter((r) => r.name.trim() !== '')
      .map((r) => `${r.dir}:${r.name.trim()}:${r.value}`);
    value = { ...value, ...(specs.length === 0 ? { header: undefined } : { header: specs }) };
  };

  const addRow = (): void => {
    rows = [...rows, { dir: 'req', name: '', value: '' }];
  };

  const dropRow = (i: number): void => {
    rows = rows.filter((_, n) => n !== i);
    sync();
  };
</script>

<div class="opts">
  <button type="button" class="toggle" onclick={() => { open = !open; }} disabled={editing}>
    {open ? '▾' : '▸'} 옵션 — 타임아웃 · 본문 크기 · 헤더 · 레이트리밋
  </button>

  {#if open}
    <div class="grid">
      <label>연결 타임아웃
        <input bind:value={value.connectTimeout} placeholder="5s" disabled={editing} />
      </label>
      <label>읽기 타임아웃
        <input bind:value={value.readTimeout} placeholder="120s" disabled={editing} />
      </label>
      <label>쓰기 타임아웃
        <input bind:value={value.sendTimeout} placeholder="90s" disabled={editing} />
      </label>
      <label>본문 크기
        <input bind:value={value.maxBody} placeholder="50m (0 은 무제한)" disabled={editing} />
      </label>
      <label>초당 요청
        <input bind:value={value.rate} placeholder="10r/s" disabled={editing} />
      </label>
      <label>burst
        <input bind:value={value.burst} placeholder="20" disabled={editing} />
      </label>
      <label>동시 연결
        <input bind:value={value.maxConn} placeholder="100" disabled={editing} />
      </label>
      <label class="check">
        <input type="checkbox" bind:checked={value.nodelay} disabled={editing} />
        nodelay — burst 를 지연 없이 통과
      </label>
    </div>

    <div class="headers">
      <div class="hrow head"><span>헤더</span><span>이름</span><span>값</span><span></span></div>
      {#each rows as r, i (i)}
        <div class="hrow">
          <select bind:value={r.dir} onchange={sync} disabled={editing}>
            <option value="req">요청</option>
            <option value="res">응답</option>
          </select>
          <input bind:value={r.name} oninput={sync} placeholder="X-Tenant" disabled={editing} />
          <input bind:value={r.value} oninput={sync} placeholder="acme" disabled={editing} />
          <button type="button" onclick={() => dropRow(i)} disabled={editing}>×</button>
        </div>
      {/each}
      <button type="button" class="addrow" onclick={addRow} disabled={editing}>헤더를 더한다</button>
    </div>

    <p class="note">
      타임아웃은 단위를 적는다 (<code>120s</code> · <code>1500ms</code>).
      본문 크기는 <code>50m</code> · <code>512k</code> · 바이트.
      <strong>레이트리밋은 redirect·reject 라우트에는 안 걸린다</strong> — nginx 단계 순서다.
    </p>
  {/if}
</div>

<style>
  .opts { margin-top: 0.6rem; }
  .toggle {
    background: transparent;
    border: none;
    color: var(--mute);
    padding: 0.2rem 0;
    font: inherit;
    font-size: 0.75rem;
    cursor: pointer;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0.4rem;
    margin-top: 0.5rem;
  }
  label { display: grid; gap: 0.15rem; font-size: 0.7rem; color: var(--mute); }
  label.check { grid-column: span 2; display: flex; align-items: center; gap: 0.35rem; }
  .headers { margin-top: 0.6rem; display: grid; gap: 0.3rem; }
  .hrow { display: grid; grid-template-columns: 5rem 1fr 1fr 2rem; gap: 0.3rem; }
  .hrow.head { font-size: 0.68rem; color: var(--mute); }
  input, select {
    background: var(--plate);
    border: 1px solid var(--rule);
    color: var(--ink);
    padding: 0.25rem 0.4rem;
    font: inherit;
    font-size: 0.78rem;
    min-width: 0;
  }
  input[type='checkbox'] { min-width: auto; }
  .addrow, .hrow button {
    background: transparent;
    border: 1px solid var(--rule);
    color: var(--mute);
    padding: 0.2rem 0.4rem;
    font-size: 0.72rem;
    cursor: pointer;
  }
  .note { font-size: 0.68rem; color: var(--mute); margin: 0.5rem 0 0; line-height: 1.5; }
  code { font-size: 0.95em; }
  button:disabled, input:disabled, select:disabled { opacity: 0.5; cursor: not-allowed; }
  @media (max-width: 640px) {
    .grid { grid-template-columns: 1fr 1fr; }
    label.check { grid-column: span 2; }
  }
</style>
