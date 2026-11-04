<script lang="ts">
  /**
   * 견본용 desk — 이 아래의 컴포넌트가 `getContext('desk')` 로 읽는 모델만 예시로 덮는다.
   * `SourceRulesField` 가 `@집합` 을 펼쳐 가려짐을 보이려면 주소 집합이 있어야 한다. API 를 부르지 않는다.
   */
  import { setContext, untrack, type Snippet } from 'svelte';

  let { addressSets, children }: { addressSets: { key: string; cidrs: string[] }[]; children: Snippet } = $props();
  // 처음 값으로 고정한다 — 견본 데이터라 바뀌지 않는다.
  setContext('desk', { model: { addressSets: untrack(() => addressSets) } });
</script>

{@render children()}
