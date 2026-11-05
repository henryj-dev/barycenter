<script lang="ts">
  /**
   * 주소 집합 만들기 (#114) — 콘솔 시안 `fieldsFor('sets', v, true, 'drawer')` 「기본」: 이름 · 대역 목록(대역 행).
   * 리스너의 출발지 제한이 `@이름` 으로 참조한다.
   * 모양은 CLI `bary address-set` 과 같은 `putAddressSetPatch` 가 만든다(끊기 · 중복 접기 · 집합 참조 거절).
   * 「출처」(2026-11-05)를 고르면 집합이 그 출처를 기억한다. 대역은 비어 있을 수 없어서 처음 목록은 여기서 넣고,
   * 만든 다음 「목록 다시 받기」 를 누르면 그 뒤로는 출처가 목록을 정한다.
   */
  import { getContext } from 'svelte';
  import { putAddressSetPatch } from '@web/edit';
  import { ADDRESS_SOURCE_MANUAL, addressSourceIssue, addressSourceOf } from '@web/address-source';
  import AddressSourceFields from './AddressSourceFields.svelte';
  import { FormRow, FormSection, TextInput } from '#lib/ui';
  import { resourcePath } from '@web/resources';
  import { after } from '#lib/after';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import CreateForm from './CreateForm.svelte';
  import SourceRows from './SourceRows.svelte';
  import { filled, keyError } from './checks';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  let key = $state('');
  let cidrs = $state('');
  let bad = $state(false);
  let src = $state({ ...ADDRESS_SOURCE_MANUAL });
  let problem = $state<string | undefined>();

  const err = $derived(bad ? '잘못된 대역이 있어요. 표시된 행을 고쳐요.' : undefined);
  const ready = $derived(filled(key, keyError) && cidrs.trim() !== '' && !bad && addressSourceIssue(src) === undefined);
  const submit = (): void => {
    problem = undefined;
    try {
      const [op] = putAddressSetPatch(key, { cidrs, ...addressSourceOf(src) });
      if (op !== undefined) void desk.putResource('addressSet', op.key, op.body).then(after(resourcePath('addressSet', op.key)));
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    }
  };
</script>

<CreateForm {ready} {problem} onsubmit={submit} cancelHref="/traffic/address-set">
  <FormSection title="기본">
    <FormRow label="이름" for="as-key" error={keyError(key)}>
      <TextInput id="as-key" bind:value={key} invalid={keyError(key) !== undefined} autocomplete="off" />
    </FormRow>
    <AddressSourceFields bind:form={src} idPrefix="asn" />
    <FormRow label="대역 목록" error={err} help={src.source === 'manual' ? 'CIDR이나 IP를 한 행에 하나씩 입력해요.' : '처음 목록을 넣거나, 만든 다음 「목록 다시 받기」 를 눌러요 — 그 뒤로는 출처가 목록을 정해요.'}>
      <SourceRows label="대역 목록" mode="ranges" bind:value={cidrs} bind:invalid={bad} />
    </FormRow>
  </FormSection>
</CreateForm>
