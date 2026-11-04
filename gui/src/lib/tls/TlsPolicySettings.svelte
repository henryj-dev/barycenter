<script lang="ts">
  /**
   * TLS 정책 설정 탭 — 콘솔 시안 `fieldsFor('tlspol', v, false, 'form')`: 기본(이름 잠김 · 최소 · 최대 버전 · 암호군) ·
   * HSTS(HSTS · max-age) · 검증(SNI-Host 불일치). 시안에 없는 기존 칸: 최대 버전 「제한 없음」 · 「하위 도메인」.
   * `put` 은 통째로 덮는다 — 폼에 없는 칸(HSTS `preload` …)은 head 값 그대로 싣는다(`policyBody` 의 `base`).
   */
  import { getContext, untrack } from 'svelte';
  import { page } from '$app/state';
  import { itemOf, resourcePath } from '@web/resources';
  import { FormRow, FormSection, NumberInput, Select, Switch, TextInput } from '#lib/ui';
  import { after } from '#lib/after';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { isPendingResource } from '#lib/pending';
  import SettingsFrame from './SettingsFrame.svelte';
  import { CIPHERS, HSTS_MAX, MAX_VERSIONS, MISMATCH, VERSIONS, ageError, policyBody, policyForm, rangeError, type PolicyForm } from './policy-edit.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = untrack(() => page.params['key'] ?? '');
  const initial: PolicyForm = untrack(() => policyForm(itemOf(desk.model, 'tlsPolicy', key)));
  let f = $state<PolicyForm>({ ...initial });
  let saving = $state(false);

  const range = $derived(rangeError(f));
  const age = $derived(ageError(f));
  const dirty = $derived((Object.keys(initial) as (keyof PolicyForm)[]).some((k) => String(f[k]) !== String(initial[k])));
  const pending = $derived(isPendingResource(desk.pendingResources, 'tlsPolicy', key));

  const save = (): void => {
    saving = true;
    void desk.putResource('tlsPolicy', key, policyBody(f, itemOf(desk.model, 'tlsPolicy', key)))
      .then((ok) => { saving = false; after(resourcePath('tlsPolicy', key))(ok); });
  };
  const label = <T extends string>(opts: readonly { value: T; label: string }[], v: T): string => opts.find((o) => o.value === v)?.label ?? v;
  const view = $derived([
    { t: '기본', f: [{ l: '이름', v: key, mono: true }, { l: '최소 버전', v: label(VERSIONS, initial.min) }, { l: '최대 버전', v: label(MAX_VERSIONS, initial.max) }, { l: '암호군', v: initial.cipher, mono: true }] },
    { t: 'HSTS', f: [{ l: 'HSTS', v: initial.hsts ? '켜짐' : '꺼짐' }, ...(initial.hsts ? [{ l: 'max-age', v: `${initial.maxAge} s`, mono: true }] : [])] },
    { t: '검증', f: [{ l: 'SNI-Host 불일치', v: label(MISMATCH, initial.mismatch) }] },
  ]);
</script>

<SettingsFrame {view} {dirty} invalid={range !== undefined || age !== undefined} {pending} {saving} onsave={save} onrevert={() => { f = { ...initial }; }}>
  <FormSection title="기본">
    <FormRow label="이름"><TextInput value={key} disabled /></FormRow>
    <FormRow label="최소 버전">
      <Select label="최소 버전" bind:value={f.min} options={VERSIONS} mono={false} width="100%" />
    </FormRow>
    <FormRow label="최대 버전" error={range}>
      <Select label="최대 버전" bind:value={f.max} options={MAX_VERSIONS} mono={false} width="100%" invalid={range !== undefined} />
    </FormRow>
    <FormRow label="암호군">
      <Select label="암호군" bind:value={f.cipher} options={CIPHERS} width="100%" />
    </FormRow>
  </FormSection>
  <FormSection title="HSTS">
    <FormRow label="HSTS">
      <Switch bind:checked={f.hsts}>{f.hsts ? '켜짐' : '꺼짐'}</Switch>
      {#if f.hsts && !initial.hsts}<div class="warn">▲ HSTS 는 브라우저에서 되돌릴 수 없어요. 설정을 꺼도 max-age 동안 https 로만 와요. 인증서가 깨지면 사용자가 우회하지 못해요.</div>{/if}
    </FormRow>
    {#if f.hsts}
      <FormRow label="max-age" error={age}>
        <NumberInput label="max-age" bind:value={f.maxAge} unit="s" width="100%" min="0" max={HSTS_MAX} invalid={age !== undefined} />
      </FormRow>
      <FormRow label="하위 도메인">
        <Switch bind:checked={f.subdomains}>{f.subdomains ? '켜짐' : '꺼짐'}</Switch>
      </FormRow>
    {/if}
  </FormSection>
  <FormSection title="검증">
    <FormRow label="SNI-Host 불일치">
      <Select label="SNI-Host 불일치" bind:value={f.mismatch} options={MISMATCH} mono={false} width="100%" />
    </FormRow>
  </FormSection>
</SettingsFrame>

<style>
  .warn { font-size: 12px; color: var(--warn); margin-top: 4px; }
</style>
