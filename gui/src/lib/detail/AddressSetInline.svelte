<script lang="ts">
  /**
   * 주소 집합 분할 상세의 인라인 수정 — 콘솔 시안 `isecs`(`INL.sets`: ranges), 구획 「기본」 의 「대역 목록」.
   * 공개 목록에서 받은 집합(`source: cloudflare`)은 손으로 고치지 않는다(시안 `dis: ro`) — 행이 잠기고 도움말이 그렇게 말한다.
   * 저장은 만들기 · 설정 탭과 같은 `putAddressSetPatch` → `putResource`(commit, 이 집합을 쓰는 리스너가 적용 대기에 오른다).
   */
  import { getContext } from 'svelte';
  import { putAddressSetPatch } from '@web/edit';
  import { itemOf } from '@web/resources';
  import { FormRow, FormSection } from '#lib/ui';
  import { after } from '#lib/after';
  import SourceRows from '#lib/forms/SourceRows.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import InlineEdit from './InlineEdit.svelte';

  let { key, detailHref, pending }: { key: string; detailHref: string; pending: boolean } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  // svelte-ignore state_referenced_locally
  const item = itemOf(desk.model, 'addressSet', key);
  const ro = item?.['source'] === 'cloudflare';
  const init = Array.isArray(item?.['cidrs']) ? (item['cidrs'] as string[]).join('\n') : '';
  let cidrs = $state(init);
  let bad = $state(false);
  let gen = $state(0);
  let saving = $state(false);
  const empty = $derived(cidrs.trim() === '');
  const err = $derived(bad ? '잘못된 대역이 있어요. 표시된 행을 고쳐요.' : empty ? '대역을 하나 이상 입력해요.' : undefined);
  const dirty = $derived(!ro && cidrs.split('\n').map((l) => l.trim()).join('\n') !== init);
  const save = (): void => {
    const [op] = putAddressSetPatch(key, { cidrs });
    if (op === undefined) return;
    saving = true;
    void desk.putResource('addressSet', op.key, op.body).then((ok) => { saving = false; after()(ok); });
  };
</script>

{#if item !== undefined}
  <InlineEdit {dirty} invalid={err !== undefined} {pending} {saving} {detailHref} onsave={save} onrevert={() => { cidrs = init; gen += 1; }}>
    <FormSection title="기본">
      <FormRow label="대역 목록" error={ro ? undefined : err} help={ro ? 'Cloudflare 공개 목록에서 받아와요. 직접 수정할 수 없어요.' : 'CIDR이나 IP를 한 행에 하나씩 입력해요.'}>
        {#key gen}<SourceRows label="대역 목록" mode="ranges" bind:value={cidrs} bind:invalid={bad} disabled={ro} />{/key}
      </FormRow>
    </FormSection>
  </InlineEdit>
{/if}
