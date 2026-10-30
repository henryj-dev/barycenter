<script lang="ts">
  /**
   * 인증서 넣기 — PEM 자료를 올리고(`/certificates/material`) 그 참조로 인증서를 커밋한다.
   * 개인 키는 서버가 암호화해서 둔다. 화면은 붙여 넣은 값을 다시 보이지 않는다.
   */
  import { getContext } from 'svelte';
  import { FormRow, FormSection, TextArea, TextInput } from '#lib/ui';
  import { resourcePath } from '@web/resources';
  import { after } from '#lib/after';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import CreateForm from './CreateForm.svelte';
  import { KEY_HELP, filled, keyError } from './checks';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  let key = $state('');
  let fullchain = $state('');
  let privkey = $state('');

  const pem = (v: string, label: string): string | undefined =>
    (v.trim() === '' || v.includes(`-----BEGIN ${label}`) ? undefined : `PEM 이 아니에요. -----BEGIN ${label} 으로 시작해요.`);
  const chainBad = $derived(pem(fullchain, 'CERTIFICATE'));
  const keyBad = $derived(privkey.trim() === '' || /-----BEGIN [A-Z ]*PRIVATE KEY/.test(privkey) ? undefined : 'PEM 개인 키가 아니에요. -----BEGIN … PRIVATE KEY 로 시작해요.');
  const ready = $derived(filled(key, keyError) && filled(fullchain) && filled(privkey) && chainBad === undefined && keyBad === undefined);
  const submit = (): void => {
    void desk.insertCertificate(key.trim(), { fullchain: fullchain.trim(), privkey: privkey.trim() }).then(after(resourcePath('certificate', key.trim())));
  };
</script>

<CreateForm {ready} onsubmit={submit} cancelHref="/tls/certificate" submitLabel="자료를 넣어요">
  <FormSection title="기본">
    <FormRow label="이름" for="ct-key" required error={keyError(key)} help={KEY_HELP}>
      <TextInput id="ct-key" bind:value={key} invalid={keyError(key) !== undefined} autocomplete="off" placeholder="example-com" />
    </FormRow>
  </FormSection>
  <FormSection title="자료" hint="PEM">
    <FormRow label="인증서 체인" for="ct-chain" required error={chainBad} help="서버 인증서 다음에 중간 인증서를 붙여요(fullchain).">
      <TextArea id="ct-chain" bind:value={fullchain} invalid={chainBad !== undefined} rows={8} placeholder="-----BEGIN CERTIFICATE-----" />
    </FormRow>
    <FormRow label="개인 키" for="ct-key-pem" required error={keyBad} help="서버가 암호화해서 보관해요.">
      <TextArea id="ct-key-pem" bind:value={privkey} invalid={keyBad !== undefined} rows={6} placeholder="-----BEGIN PRIVATE KEY-----" autocomplete="off" />
    </FormRow>
  </FormSection>
</CreateForm>
