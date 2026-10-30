<script lang="ts">
  /** 라우트 목록 위 세그먼트 — HTTP · 패스스루(시안 `rkind`). 세그먼트가 주소다. */
  import { Tabs } from '#lib/ui';
  let { current }: { current: 'http' | 'passthrough' } = $props();
</script>

<Tabs label="라우트 종류" {current} items={[
  { key: 'http', label: 'HTTP', href: '/traffic/route/http' },
  { key: 'passthrough', label: '패스스루', href: '/traffic/route/passthrough' },
]} />
