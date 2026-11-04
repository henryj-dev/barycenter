<script lang="ts">
  /**
   * SNI 바인딩 분할 인라인 수정 — 콘솔 시안 `INL.sni`: 구획 「기본」 의 호스트 목록 · 인증서.
   * 리스너 · 그 밖의 칸은 head 값 그대로 다시 싣는다(`put` 은 통째로 덮는다). 커밋 뒤 목록에 머문다.
   */
  import { getContext } from 'svelte';
  import { itemOf } from '@web/resources';
  import { FormRow, FormSection, Select, TextArea } from '#lib/ui';
  import InlineEdit from '#lib/detail/InlineEdit.svelte';
  import { after } from '#lib/after';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { boundCerts, hostsError, hostsHelp, listRows, parseHosts } from './sni-edit.ts';
  import { sniHosts } from './tls-view.ts';

  let { key, detailHref, pending }: { key: string; detailHref: string; pending: boolean } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  // 고른 키가 바뀌면 ListSplit 이 {#key} 로 다시 만든다 — 처음 값은 마운트할 때 읽는다.
  // svelte-ignore state_referenced_locally
  const item0 = itemOf(desk.model, 'sniBinding', key);
  const hosts0 = item0 === undefined ? '' : sniHosts(item0).join('\n');
  const cert0 = String(item0?.['certificate'] ?? '');
  let hosts = $state(hosts0);
  let cert = $state<string | undefined>(cert0 === '' ? undefined : cert0);
  const certs = $derived(boundCerts(desk, cert0));
  const err = $derived(hostsError(hosts));
  const dirty = $derived(parseHosts(hosts).join('\n') !== parseHosts(hosts0).join('\n') || (cert ?? '') !== cert0);
  let saving = $state(false);

  const save = (): void => {
    const item = itemOf(desk.model, 'sniBinding', key);
    if (item === undefined || cert === undefined) return;
    const { key: _k, ...rest } = item;
    saving = true;
    void desk.putResource('sniBinding', key, { ...rest, hosts: parseHosts(hosts), certificate: cert })
      .then((ok) => { saving = false; after()(ok); });
  };
</script>

<InlineEdit {dirty} invalid={err !== undefined} {pending} {saving} {detailHref} onsave={save} onrevert={() => { hosts = hosts0; cert = cert0 === '' ? undefined : cert0; }}>
  <FormSection title="기본">
    <FormRow label="호스트 목록" for="si-hosts" error={err} help={hostsHelp(hosts)}>
      <TextArea id="si-hosts" bind:value={hosts} invalid={err !== undefined} rows={listRows(hosts)} wrap="off" style="resize: none; white-space: pre" />
    </FormRow>
    <FormRow label="인증서">
      <Select label="인증서" bind:value={cert} options={certs} width="100%" />
    </FormRow>
  </FormSection>
</InlineEdit>
