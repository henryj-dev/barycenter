<script lang="ts">
  /**
   * 풀어 쓴 결과 상자 — 콘솔 시안 `fieldsFor` 의 `resolved` 칸(`f.dRes`): 「상태 · 준비 중」 · 「안내 · …」.
   * 값은 시안 인라인 style 그대로다(세로 4px · 안쪽 8px 10px · --bg-page · 테두리 --bd · 줄마다 84px | 나머지, 12px).
   * 도움말과 링크(`f.help` · `f.linkL`)는 상자 아래 — 링크는 강조 색 12px 500.
   */
  let { items, help, link }: {
    items: readonly (readonly [string, string])[];
    help?: string;
    link?: { label: string; href: string };
  } = $props();
</script>

<div class="res">
  {#each items as [k, v] (k)}<div class="ri"><span class="k">{k}</span><span class="v">{v}</span></div>{/each}
</div>
{#if help}<div class="help">{help}</div>{/if}
{#if link}<a class="lnk" href={link.href}>{link.label}</a>{/if}

<style>
  .res { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; background: var(--bg-page); border: 1px solid var(--bd); border-radius: var(--r-md); }
  .ri { display: grid; grid-template-columns: 84px minmax(0, 1fr); gap: 8px; font-size: 12px; }
  .k { color: var(--tx3); }
  .v { font-family: var(--mono); word-break: break-all; }
  .help { font-size: 12px; color: var(--tx3); margin-top: 4px; }
  .lnk { display: block; margin-top: 4px; color: var(--accent); font-size: 12px; font-weight: 500; text-decoration: none; }
  .lnk:hover { text-decoration: underline; }
</style>
