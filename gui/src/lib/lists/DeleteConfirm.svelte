<script lang="ts">
  /**
   * 「삭제…」 — 이름을 똑같이 넣어야 확인이 열린다(시안 §7). 이것을 쓰는 리소스가 있으면
   * plan 이 막힌다고 미리 말한다 — 실제로 쓰는 리소스를 줄마다 든다. 저장(commit)까지이고 적용은 따로다.
   *
   * 목록과 상세 머리가 같이 쓴다. 상세에서는 지운 뒤 목록으로 간다(`href`).
   * 백엔드 목록의 「풀에서 빼기…」 는 같은 삭제를 시안의 말로 묻는다(`remove`).
   */
  import { getContext } from 'svelte';
  import { RESOURCES, itemOf, relationsOf, type ResourceKind } from '@web/resources';
  import { after } from '#lib/after';
  import { ConfirmDialog, type ConfirmLine } from '#lib/ui';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';

  let { target = $bindable(), href, remove = false }: {
    target?: { kind: ResourceKind; key: string };
    /** 지운 뒤 갈 곳. 없으면 그 자리에 머문다(목록). */
    href?: string;
    /** 백엔드를 풀에서 빼기 — 제목과 확인 버튼이 「풀에서 빼기」 다. */
    remove?: boolean;
  } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  /** 전역이면 삭제가 갈 지역을 확인 문구에 단다 — 적용 · 롤백 확인과 같은 꼴. 지역 인스턴스면 빈 말. */
  const where = $derived(scope?.mode === 'global' && scope.region !== undefined ? ` 지역: ${scope.region.name}` : '');
  const usedBy = $derived(target === undefined ? [] : relationsOf(desk.model, target).usedBy);
  const pool = $derived(remove && target !== undefined ? itemOf(desk.model, 'backend', target.key)?.['pool'] : undefined);
  const lines = $derived<ConfirmLine[]>([
    ...(typeof pool === 'string' ? [{ tone: 'warn' as const, icon: '▲', text: `풀 ${pool} 에서 빠져요. 적용하면 이 백엔드로 트래픽이 가지 않아요.` }] : []),
    ...(usedBy.length === 0
      ? [{ tone: 'ok' as const, icon: '●', text: '이것을 쓰는 리소스가 없어요.' }]
      : usedBy.slice(0, 5).map((e) => ({ tone: 'danger' as const, icon: '✕', text: `${RESOURCES[e.from.kind].label} ${e.from.key} 가 이것을 써요(${e.via}). 먼저 바꾸지 않으면 plan 이 막혀요.` }))),
  ]);
</script>

{#if target !== undefined}
  <ConfirmDialog open title={remove ? `풀에서 빼기: ${target.key}` : `삭제: ${RESOURCES[target.kind].label} ${target.key} 를 설정에서 빼요`}
    sub={`저장하면 커밋해요. 트래픽은 적용해야 바뀌어요.${where}`} {lines} requireName={target.key} confirmLabel={remove ? '풀에서 빼기' : '삭제해요'} busy={desk.editing}
    oncancel={() => { target = undefined; }}
    onconfirm={() => { const t = target!; void desk.withdraw(t.kind, t.key).then((ok) => { target = undefined; after(href, remove ? '풀에서 빼기를 커밋했어요' : '삭제를 커밋했어요')(ok); }); }} />
{/if}
