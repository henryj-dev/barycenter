<script lang="ts">
  /**
   * 인증서 분할 인라인 수정 — 콘솔 시안 `INL.certs`: 구획 「기본」 의 도메인 · 자동 갱신.
   *
   * 실제 모델과 다른 점(사실을 지킨다):
   *   · 도메인은 **ACME 인증서만** 고친다(ACME 의도의 도메인). 업로드 인증서의 도메인은 자료(SAN)에서 오므로 잠근다.
   *   · 자동 갱신은 고르는 칸이 모델에 없다. ACME 인증서는 늘 스케줄러가 갱신하므로 켜짐으로 잠그고, 업로드는 꺼짐이다.
   * 저장은 head 의 자료 참조를 그대로 실어 ACME 의도만 바꾼다(`certBody`). 커밋 뒤 목록에 머문다.
   */
  import { getContext } from 'svelte';
  import { itemOf } from '@web/resources';
  import { FormRow, FormSection, Switch, TextInput } from '#lib/ui';
  import InlineEdit from '#lib/detail/InlineEdit.svelte';
  import { after } from '#lib/after';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { certBody, domainsError, parseDomains } from './cert-edit.ts';

  let { key, detailHref, pending }: { key: string; detailHref: string; pending: boolean } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  // 고른 키가 바뀌면 ListSplit 이 {#key} 로 다시 만든다 — 처음 값은 마운트할 때 읽는다.
  // svelte-ignore state_referenced_locally
  const item0 = itemOf(desk.model, 'certificate', key);
  const acme0 = item0?.['acme'] as { account?: string; domains?: string[] } | undefined;
  // svelte-ignore state_referenced_locally
  const row0 = desk.certs.rows.find((r) => r.key === key);
  const initial = (acme0?.domains ?? row0?.domains ?? []).join(', ');
  let domains = $state(initial);
  const isAcme = acme0 !== undefined;
  const err = $derived(isAcme ? domainsError(domains) : undefined);
  const dirty = $derived(isAcme && parseDomains(domains).join(',') !== parseDomains(initial).join(','));
  let saving = $state(false);

  const save = (): void => {
    const item = itemOf(desk.model, 'certificate', key);
    if (item === undefined || acme0?.account === undefined) return;
    saving = true;
    void desk.putResource('certificate', key, certBody(item, { account: acme0.account, domains: parseDomains(domains) }))
      .then((ok) => { saving = false; after()(ok); });
  };
</script>

<InlineEdit {dirty} invalid={err !== undefined} {pending} {saving} {detailHref} onsave={save} onrevert={() => { domains = initial; }}>
  <FormSection title="기본">
    <FormRow label="도메인" for="ci-domains" error={err} help={isAcme ? '쉼표로 구분해요.' : '업로드한 자료의 이름이에요. 바꾸려면 자료를 교체해요.'}>
      <TextInput id="ci-domains" bind:value={domains} invalid={err !== undefined} disabled={!isAcme} autocomplete="off" />
    </FormRow>
    <FormRow label="자동 갱신" help={isAcme ? '만료 전에 스케줄러가 다시 받아요. 끌 수 없어요.' : undefined}>
      <Switch checked={isAcme} disabled>{isAcme ? '켜짐' : '꺼짐'}</Switch>
    </FormRow>
  </FormSection>
</InlineEdit>
