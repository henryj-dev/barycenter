<script lang="ts">
  /** 로딩 표시 — 글자색을 따른다. 버튼 안에서 쓴다. */
  let { size = 12, label }: { size?: number; label?: string } = $props();
</script>

<span class="spin" style:width="{size}px" style:height="{size}px" role={label ? 'status' : undefined} aria-label={label}></span>

<style>
  .spin {
    display: inline-block;
    flex: none;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: bc-spin .8s linear infinite;
  }
</style>
