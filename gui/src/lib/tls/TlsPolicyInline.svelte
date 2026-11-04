<script lang="ts">
  /**
   * TLS 정책 분할 인라인 수정 — 콘솔 시안 `INL.tlspol`: 구획 「기본」 의 최소 버전 · 최대 버전 · 암호군.
   * 나머지 칸(HSTS · SNI-Host 불일치)은 head 값 그대로 다시 싣는다(`policyBody` 가 `base` 를 덮는다). 커밋 뒤 목록에 머문다.
   */
  import { getContext } from 'svelte';
  import { itemOf } from '@web/resources';
  import { FormRow, FormSection, Select } from '#lib/ui';
  import InlineEdit from '#lib/detail/InlineEdit.svelte';
  import { after } from '#lib/after';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { CIPHERS, MAX_VERSIONS, VERSIONS, policyBody, policyForm, rangeError } from './policy-edit.ts';

  let { key, detailHref, pending }: { key: string; detailHref: string; pending: boolean } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  // 고른 키가 바뀌면 ListSplit 이 {#key} 로 다시 만든다 — 처음 값은 마운트할 때 읽는다.
  // svelte-ignore state_referenced_locally
  const initial = policyForm(itemOf(desk.model, 'tlsPolicy', key));
  let min = $state(initial.min);
  let max = $state(initial.max);
  let cipher = $state(initial.cipher);
  const err = $derived(rangeError({ min, max }));
  const dirty = $derived(min !== initial.min || max !== initial.max || cipher !== initial.cipher);
  let saving = $state(false);

  const save = (): void => {
    const base = itemOf(desk.model, 'tlsPolicy', key);
    saving = true;
    void desk.putResource('tlsPolicy', key, policyBody({ ...policyForm(base), min, max, cipher }, base))
      .then((ok) => { saving = false; after()(ok); });
  };
  const revert = (): void => { min = initial.min; max = initial.max; cipher = initial.cipher; };
</script>

<InlineEdit {dirty} invalid={err !== undefined} {pending} {saving} {detailHref} onsave={save} onrevert={revert}>
  <FormSection title="기본">
    <FormRow label="최소 버전">
      <Select label="최소 버전" bind:value={min} options={VERSIONS} mono={false} width="100%" />
    </FormRow>
    <FormRow label="최대 버전" error={err}>
      <Select label="최대 버전" bind:value={max} options={MAX_VERSIONS} mono={false} width="100%" invalid={err !== undefined} />
    </FormRow>
    <FormRow label="암호군">
      <Select label="암호군" bind:value={cipher} options={CIPHERS} width="100%" />
    </FormRow>
  </FormSection>
</InlineEdit>
