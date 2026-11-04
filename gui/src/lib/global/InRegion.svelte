<script lang="ts">
  /**
   * **이 아래는 그 지역을 본다** — 전체 합산의 행 하나 · 확인 창 하나를 그 지역의 desk · 범위로 그린다(2026-11-04, §2.5).
   *
   * `setContext('desk' | 'scope', …)` 를 그 지역 것으로 덮는다. 그래서 `PendingMark` · `DeleteConfirm` · `BackendReasons` 처럼
   * `getContext('desk')` 로 읽고 쓰는 컴포넌트를 고치지 않고 그 지역에 쓴다. 컨텍스트는 처음 그릴 때 한 번 정해진다 —
   * 지역이 바뀔 수 있는 자리는 `{#key entry.name}` 로 감싼다.
   */
  import { setContext, untrack, type Snippet } from 'svelte';
  import type { RegionEntry } from './regions.svelte.ts';

  let { entry, children }: { entry: RegionEntry; children: Snippet } = $props();
  // 처음 값으로 고정한다(위 설명) — 지역이 바뀌면 부르는 쪽이 {#key} 로 다시 만든다.
  const first = untrack(() => entry);
  setContext('desk', first.desk);
  setContext('scope', first.scope);
</script>

{@render children()}
