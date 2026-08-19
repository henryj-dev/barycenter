<script lang="ts">
  import type { StatusView } from '@web/status-view';

  let { view, live, recovering, recover }: {
    view: StatusView;
    live: boolean;
    recovering: boolean;
    recover: () => void;
  } = $props();
</script>

{#if !live}
  <p class="empty">연결하면 4-way 가 여기 온다.</p>
{:else}
  <dl class="four">
    <div>
      <dt>head</dt>
      <dd class="mono">{view.head === undefined ? '—' : `r${view.head}`}</dd>
    </div>
    <div data-on={view.leader.isLeader}>
      <dt>리더</dt>
      <dd>
        {view.leader.isLeader ? '이 인스턴스' : '아니다'}
        <span class="sub mono">{view.leader.holder}</span>
        {#if view.leader.reason}
          <span class="sub">{view.leader.reason}</span>
        {/if}
      </dd>
    </div>
    <div data-kind={view.published.kind}>
      <dt>게시</dt>
      <dd class="mono">{view.published.kind}{view.published.generation ? ` · ${view.published.generation}` : ''}</dd>
    </div>
    <div data-on={view.unfinished}>
      <dt>미완 전환</dt>
      <dd>
        {view.unfinished ? '있다 — recover 의 대상' : '없다'}
        {#if view.unfinished}
          <button type="button" disabled={recovering} onclick={recover}>
            {recovering ? '이어받는 중' : '이어받는다'}
          </button>
        {/if}
      </dd>
    </div>
    <div>
      <dt>엔진</dt>
      <dd class="mono">{view.engine.label}</dd>
    </div>
    <div>
      <dt>드라이버</dt>
      <dd class="mono">{view.driver.loaded ? (view.driver.name ?? '로드됨') : '안 실었다'}</dd>
    </div>
  </dl>
  {#if view.pending.length > 0}
    <p class="pend">커밋됐지만 적용되지 않은 plan {view.pending.length} 개</p>
    <ul>
      {#each view.pending as p (p.planId)}
        <li class="mono">{p.planId} → r{p.revision}</li>
      {/each}
    </ul>
  {:else}
    <p class="empty">대기 중인 plan 이 없다.</p>
  {/if}
{/if}

<style>
  .empty { color: var(--mute); }
  .four {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.9rem 1.25rem;
    margin: 1.5rem 0 1.25rem;
    padding-top: 1rem;
    border-top: 1px solid var(--rule);
  }
  dt { font-size: 0.75rem; color: var(--mute); }
  dd { margin: 0.15rem 0 0; }
  .sub { display: block; color: var(--mute); font-size: 0.8rem; }
  .mono { font-family: var(--data); }
  div[data-on='false'] dd,
  div[data-kind='none'] dd { color: var(--mute); }
  div[data-on='true'] dd { color: var(--moss); }
  button {
    display: block;
    margin-top: 0.35rem;
    background: transparent;
    border: 1px solid var(--rule);
    color: var(--ink);
    padding: 0.2rem 0.45rem;
    font-size: 0.75rem;
    cursor: pointer;
  }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .pend { font-size: 0.85rem; color: var(--ember); }
  ul { list-style: none; margin: 0.4rem 0 0; padding: 0; }
  li { padding: 0.25rem 0; color: var(--mute); }
  @media (max-width: 640px) {
    .four { grid-template-columns: 1fr; }
  }
</style>
