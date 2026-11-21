<script lang="ts">
  /**
   * 전체 합산에서 「지역마다 다른 것」 을 보는 화면의 안내 (2026-11-21) — 소켓 · 백엔드 출처 · ACME 계정.
   * 합산에는 읽을 지역이 하나로 정해지지 않는다. 지역을 골라 좁히면 그 지역의 것을 읽는다.
   */
  let { what }: { what: string } = $props();
</script>

<p class="note" role="status">{what}은(는) 지역마다 달라요. 지역을 골라 좁혀 보면 그 지역의 것을 보여요. <a href="/regions">지역 고르기</a></p>

<style>
  .note { margin: 0; font: var(--t-small); color: var(--tx2); display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .note a { color: var(--accent); }
</style>
