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

<FormSection title="백엔드로 가는 TLS" hint="백엔드가 HTTPS · TLS 로 받을 때">
  <FormRow label="TLS" error={protocolClass === 'udp' && value.on ? issue : undefined}
    help={protocolClass === 'udp' ? 'UDP 풀은 백엔드로 TLS 를 못 써요.' : '켜면 nginx 가 백엔드에 TLS 로 붙어요. HTTP 풀은 proxy_pass https:// 가 돼요.'}>
    <Switch bind:checked={value.on} disabled={protocolClass === 'udp' && !value.on}>켜짐</Switch>
  </FormRow>
  {#if value.on}
    <FormRow label="SNI" for="pl-tls-sni" help="백엔드에 보낼 서버 이름이에요. 비우면 백엔드 주소를 써요.">
      <TextInput id="pl-tls-sni" bind:value={value.sni} autocomplete="off" placeholder="backend.example.com" />
    </FormRow>
    <FormRow label="신뢰할 CA" help={certs.length === 0 ? '고를 인증서가 없어요. 백엔드 인증서를 검증하려면 TLS › 인증서에 CA 를 먼저 넣어요.' : '백엔드 인증서를 이 인증서의 fullchain 으로 검증해요.'}>
      <Select label="신뢰할 CA" bind:value={value.caBundle} options={caOptions} width="260px" />
    </FormRow>
    <FormRow label="인증서 검증" error={protocolClass !== 'udp' ? issue : undefined}
      help={value.caBundle === NONE ? '신뢰할 CA 를 고르면 켤 수 있어요. 끄면 자체 서명 인증서도 받아요.' : '켜면 백엔드 인증서가 이 CA 로 서명되지 않았을 때 연결을 끊어요.'}>
      <Switch bind:checked={value.verify} disabled={value.caBundle === NONE}>켜짐</Switch>
    </FormRow>
  {/if}
</FormSection>
