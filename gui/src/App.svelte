<script lang="ts">
  import { createDesk } from './lib/desk.svelte.ts';

  const desk = createDesk();

  const connect = (): void => {
    void desk.connect();
  };

  const apply = (): void => {
    void desk.apply();
  };
</script>

<div class="page">
  <header class="mast">
    <p class="eyebrow">barycenter</p>
    <h1>이 적용이 하는 일</h1>
    <p class="lede">저장과 적용은 다르다. 여기 있는 것은 이미 커밋된 plan 이 트래픽에 닿을 때 생기는 영향이다.</p>
  </header>

  <form class="dock" onsubmit={(e) => { e.preventDefault(); connect(); }}>
    <label>
      <span>토큰</span>
      <input
        type="password"
        autocomplete="off"
        bind:value={desk.token}
        placeholder="Bearer 토큰"
      />
    </label>
    <button type="submit">{desk.live ? '다시 연결' : '연결'}</button>
    <p class="pulse" data-live={desk.live}>{desk.live ? '수신 중' : '끊김'}</p>
  </form>

  {#if desk.error}
    <p class="err" role="alert">{desk.error}</p>
  {/if}

  <p class="head">
    {#if desk.head !== undefined}
      head <span class="mono">r{desk.head}</span>
    {:else}
      아직 상태를 받지 않았다
    {/if}
  </p>

  {#if desk.view}
    {@const v = desk.view}
    <article class="impact" data-reload={v.requiresReload}>
      <p class="rev">plan <span class="mono">{v.planId}</span> → r{v.revision}</p>
      <p class="headline">{v.headline}</p>
      <div class="beam" aria-hidden="true">
        {#each v.socketsRemoved as sock (sock)}
          <span class="mass leave">{sock}</span>
        {/each}
        <span class="fulcrum"></span>
        {#each v.socketsAdded as sock (sock)}
          <span class="mass join">{sock}</span>
        {/each}
        {#if v.socketsAdded.length === 0 && v.socketsRemoved.length === 0}
          <span class="mass quiet">소켓 변화 없음</span>
        {/if}
      </div>
      <dl>
        <div>
          <dt>평면</dt>
          <dd class="mono">{v.planes.join(', ') || '—'}</dd>
        </div>
        <div>
          <dt>리스너</dt>
          <dd class="mono">{v.listeners.join(' · ') || '—'}</dd>
        </div>
      </dl>
      <button type="button" class="go" disabled={desk.applying} onclick={apply}>
        {desk.applying ? '적용하는 중' : '트래픽에 건다'}
      </button>
    </article>
  {:else if desk.live}
    <p class="empty">커밋됐지만 적용되지 않은 plan 이 없다. <code>bary import</code> 또는 <code>changeset commit</code> 뒤에 여기로 온다.</p>
  {/if}
</div>

<style>
  .page {
    max-width: 40rem;
    margin: 0 auto;
    padding: 2.5rem 1.25rem 4rem;
  }
  .eyebrow {
    font-family: var(--data);
    font-size: 0.75rem;
    letter-spacing: 0.16em;
    text-transform: lowercase;
    color: var(--mute);
    margin: 0 0 0.4rem;
  }
  h1 {
    font-family: var(--display);
    font-weight: 560;
    font-size: 2.1rem;
    line-height: 1.15;
    margin: 0 0 0.6rem;
  }
  .lede { color: var(--mute); margin: 0 0 2rem; }
  .dock {
    display: grid;
    grid-template-columns: 1fr auto auto;
    gap: 0.6rem;
    align-items: end;
    margin-bottom: 1.25rem;
  }
  label { display: flex; flex-direction: column; gap: 0.25rem; }
  label span { font-size: 0.8rem; color: var(--mute); }
  input {
    background: var(--plate);
    border: 1px solid var(--rule);
    color: var(--ink);
    padding: 0.45rem 0.6rem;
  }
  button {
    background: var(--plate);
    border: 1px solid var(--rule);
    color: var(--ink);
    padding: 0.5rem 0.85rem;
    cursor: pointer;
  }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .pulse { margin: 0; font-size: 0.8rem; color: var(--mute); padding-bottom: 0.35rem; }
  .pulse[data-live='true'] { color: var(--moss); }
  .err { color: var(--ember); }
  .head { font-family: var(--data); font-size: 0.9rem; color: var(--mute); }
  .mono { font-family: var(--data); }
  .impact {
    margin-top: 1.5rem;
    padding: 1.25rem 0;
    border-top: 1px solid var(--rule);
  }
  .rev { font-family: var(--data); font-size: 0.8rem; color: var(--mute); }
  .headline {
    font-family: var(--display);
    font-size: 1.35rem;
    margin: 0.4rem 0 1.1rem;
  }
  .impact[data-reload='true'] .headline { color: var(--ember); }
  .beam {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    align-items: center;
    min-height: 2.4rem;
    padding: 0.6rem 0;
    border-top: 1px solid var(--rule);
    border-bottom: 1px solid var(--rule);
    margin-bottom: 1rem;
  }
  .fulcrum {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--ink);
    margin: 0 0.4rem;
  }
  .mass {
    font-family: var(--data);
    font-size: 0.75rem;
    padding: 0.2rem 0.4rem;
    border: 1px solid var(--rule);
  }
  .mass.join { border-color: var(--moss); color: var(--moss); }
  .mass.leave { border-color: var(--ember); color: var(--ember); text-decoration: line-through; }
  .mass.quiet { color: var(--mute); }
  dl { margin: 0 0 1.25rem; }
  dl > div { margin: 0.35rem 0; }
  dt { font-size: 0.75rem; color: var(--mute); }
  dd { margin: 0.1rem 0 0; }
  .go {
    background: var(--ember);
    border-color: var(--ember);
    color: var(--void);
    font-weight: 600;
  }
  .empty { color: var(--mute); }
  .empty code { font-family: var(--data); font-size: 0.85em; }
  @media (max-width: 640px) {
    .dock { grid-template-columns: 1fr; }
  }
</style>
