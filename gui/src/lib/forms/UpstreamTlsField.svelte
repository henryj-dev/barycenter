<script lang="ts">
  /**
   * 풀의 「백엔드로 가는 TLS」 칸 (§4.3 · 2026-10-31). 만들기 폼과 설정 탭이 같이 쓴다.
   * 규칙(UDP 불가 · 검증은 CA 가 있어야)은 `@web/upstream-tls` 한 자리에 있다.
   */
  import { getContext } from 'svelte';
  import { FormRow, FormSection, Select, Switch, TextInput } from '#lib/ui';
  import { caBundleChoices, upstreamTlsIssue, type UpstreamTlsForm } from '@web/upstream-tls';
  import type { createDesk } from '#lib/desk.svelte.ts';

  let { value = $bindable(), protocolClass }: { value: UpstreamTlsForm; protocolClass: string } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');

  const NONE = '';
  const certs = $derived(caBundleChoices((desk.model['certificates'] ?? []) as Record<string, unknown>[]));
  const caOptions = $derived([
    { value: NONE, label: '없음' },
    ...certs.map((k) => ({ value: k, label: k })),
    // 지금 고른 값이 목록에 없으면(자료가 아직 없는 인증서) 그대로 보여 준다 — 조용히 바꾸지 않는다.
    ...(value.caBundle !== NONE && !certs.includes(value.caBundle) ? [{ value: value.caBundle, label: value.caBundle, hint: '자료 없음' }] : []),
  ]);
  const issue = $derived(upstreamTlsIssue(protocolClass, value));
  $effect(() => { if (value.caBundle === NONE && value.verify) value.verify = false; });
</script>

<!-- 시안 `fieldsFor('pools')` 「업스트림 TLS」: 업스트림 TLS · SNI · 인증서 검증 · CA 번들 순서. -->
<FormSection title="업스트림 TLS">
  <FormRow label="업스트림 TLS" error={protocolClass === 'udp' && value.on ? issue : undefined}
    help={protocolClass === 'udp' ? 'UDP 풀은 백엔드로 TLS 를 못 써요.' : undefined}>
    <Switch bind:checked={value.on} disabled={protocolClass === 'udp' && !value.on}>{value.on ? '켜짐' : '꺼짐'}</Switch>
  </FormRow>
  {#if value.on}
    <FormRow label="SNI" for="pl-tls-sni">
      <TextInput id="pl-tls-sni" bind:value={value.sni} autocomplete="off" />
    </FormRow>
    <FormRow label="인증서 검증" error={protocolClass !== 'udp' ? issue : undefined}
      help={value.caBundle === NONE ? 'CA 번들을 고르면 켤 수 있어요.' : undefined}>
      <Switch bind:checked={value.verify} disabled={value.caBundle === NONE}>{value.verify ? '켜짐' : '꺼짐'}</Switch>
    </FormRow>
    <FormRow label="CA 번들" help={certs.length === 0 ? '고를 인증서가 없어요. 백엔드 인증서를 검증하려면 TLS › 인증서에 CA 를 먼저 넣어요.' : undefined}>
      <Select label="CA 번들" bind:value={value.caBundle} options={caOptions} width="100%" />
    </FormRow>
  {/if}
</FormSection>
