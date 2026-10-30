<script lang="ts">
  /**
   * 목록의 「삭제…」 — 이름을 똑같이 넣어야 확인이 열린다(시안 §7). 이것을 쓰는 리소스가 있으면
   * plan 이 막힌다고 미리 말한다. 저장(commit)까지이고 적용은 따로다.
   */
  import { getContext } from 'svelte';
  import { RESOURCES, relationsOf, type ResourceKind } from '@web/resources';
  import { after } from '#lib/after';
  import { ConfirmDialog, type ConfirmLine } from '#lib/ui';
  import type { createDesk } from '#lib/desk.svelte.ts';

  let { target = $bindable() }: { target?: { kind: ResourceKind; key: string } } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const usedBy = $derived(target === undefined ? [] : relationsOf(desk.model, target).usedBy);
  const lines = $derived<ConfirmLine[]>(usedBy.length === 0
    ? [{ tone: 'ok', icon: '●', text: '이것을 쓰는 리소스가 없어요.' }]
    : usedBy.slice(0, 5).map((e) => ({ tone: 'danger', icon: '✕', text: `${RESOURCES[e.from.kind].label} ${e.from.key} 가 이것을 써요(${e.via}). 먼저 바꾸지 않으면 plan 이 막혀요.` })));
</script>

{#if target !== undefined}
  <ConfirmDialog open title="삭제: {RESOURCES[target.kind].label} {target.key} 를 설정에서 빼요"
    sub="저장하면 커밋해요. 트래픽은 적용해야 바뀌어요." {lines} requireName={target.key} confirmLabel="삭제해요" busy={desk.editing}
    oncancel={() => { target = undefined; }}
    onconfirm={() => { const t = target!; void desk.withdraw(t.kind, t.key).then((ok) => { target = undefined; after(ok); }); }} />
{/if}
