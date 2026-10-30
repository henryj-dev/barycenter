<script lang="ts">
  /** 항목 목록(정의 목록) — 상세의 「라벨 · 값」 줄. 값이 주소·이름이면 `mono`. */
  type Item = { label: string; value: string; mono?: boolean; tone?: 'ok' | 'warn' | 'danger' };
  let { items, labelWidth = '110px' }: { items: readonly Item[]; labelWidth?: string } = $props();
</script>

<dl style:grid-template-columns="{labelWidth} minmax(0, 1fr)">
  {#each items as it, i (i)}
    <dt>{it.label}</dt>
    <dd class:mono={it.mono} data-tone={it.tone}>{it.value}</dd>
  {/each}
</dl>

<style>
  dl { display: grid; gap: 8px 16px; margin: 0; font: var(--t-small); }
  dt { color: var(--tx3); }
  dd { margin: 0; overflow-wrap: anywhere; }
  .mono { font-family: var(--mono); }
  [data-tone='ok'] { color: var(--ok); }
  [data-tone='warn'] { color: var(--warn); }
  [data-tone='danger'] { color: var(--danger); }
  @media (max-width: 560px) { dl { grid-template-columns: minmax(0, 1fr) !important; gap: 2px; } dd { margin-bottom: 8px; } }
</style>
