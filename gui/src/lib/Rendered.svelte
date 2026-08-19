<script lang="ts">
  import type { RenderedView } from '@web/rendered-view';

  let { view, live }: { view: RenderedView; live: boolean } = $props();
</script>

{#if !live}
  <p class="empty">연결하면 head 산출물이 여기 온다.</p>
{:else if view.conf === ''}
  <p class="empty">산출물이 없다. 모델이 비면 conf 도 비다.</p>
{:else}
  <p class="meta mono">
    {#if view.revision !== undefined}r{view.revision}{/if}
    {#if view.digest !== undefined}<span>{view.digest}</span>{/if}
    {#if view.planes.length > 0}<span>{view.planes.join(' · ')}</span>{/if}
  </p>
  <pre class="conf"><code>{view.conf}</code></pre>
{/if}

<style>
  .empty { color: var(--mute); }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    font-size: 0.8rem;
    color: var(--mute);
    margin: 1.5rem 0 0.6rem;
    padding-top: 0.9rem;
    border-top: 1px solid var(--rule);
  }
  .mono { font-family: var(--data); }
  .conf {
    margin: 0;
    padding: 0.8rem 0 2rem;
    overflow-x: auto;
    font-family: var(--data);
    font-size: 0.78rem;
    line-height: 1.45;
    white-space: pre;
  }
  code { font: inherit; }
</style>
