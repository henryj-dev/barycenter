<script lang="ts" module>
  export type TabItem = { key: string; label: string; href?: string; count?: number };
</script>

<script lang="ts">
  /**
   * 탭 — 디자인 시스템 §5. 고른 탭은 강조 색 밑줄과 굵은 글. `href` 를 주면 링크다(탭이 주소다).
   * 링크가 아니면 `onselect` 로 바꾼다.
   */
  let { items, current, label, onselect }: {
    items: readonly TabItem[]; current: string; label: string; onselect?: (key: string) => void;
  } = $props();
</script>

<div class="tabs" role="tablist" aria-label={label}>
  {#each items as t (t.key)}
    {#if t.href !== undefined}
      <a role="tab" href={t.href} aria-selected={t.key === current} aria-current={t.key === current ? 'page' : undefined}>
        {t.label}{#if t.count !== undefined}<span class="c">{t.count}</span>{/if}
      </a>
    {:else}
      <button type="button" role="tab" aria-selected={t.key === current} onclick={() => onselect?.(t.key)}>
        {t.label}{#if t.count !== undefined}<span class="c">{t.count}</span>{/if}
      </button>
    {/if}
  {/each}
</div>

<style>
  .tabs { display: flex; gap: 4px; overflow-x: auto; }
  a, button {
    padding: 8px 14px; border: 0; border-bottom: 2px solid transparent; background: transparent;
    font: 400 13px/18px var(--font); color: var(--tx2); text-decoration: none; white-space: nowrap;
  }
  a:hover, button:hover { color: var(--tx); text-decoration: none; }
  [aria-selected='true'] { border-bottom-color: var(--accent); color: var(--tx); font-weight: 600; }
  .c { margin-left: 6px; font-size: 11px; background: var(--neutral-bg); padding: 1px 6px; border-radius: 8px; }
</style>
