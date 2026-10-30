<script lang="ts">
  /** 토스트 자리 — 앱 셸에 하나 둔다. 내용은 `toast` 가 정한다. */
  import { toast } from './toast.svelte.ts';
  import Spinner from './Spinner.svelte';
  const icon = { ok: '✓', danger: '✕', info: 'ℹ', warn: '▲' } as const;
</script>

<div class="toaster" aria-live="polite">
  {#each toast.items as t (t.id)}
    <div class="toast" data-tone={t.tone} role="status">
      {#if t.busy}<span class="sp"><Spinner size={14} /></span>{:else}<span class="ic" aria-hidden="true">{icon[t.tone]}</span>{/if}
      <div class="tx"><b>{t.title}</b>{#if t.body}<div class="body">{t.body}</div>{/if}</div>
      <button type="button" aria-label="닫기" onclick={() => toast.close(t.id)}>✕</button>
    </div>
  {/each}
</div>

<style>
  .toaster {
    position: fixed; right: 16px; bottom: 16px; z-index: var(--z-toast);
    display: flex; flex-direction: column; gap: 8px; width: 340px; max-width: calc(100vw - 32px);
  }
  .toast {
    --c: var(--info);
    display: flex; gap: 10px; padding: 12px 14px; background: var(--bg-panel); border: 1px solid var(--c);
    border-radius: var(--r-md); box-shadow: var(--sh-pop); font: var(--t-small); animation: bc-in var(--dur) var(--ease);
  }
  .toast[data-tone='ok'] { --c: var(--ok); }
  .toast[data-tone='danger'] { --c: var(--danger); }
  .toast[data-tone='warn'] { --c: var(--warn); }
  .ic { color: var(--c); font-weight: 700; }
  .sp { color: var(--c); margin-top: 2px; }
  .tx { flex: 1; min-width: 0; }
  .body { color: var(--tx2); }
  button { border: 0; background: transparent; color: var(--tx3); align-self: flex-start; padding: 0 2px; }
</style>
