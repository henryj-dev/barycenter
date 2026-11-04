<script lang="ts">
  /**
   * SNI 바인딩 만들기 — 콘솔 시안 `fieldsFor('sni', v, true, 'drawer')`: 구획 「기본」 의 이름 · 리스너 · 호스트 목록 · 인증서.
   * HTTPS 리스너에서 이 호스트들에는 이 인증서를 낸다. 리스너 · 인증서는 처음 것으로 골라 둔다(시안).
   * 인증서는 자료가 있는 것만 고른다 — 자료 없는 인증서는 바인딩할 수 없다(검증기가 막는다, 시안에는 이 거름이 없다).
   */
  import { getContext, untrack } from 'svelte';
  import { FormRow, FormSection, Select, TextArea, TextInput } from '#lib/ui';
  import { resourcePath } from '@web/resources';
  import { after } from '#lib/after';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { boundCerts, hostsError, hostsHelp, httpsListeners, listRows, parseHosts } from '#lib/tls/sni-edit.ts';
  import CreateForm from './CreateForm.svelte';
  import { filled, keyError } from './checks';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const listeners = $derived(httpsListeners(desk));
  const certs = $derived(boundCerts(desk));

  let key = $state('');
  let listener = $state<string | undefined>();
  let hosts = $state('');
  let certificate = $state<string | undefined>();
  // 시안: 처음 것으로 골라 둔다. 목록이 늦게 와도 한 번만.
  $effect(() => { const l = listeners[0]?.value; if (l !== undefined && untrack(() => listener) === undefined) listener = l; });
  $effect(() => { const c = certs[0]?.value; if (c !== undefined && untrack(() => certificate) === undefined) certificate = c; });

  const keyBad = $derived(keyError(key) === undefined ? undefined : '이름은 영문·숫자로 시작하고 영문, 숫자, 점(.), 밑줄(_), 하이픈(-)만 쓸 수 있어요. 63자까지예요.');
  const hostsBad = $derived(hosts.trim() === '' ? undefined : hostsError(hosts));
  const ready = $derived(filled(key, keyError) && listener !== undefined && certificate !== undefined && parseHosts(hosts).length > 0);
  const submit = (): void => {
    if (listener === undefined || certificate === undefined) return;
    void desk.insertSniBinding({ key: key.trim(), listener, hosts: parseHosts(hosts), certificate }).then(after(resourcePath('sniBinding', key.trim())));
  };
</script>

<CreateForm {ready} onsubmit={submit} cancelHref="/tls/sni">
  <FormSection title="기본">
    <FormRow label="이름" for="sb-key" error={keyBad}>
      <TextInput id="sb-key" bind:value={key} invalid={keyBad !== undefined} autocomplete="off" />
    </FormRow>
    <FormRow label="리스너" help={listeners.length === 0 ? 'HTTPS 리스너가 없어요. 리스너를 먼저 만들어요.' : undefined}>
      <Select label="리스너" bind:value={listener} options={listeners} placeholder="리스너를 골라요" width="100%" disabled={listeners.length === 0} />
    </FormRow>
    <FormRow label="호스트 목록" for="sb-hosts" error={hostsBad} help={hostsHelp(hosts)}>
      <TextArea id="sb-hosts" bind:value={hosts} invalid={hostsBad !== undefined} rows={listRows(hosts)} wrap="off" style="resize: none; white-space: pre" />
    </FormRow>
    <FormRow label="인증서" help={certs.length === 0 ? '자료가 있는 인증서가 없어요. 인증서를 먼저 넣어요.' : undefined}>
      <Select label="인증서" bind:value={certificate} options={certs} placeholder="인증서를 골라요" width="100%" disabled={certs.length === 0} />
    </FormRow>
  </FormSection>
</CreateForm>
