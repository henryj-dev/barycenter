<script lang="ts">
  /** 혼자 서는 화면의 오류 한 줄 — 시안 「Login」 의 `✕ {lErr}`(13 · --danger). 제출 버튼 바로 위에 둔다. */
  import type { Snippet } from 'svelte';
  let { children }: { children: Snippet } = $props();
</script>

<div class="err" role="alert">✕ {@render children()}</div>

<style>
  .err { color: var(--danger); font-size: 13px; }
</style>
