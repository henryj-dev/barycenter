<script lang="ts">
  /**
   * 주소 집합 만들기 (#114) — 콘솔 시안 `fieldsFor('sets', v, true, 'drawer')` 「기본」: 이름 · 대역 목록(대역 행).
   * 리스너의 출발지 제한이 `@이름` 으로 참조한다.
   * 모양은 CLI `bary address-set` 과 같은 `putAddressSetPatch` 가 만든다(끊기 · 중복 접기 · 집합 참조 거절).
   */
  import { getContext } from 'svelte';
  import { putAddressSetPatch } from '@web/edit';
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
  let problem = $state<string | undefined>();

  const err = $derived(bad ? '잘못된 대역이 있어요. 표시된 행을 고쳐요.' : undefined);
  const ready = $derived(filled(key, keyError) && cidrs.trim() !== '' && !bad);
  const submit = (): void => {
    problem = undefined;
    try {
      const [op] = putAddressSetPatch(key, { cidrs });
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
    <FormRow label="대역 목록" error={err} help="CIDR이나 IP를 한 행에 하나씩 입력해요.">
      <SourceRows label="대역 목록" mode="ranges" bind:value={cidrs} bind:invalid={bad} />
    </FormRow>
  </FormSection>
</CreateForm>
