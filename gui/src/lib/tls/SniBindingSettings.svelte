<script lang="ts">
  /**
   * SNI 바인딩 설정 탭 — 콘솔 시안 `fieldsFor('sni', v, false, 'form')`: 구획 「기본」 의 이름(잠김) · 리스너 · 호스트 목록 · 인증서.
   * `put` 은 통째로 덮는다 — 폼에 없는 칸(`override` …)은 head 값 그대로 싣는다.
   */
  import { getContext, untrack } from 'svelte';
  import { page } from '$app/state';
  import { itemOf, resourcePath } from '@web/resources';
  import { FormRow, FormSection, Select, TextArea, TextInput } from '#lib/ui';
  import { after } from '#lib/after';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { isPendingResource } from '#lib/pending';
  import SettingsFrame from '#lib/detail/SettingsFrame.svelte';
  import { viewSecsOf } from '#lib/detail/view-secs';
  import { boundCerts, hostsError, hostsHelp, httpsListeners, listRows, parseHosts } from './sni-edit.ts';
  import { sniHosts } from './tls-view.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = untrack(() => page.params['key'] ?? '');
  const item0 = untrack(() => itemOf(desk.model, 'sniBinding', key));
  const init = {
    listener: String(item0?.['listener'] ?? ''),
    hosts: item0 === undefined ? '' : sniHosts(item0).join('\n'),
    cert: String(item0?.['certificate'] ?? ''),
  };
  let listener = $state<string | undefined>(init.listener || undefined);
  let hosts = $state(init.hosts);
  let cert = $state<string | undefined>(init.cert || undefined);
  let saving = $state(false);
  // 지금 값이 거름(HTTPS · 자료 있음)에 걸려도 고른 값으로 보이게 둔다.
  const listeners = $derived([...httpsListeners(desk).filter((l) => l.value !== init.listener), ...(init.listener === '' ? [] : [{ value: init.listener }])]);
  const certs = $derived(boundCerts(desk, init.cert));

  const err = $derived(hostsError(hosts));
  const dirty = $derived((listener ?? '') !== init.listener || (cert ?? '') !== init.cert || parseHosts(hosts).join('\n') !== parseHosts(init.hosts).join('\n'));
  const pending = $derived(isPendingResource(desk.pendingResources, 'sniBinding', key));

  const save = (): void => {
    const item = itemOf(desk.model, 'sniBinding', key);
    if (item === undefined || listener === undefined || cert === undefined) return;
    const { key: _k, ...rest } = item;
    saving = true;
    void desk.putResource('sniBinding', key, { ...rest, listener, hosts: parseHosts(hosts), certificate: cert })
      .then((ok) => { saving = false; after(resourcePath('sniBinding', key))(ok); });
  };
  const revert = (): void => { listener = init.listener || undefined; hosts = init.hosts; cert = init.cert || undefined; };
  /** 쓸 수 없을 때의 읽기 구획 — 분할 상세 보기 모드와 같은 `viewSecsOf`. */
  const view = $derived(viewSecsOf(desk.model, 'sniBinding', key));
</script>

<SettingsFrame {view} {dirty} invalid={err !== undefined} {pending} {saving} onsave={save} onrevert={revert}>
  <FormSection title="기본">
    <FormRow label="이름"><TextInput value={key} disabled /></FormRow>
    <FormRow label="리스너">
      <Select label="리스너" bind:value={listener} options={listeners} width="100%" />
    </FormRow>
    <FormRow label="호스트 목록" for="ss-hosts" error={err} help={hostsHelp(hosts)}>
      <TextArea id="ss-hosts" bind:value={hosts} invalid={err !== undefined} rows={listRows(hosts)} wrap="off" style="resize: none; white-space: pre" />
    </FormRow>
    <FormRow label="인증서">
      <Select label="인증서" bind:value={cert} options={certs} width="100%" />
    </FormRow>
  </FormSection>
</SettingsFrame>
