<script lang="ts">
  /**
   * 인증서 설정 탭 — 콘솔 시안 `fieldsFor('certs', v, false, 'form')`: 구획 「기본」 의 이름(잠김) · 도메인 · 발급자 ·
   * ACME 계정 · 자동 갱신 · 검증 방식 · (DNS-01 이면) DNS 공급자 「준비 중」.
   *
   * 사람이 고치는 것은 **ACME 의도**(계정 · 도메인)뿐이다. 나머지는 사실을 지켜 잠근다:
   *   · 발급자는 바꿀 수 없다 — ACME ↔ 업로드는 다른 인증서다. 업로드 자료는 머리의 「자료를 교체해요」 가 새로 올린다.
   *   · 업로드 인증서의 도메인은 자료(SAN)에서 온다. 자동 갱신은 모델에 칸이 없다(ACME 는 늘 갱신). 검증 방식은 서버가 고른다.
   *
   * **계정을 바꾸면(CA 바꾸기, 2026-10-31)** 러너가 만료를 기다리지 않고 새 계정으로 다시 받는다. 이름 · 도메인 ·
   * 이 인증서를 쓰는 리스너 · SNI 는 그대로이고, 새 자료가 나올 때까지 옛 자료가 계속 쓰인다.
   * 저장은 head 의 자료 참조를 그대로 실어 ACME 의도만 바꾼다(`certBody` — 모델의 칸만 싣는다).
   */
  import { getContext, untrack } from 'svelte';
  import { page } from '$app/state';
  import { itemOf, resourcePath } from '@web/resources';
  import { FormRow, FormSection, Select, Switch, TextInput } from '#lib/ui';
  import { after } from '#lib/after';
  import AcmeAccountField from '#lib/forms/AcmeAccountField.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { isPendingResource } from '#lib/pending';
  import Resolved from './Resolved.svelte';
  import SettingsFrame from '#lib/detail/SettingsFrame.svelte';
  import { certBody, challengeOf, domainsError, parseDomains } from './cert-edit.ts';
  import { certIssuer } from './tls-view.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = untrack(() => page.params['key'] ?? '');
  const item0 = untrack(() => itemOf(desk.model, 'certificate', key));
  const row0 = untrack(() => desk.certs.rows.find((r) => r.key === key));
  const acme0 = item0?.['acme'] as { account?: string; domains?: string[] } | undefined;
  const isAcme = acme0 !== undefined;
  const domains0 = (acme0?.domains ?? row0?.domains ?? []).join(', ');

  let domains = $state(domains0);
  let account = $state<string | undefined>(acme0?.account);
  let accountReady = $state(true);
  let accountChanged = $state(false);
  let field: { ensure: () => Promise<string | undefined> } | undefined = $state();
  let saving = $state(false);
  /** 「되돌리기」 — 계정 칸은 다시 만들어야 처음 값으로 돌아간다. */
  let gen = $state(0);

  const err = $derived(isAcme ? domainsError(domains) : undefined);
  const dirty = $derived(isAcme && (parseDomains(domains).join(',') !== parseDomains(domains0).join(',') || accountChanged));
  const challenge = $derived(challengeOf(parseDomains(domains)));
  const pending = $derived(isPendingResource(desk.pendingResources, 'certificate', key));
  const issuer = row0 === undefined ? '—' : certIssuer(row0);

  const save = async (): Promise<void> => {
    const item = itemOf(desk.model, 'certificate', key);
    if (item === undefined || !accountReady) return;
    saving = true;
    // 「＋ 새 계정」 이면 계정을 먼저 만든다(바로 걸리는 일). 못 만들면 인증서를 커밋하지 않는다.
    const next = await field?.ensure();
    if (next === undefined) { saving = false; return; }
    const ok = await desk.putResource('certificate', key, certBody(item, { account: next, domains: parseDomains(domains) }));
    saving = false;
    after(resourcePath('certificate', key), next !== acme0?.account ? 'CA 를 바꿨어요' : '커밋했어요')(ok);
  };
  const revert = (): void => { domains = domains0; account = acme0?.account; gen += 1; };
  const view = $derived([{ t: '기본', f: [
    { l: '이름', v: key, mono: true },
    { l: '도메인', v: domains0 || '—', mono: true },
    { l: '발급자', v: issuer },
    ...(isAcme ? [{ l: 'ACME 계정', v: acme0?.account ?? '—' }, { l: '자동 갱신', v: '켜짐' }, { l: '검증 방식', v: challengeOf(parseDomains(domains0)), mono: true }] : []),
  ] }]);
</script>

<SettingsFrame {view} {dirty} invalid={err !== undefined || (isAcme && !accountReady)} {pending} {saving} onsave={() => { void save(); }} onrevert={revert}>
  <FormSection title="기본">
    <FormRow label="이름"><TextInput value={key} disabled /></FormRow>
    <FormRow label="도메인" for="cs-domains" error={err} help={isAcme ? '쉼표로 구분해요.' : '업로드한 자료의 이름이에요. 바꾸려면 자료를 교체해요.'}>
      <TextInput id="cs-domains" bind:value={domains} invalid={err !== undefined} disabled={!isAcme} autocomplete="off" />
    </FormRow>
    <FormRow label="발급자">
      <Select label="발급자" value={isAcme ? 'acme' : 'upload'} options={[{ value: 'acme', label: 'ACME' }, { value: 'upload', label: '업로드' }]} mono={false} width="100%" disabled />
    </FormRow>
    {#if isAcme}
      {#key gen}<AcmeAccountField bind:this={field} bind:account bind:ready={accountReady} bind:changed={accountChanged} />{/key}
      {#if accountChanged}
        <FormRow label="">
          <div class="note">저장하면 스케줄러가 곧 새 주문을 열어요. 이름 · 도메인 · 이 인증서를 쓰는 리스너는 그대로예요. 새 인증서가 나올 때까지 지금 인증서를 계속 써요.</div>
        </FormRow>
      {/if}
      <FormRow label="자동 갱신">
        <Switch checked disabled>켜짐</Switch>
      </FormRow>
      <FormRow label="검증 방식">
        <Select label="검증 방식" value={challenge} options={[{ value: 'HTTP-01' }, { value: 'DNS-01' }]} width="100%" disabled />
      </FormRow>
      {#if challenge === 'DNS-01'}
        <FormRow label="DNS 공급자">
          <Resolved items={[['상태', '준비 중']]} help="DNS-01 공급자 설정은 아직 없어요. 준비 중이에요." />
        </FormRow>
      {/if}
    {/if}
  </FormSection>
</SettingsFrame>

<style>
  .note { font-size: 12px; color: var(--tx3); padding-top: 6px; }
</style>
