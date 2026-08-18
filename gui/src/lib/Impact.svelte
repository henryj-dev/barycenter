<script lang="ts">
  import type { ImpactView } from '@web/impact-view';

  let { view, applying, apply }: {
    view: ImpactView;
    applying: boolean;
    apply: () => void;
  } = $props();
</script>

<article class="impact" data-reload={view.requiresReload}>
  <p class="rev">plan <span class="mono">{view.planId}</span> → r{view.revision}</p>
  <p class="headline">{view.headline}</p>
  <div class="beam" aria-hidden="true">
    {#each view.socketsRemoved as sock (sock)}
      <span class="mass leave">{sock}</span>
    {/each}
    <span class="fulcrum"></span>
    {#each view.socketsAdded as sock (sock)}
      <span class="mass join">{sock}</span>
    {/each}
    {#if view.socketsAdded.length === 0 && view.socketsRemoved.length === 0}
      <span class="mass quiet">소켓 변화 없음</span>
    {/if}
  </div>
  <dl>
    <div>
      <dt>평면</dt>
      <dd class="mono">{view.planes.join(', ') || '—'}</dd>
    </div>
    <div>
      <dt>리스너</dt>
      <dd class="mono">{view.listeners.join(' · ') || '—'}</dd>
    </div>
  </dl>
  <button type="button" class="go" disabled={applying} onclick={apply}>
    {applying ? '적용하는 중' : '트래픽에 건다'}
  </button>
</article>

<style>
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
    padding: 0.5rem 0.85rem;
    cursor: pointer;
    border: 1px solid var(--ember);
  }
  .go:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
