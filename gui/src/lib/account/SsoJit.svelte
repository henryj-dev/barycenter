<script lang="ts">
  /**
   * SSO 공급자 설정.
   *   · JIT — **기본 꺼짐**(공통 정책). 켜면 연결 없는 SSO 사용자가 처음 올 때 auditor 계정이 새로 생긴다.
   *   · 역할 클레임·매핑 — 권한 정본을 IdP 로 둔 계정만 쓴다(B3). SSO 로그인 때마다 이 매핑으로 역할을 맞춘다.
   *     IdP 쪽 변경은 **다음 SSO 로그인까지 반영되지 않는다**(받아들인 지연). 매핑에 없는 값은 로그인 거부.
   */
  import { onMount } from 'svelte';
  import { Button, Card, FieldMessage, Form, FormRow, FormSection, Switch, TextArea, TextInput } from '#lib/ui';
  import { accountApi, type SsoProviders } from './api';

  let data = $state<SsoProviders | undefined>();
  let error = $state<string | undefined>();
  let claim = $state('');
  /** 한 줄에 하나: `IdP 값 = 역할` */
  let mapText = $state('');
  let saved = $state(false);
  let busy = $state(false);

  const current = $derived(data?.providers.find((p) => p.issuer === data?.configured));
  const jitOn = $derived(current?.jitEnabled === true);

  const load = async (): Promise<void> => {
    const r = await accountApi.ssoProviders();
    if (!r.ok) { error = r.message; return; }
    data = r.data;
    const p = r.data.providers.find((x) => x.issuer === r.data.configured);
    claim = p?.roleClaim ?? '';
    mapText = Object.entries(p?.roleMap ?? {}).map(([k, v]) => `${k} = ${v}`).join('\n');
  };
  onMount(() => { void load(); });

  const toggle = async (on: boolean): Promise<void> => {
    if (data?.configured == null) return;
    const r = await accountApi.setJit(data.configured, on);
    error = r.ok ? undefined : r.message;
    await load();
  };
  const saveRoles = async (): Promise<void> => {
    if (data?.configured == null) return;
    const map: Record<string, string> = {};
    for (const line of mapText.split('\n')) {
      const at = line.indexOf('=');
      if (at <= 0) continue;
      map[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    busy = true;
    const r = await accountApi.setRoles(data.configured, claim.trim() === '' ? null : claim.trim(), map);
    busy = false;
    error = r.ok ? undefined : r.message;
    saved = r.ok;
    await load();
  };
</script>

{#if data?.configured != null}
  <Card title="SSO 공급자" sub={data.configured}>
    <Form onsubmit={() => { void saveRoles(); }}>
      <FormSection title="자동 계정 (JIT)">
        <FormRow label="JIT" help={jitOn ? '연결 없는 SSO 사용자가 처음 오면 auditor 계정을 만들어요.' : '연결 없는 SSO 로그인은 거절해요. 기본은 꺼짐이에요.'}>
          <Switch checked={jitOn} onchange={(v) => { void toggle(v); }}>{jitOn ? '켜짐' : '꺼짐'}</Switch>
        </FormRow>
      </FormSection>
      <FormSection title="역할" hint="권한 정본을 IdP 로 둔 사람만">
        <FormRow label="역할 클레임" for="sso-claim" help="예: roles. IdP 쪽 역할 변경은 그 사람의 다음 SSO 로그인에 반영돼요.">
          <TextInput id="sso-claim" bind:value={claim} placeholder="roles" width="240px" />
        </FormRow>
        <FormRow label="매핑" for="sso-map" help="한 줄에 하나씩 「IdP 값 = auditor|operator|admin」 으로 넣어요. 매핑에 없는 값은 로그인을 거절해요.">
          <TextArea id="sso-map" bind:value={mapText} rows={4} placeholder={'viewer = auditor\nops = operator'} />
        </FormRow>
      </FormSection>
      {#snippet actions()}
        <Button variant="primary" type="submit" loading={busy}>저장</Button>
        {#if saved}<FieldMessage tone="ok">저장했어요.</FieldMessage>{/if}
        {#if error !== undefined}<FieldMessage tone="error">{error}</FieldMessage>{/if}
      {/snippet}
    </Form>
  </Card>
{/if}
