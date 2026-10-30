<script lang="ts">
  /** TLS 정책 만들기 — 지금 정할 수 있는 것은 최소 버전이다. */
  import { getContext } from 'svelte';
  import type { TlsVersion } from '@web/edit';
  import { FormRow, FormSection, Select, TextInput } from '#lib/ui';
  import { after } from '#lib/after';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import CreateForm from './CreateForm.svelte';
  import { KEY_HELP, filled, keyError } from './checks';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const VERSIONS: { value: TlsVersion; label: string }[] = [{ value: '1.2', label: 'TLS 1.2' }, { value: '1.3', label: 'TLS 1.3' }];

  let key = $state('');
  let minVersion = $state<TlsVersion>('1.2');

  const ready = $derived(filled(key, keyError));
  const submit = (): void => { void desk.insertTlsPolicy(key.trim(), minVersion).then(after); };
</script>

<CreateForm {ready} onsubmit={submit} cancelHref="/tls/policy">
  <FormSection title="기본">
    <FormRow label="이름" for="tp-key" required error={keyError(key)} help={KEY_HELP}>
      <TextInput id="tp-key" bind:value={key} invalid={keyError(key) !== undefined} autocomplete="off" placeholder="modern" />
    </FormRow>
    <FormRow label="최소 버전" required help="이보다 낮은 버전의 연결은 거절해요.">
      <Select label="최소 버전" bind:value={minVersion} options={VERSIONS} mono={false} />
    </FormRow>
  </FormSection>
</CreateForm>
