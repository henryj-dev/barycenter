<script lang="ts">
  /** SNI 바인딩 만들기 — HTTPS 리스너에서 이 호스트들에는 이 인증서를 낸다 (시안: 이름 · 리스너 · 호스트 목록 · 인증서). */
  import { getContext } from 'svelte';
  import { FormRow, FormSection, ListInput, Select, TextInput } from '#lib/ui';
  import { resourcePath } from '@web/resources';
  import { after } from '#lib/after';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import CreateForm from './CreateForm.svelte';
  import { KEY_HELP, filled, keyError, words } from './checks';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const listeners = $derived(desk.listeners.rows
    .filter((l) => l.protocol === 'https').map((l) => ({ value: l.key })));
  const certs = $derived(desk.certs.rows.filter((c) => c.hasMaterial).map((c) => ({ value: c.key })));

  let key = $state('');
  let listener = $state<string | undefined>();
  let hosts = $state('');
  let certificate = $state<string | undefined>();

  const ready = $derived(filled(key, keyError) && listener !== undefined && certificate !== undefined && words(hosts).length > 0);
  const submit = (): void => {
    if (listener === undefined || certificate === undefined) return;
    void desk.insertSniBinding({ key: key.trim(), listener, hosts: words(hosts), certificate }).then(after(resourcePath('sniBinding', key.trim())));
  };
</script>

<CreateForm {ready} onsubmit={submit} cancelHref="/tls/sni">
  <FormSection title="기본">
    <FormRow label="이름" for="sb-key" required error={keyError(key)} help={KEY_HELP}>
      <TextInput id="sb-key" bind:value={key} invalid={keyError(key) !== undefined} autocomplete="off" placeholder="api" />
    </FormRow>
    <FormRow label="리스너" required help={listeners.length === 0 ? 'HTTPS 리스너가 없어요. 리스너를 먼저 만들어요.' : undefined}>
      <Select label="리스너" bind:value={listener} options={listeners} placeholder="리스너를 골라요" width="100%" disabled={listeners.length === 0} />
    </FormRow>
    <FormRow label="호스트 목록" required help="한 줄에 하나씩 넣어요.">
      <ListInput label="호스트 목록" bind:value={hosts} minRows={3} placeholder="api.example.com" />
    </FormRow>
    <FormRow label="인증서" required help={certs.length === 0 ? '자료가 있는 인증서가 없어요. 인증서를 먼저 넣어요.' : undefined}>
      <Select label="인증서" bind:value={certificate} options={certs} placeholder="인증서를 골라요" width="100%" disabled={certs.length === 0} />
    </FormRow>
  </FormSection>
</CreateForm>
