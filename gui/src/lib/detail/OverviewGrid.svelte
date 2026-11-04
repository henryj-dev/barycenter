<script lang="ts">
  /**
   * 개요 탭의 격자 — 콘솔 시안 `tOv` · `ovRows` 블록 그대로. 모든 리소스가 같다.
   * 칸마다 라벨(12px · 흐린색) · 값(고정폭 칸이면 고정폭). 격자는 auto-fit · 최소 220px · 간격 14px 24px.
   * 격자 아래 한 칸을 다 쓰는 상자(인증서 「ACME 주문」 · 백엔드 헬스)는 `children` 으로 받는다.
   */
  import type { Snippet } from 'svelte';
  let { rows, children }: {
    rows: readonly { l: string; v: string; mono?: boolean; title?: string }[];
    children?: Snippet;
  } = $props();
</script>

<div class="ov">
  {#each rows as r (r.l)}<div><div class="l">{r.l}</div><div class="v" class:mono={r.mono} title={r.title}>{r.v}</div></div>{/each}
  {#if children}<div class="box">{@render children()}</div>{/if}
</div>

<style>
  /* 값은 콘솔 시안 `tOv` 블록의 인라인 style 그대로다. */
  .ov { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px 24px; font-size: 13px; align-content: start; }
  .l { font-size: 12px; color: var(--tx3); }
  .v { font-family: var(--font); overflow-wrap: anywhere; }
  .v.mono { font-family: var(--mono); }
  .box { grid-column: 1 / -1; }
  .box:empty { display: none; }
</style>
