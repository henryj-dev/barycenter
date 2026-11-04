<script lang="ts">
  // certificate 상세의 틀 — 탭·경로·버튼(`ResourceFrame`)에 시안 값(제목 옆 배지 · 메타 줄 · 수정 자리)을 넘긴다(`TlsFrame`).
  import TlsFrame from '#lib/tls/TlsFrame.svelte';

  let { children } = $props();
</script>

<TlsFrame kind="certificate">{@render children()}</TlsFrame>
