<script lang="ts">
  /**
   * 「이름 바꾸기…」 (2026-11-20). 새 이름을 넣으면 저장(commit)까지 한다 — 적용은 따로다.
   *
   * 이것을 쓰는 리소스는 서버가 함께 새 이름으로 옮긴다. 확인 창은 그 수를 미리 말한다.
   * 바꾼 뒤에는 새 이름의 상세로 간다.
   */
  import { getContext } from 'svelte';
  import { RESOURCES, itemOf, relationsOf, resourcePath, type ResourceKind } from '@web/resources';
  import { after } from '#lib/after';
  import { ConfirmDialog, FieldMessage, TextInput, type ConfirmLine } from '#lib/ui';
  import { KEY_HELP, keyError } from '#lib/forms/key-rule';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';

  let { target = $bindable() }: { target?: { kind: ResourceKind; key: string } } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const where = $derived(scope?.mode === 'global' && scope.region !== undefined ? ` 지역: ${scope.region.name}` : '');

  let next = $state('');
  $effect(() => { next = target?.key ?? ''; });
  const trimmed = $derived(next.trim());
  const problem = $derived.by(() => {
    if (target === undefined || trimmed === '' || trimmed === target.key) return undefined;
    if (itemOf(desk.model, target.kind, trimmed) !== undefined) return `${RESOURCES[target.kind].label} ${trimmed} 가 이미 있어요.`;
    return keyError(trimmed);
  });
  const ready = $derived(target !== undefined && trimmed !== '' && trimmed !== target.key && problem === undefined);
  const usedBy = $derived(target === undefined ? [] : relationsOf(desk.model, target).usedBy);
  const lines = $derived<ConfirmLine[]>([
    usedBy.length === 0
      ? { tone: 'ok', icon: '●', text: '이것을 쓰는 리소스가 없어요.' }
      : { tone: 'ok', icon: '●', text: `이것을 쓰는 리소스 ${usedBy.length}개도 새 이름을 보게 바뀌어요.` },
    { tone: 'warn', icon: '▲', text: '적용하면 nginx 설정의 이름이 바뀌어 새 세대가 만들어져요. 연결은 끊기지 않아요.' },
  ]);
</script>

{#if target !== undefined}
  <ConfirmDialog open title={`이름 바꾸기: ${RESOURCES[target.kind].label} ${target.key}`}
    sub={`저장하면 커밋해요. 트래픽은 적용해야 바뀌어요.${where}`} {lines} danger={false}
    confirmLabel="이름 바꾸기" busy={desk.editing} disabled={!ready}
    oncancel={() => { target = undefined; }}
    onconfirm={() => {
      const t = target!;
      const to = trimmed;
      void desk.rename(t.kind, t.key, to).then((ok) => {
        if (ok) target = undefined;
        after(resourcePath(t.kind, to), '이름 변경을 커밋했어요')(ok);
      });
    }}>
    {#snippet body()}
      <label for="rename-to" class="nl">새 이름</label>
      <div class="ni"><TextInput id="rename-to" bind:value={next} autocomplete="off" /></div>
      {#if problem !== undefined}<FieldMessage tone="error">{problem}</FieldMessage>{:else}<FieldMessage>{KEY_HELP}</FieldMessage>{/if}
    {/snippet}
  </ConfirmDialog>
{/if}

<style>
  .nl { font: var(--t-cap); color: var(--tx2); }
  .ni { margin-top: 6px; }
</style>
