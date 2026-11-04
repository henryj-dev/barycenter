<script lang="ts">
  // tlsPolicy 상세의 틀 — 탭·경로·버튼(`ResourceFrame`)에 시안 값을 넘긴다(`TlsFrame`).
  import TlsFrame from '#lib/tls/TlsFrame.svelte';

  let { children } = $props();
</script>

<TlsFrame kind="tlsPolicy">{@render children()}</TlsFrame>
