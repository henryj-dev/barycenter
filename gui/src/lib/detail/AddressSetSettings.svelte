<script lang="ts">
  /**
   * 주소 집합 설정 탭 — 콘솔 시안 `fieldsFor('sets', v, false, 'form')` 의 「기본」: 이름 · 출처 · 대역 목록(대역 행).
   *
   * 출처가 있는 집합(Cloudflare · AWS · Google Cloud · Fastly · URL — 2026-11-05)은 대역을 손으로 고치지 않는다(시안 `dis: ro`).
   * 시안의 「목록 다시 받기」 버튼이 출처에서 다시 받는다(`AddressSetRefresh` — 커밋까지). 출처를 바꾸는 것은 여기서 한다.
   * 모양은 만들기 폼과 같은 `putAddressSetPatch` 가 만든다 — 출처 · 옵션을 함께 실어 put 이 그것을 지우지 않게 한다.
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { putAddressSetPatch } from '@web/edit';
  import { ADDRESS_SOURCE_MANUAL, addressSourceFormOf, addressSourceIssue, addressSourceLabel, addressSourceOf } from '@web/address-source';
  import { itemOf, resourcePath } from '@web/resources';
  import { Banner, FormRow, FormSection, TextInput } from '#lib/ui';
  import { after } from '#lib/after';
  import SourceRows from '#lib/forms/SourceRows.svelte';
  import AddressSourceFields from '#lib/forms/AddressSourceFields.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import SettingsFrame from './SettingsFrame.svelte';
  import AddressSetRefresh from './AddressSetRefresh.svelte';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const item = $derived(itemOf(desk.model, 'addressSet', key));
  const saved = $derived(typeof item?.['source'] === 'string' ? String(item['source']) : undefined);

  let cidrs = $state('');
  let init = $state('');
  let src = $state({ ...ADDRESS_SOURCE_MANUAL });
  let srcInit = $state('');
  let bad = $state(false);
  let problem = $state<string | undefined>();
  let loaded = $state<string | undefined>();
  let gen = $state(0);

  $effect(() => {
    if (item === undefined || loaded === key) return;
    init = Array.isArray(item['cidrs']) ? (item['cidrs'] as string[]).join('\n') : '';
    cidrs = init;
    src = addressSourceFormOf(item);
    srcInit = JSON.stringify(src);
    gen += 1;
    loaded = key;
  });

  /** 출처가 있으면 대역 행이 잠긴다 — 출처가 목록을 정한다. */
  const ro = $derived(src.source !== 'manual');
  const err = $derived(bad ? '잘못된 대역이 있어요. 표시된 행을 고쳐요.' : cidrs.trim() === '' ? '대역을 하나 이상 입력해요.' : undefined);
  const srcIssue = $derived(addressSourceIssue(src));
  const dirty = $derived(cidrs.split('\n').map((l) => l.trim()).join('\n') !== init || JSON.stringify(src) !== srcInit);
  const save = (): void => {
    problem = undefined;
    try {
      const [op] = putAddressSetPatch(key, { cidrs, ...addressSourceOf(src) });
      if (op !== undefined) void desk.putResource('addressSet', op.key, op.body).then(after(resourcePath('addressSet', op.key)));
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    }
  };
</script>

{#if item !== undefined}
  <SettingsFrame kind="addressSet" {dirty} invalid={err !== undefined || srcIssue !== undefined} onsave={save} onrevert={() => { loaded = undefined; }}>
    {#if saved !== undefined}<AddressSetRefresh {key} source={saved} disabled={dirty} />{/if}
    <FormSection title="기본">
      <FormRow label="이름"><TextInput value={key} disabled /></FormRow>
      <AddressSourceFields bind:form={src} idPrefix="ass" />
      <FormRow label="대역 목록" error={ro ? undefined : err} help={ro ? `${addressSourceLabel(src.source)}에서 받아와요. 직접 수정할 수 없어요.${saved === undefined ? ' 저장한 다음 「목록 다시 받기」 로 받아요.' : ''}` : 'CIDR이나 IP를 한 행에 하나씩 입력해요.'}>
        {#key gen}<SourceRows label="대역 목록" mode="ranges" bind:value={cidrs} bind:invalid={bad} disabled={ro} />{/key}
      </FormRow>
    </FormSection>
    {#if problem !== undefined}<Banner tone="danger">{problem}</Banner>{/if}
  </SettingsFrame>
{/if}
