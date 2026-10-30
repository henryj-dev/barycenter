<script lang="ts">
  // backend 상세의 틀 — 탭·경로·수정 버튼. 표는 src/web/resources.ts 의 RESOURCES.
  import ResourceFrame from '#lib/detail/ResourceFrame.svelte';

  let { children } = $props();
</script>

<ResourceFrame kind="backend">{@render children()}</ResourceFrame>
