<script lang="ts">
  /** 불러오는 중 자리 — 디자인 시스템 §3·§4. 깜빡이는 회색 막대. */
  let { width = '100%', height = '32px', label = '불러오는 중' }: { width?: string; height?: string; label?: string } = $props();
</script>

<span class="sk" style:width style:height role="status" aria-label={label}></span>

<style>
  .sk { display: block; border-radius: var(--r-md); background: var(--bg-hover); animation: bc-pulse 1.2s ease-in-out infinite; }
</style>
