import { getContext, type Snippet } from 'svelte';

/**
 * 페이지 머리 오른쪽에 버튼을 둔다(시안: 제목 오른쪽 「＋ 만들기」). 컴포넌트 초기화 때 부른다 —
 * 그 컴포넌트가 사라지면 비운다.
 *
 *   {#snippet create()}<Button variant="primary" href="/traffic/pool/new">＋ 풀 만들기</Button>{/snippet}
 *   usePageActions(() => create);
 */
export function usePageActions(get: () => Snippet | undefined): void {
  const slot = getContext<{ snippet?: Snippet } | undefined>('pageActions');
  if (slot === undefined) return;
  $effect(() => {
    slot.snippet = get();
    return () => { slot.snippet = undefined; };
  });
}
