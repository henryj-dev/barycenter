<script lang="ts">
  /**
   * SSO 공급자 설정.
   *   · JIT — **기본 꺼짐**(공통 정책). 켜면 연결 없는 SSO 사용자가 처음 올 때 auditor 계정이 새로 생긴다.
   *   · 역할 클레임·매핑 — 권한 정본을 IdP 로 둔 계정만 쓴다(B3). SSO 로그인 때마다 이 매핑으로 역할을 맞춘다.
   *     IdP 쪽 변경은 **다음 SSO 로그인까지 반영되지 않는다**(받아들인 지연). 매핑에 없는 값은 로그인 거부.
   *
   * 시안: 공급자 목록과 공급자마다 JIT 토글. 목록은 지금 설정된 공급자와 서버가 기억하는 공급자를 합친 것이다.
   * 역할 매핑은 지금 설정된 공급자만 고친다(로그인이 그 공급자로만 온다).
   */
  import { onMount } from 'svelte';
  import { Badge, Button, Card, FieldMessage, Form, FormRow, FormSection, Switch, TextArea, TextInput } from '#lib/ui';
  import { accountApi, type SsoProviders } from './api';

  let data = $state<SsoProviders | undefined>();
  let error = $state<string | undefined>();
  let claim = $state('');
  /** 한 줄에 하나: `IdP 값 = 역할` */
  let mapText = $state('');
  let saved = $state(false);
  let busy = $state(false);

  const current = $derived(data?.providers.find((p) => p.issuer === data?.configured));
  /** 줄마다 공급자 하나 — 설정된 공급자를 맨 앞에. 아직 한 번도 안 온 설정 공급자는 JIT 꺼짐으로 보인다. */
  const rows = $derived.by(() => {
    if (data === undefined) return [];
    const known = data.providers.map((p) => ({ issuer: p.issuer, jit: p.jitEnabled }));
    const conf = data.configured;
    const head = conf === null ? [] : [{ issuer: conf, jit: current?.jitEnabled === true }];
    return [...head, ...known.filter((p) => p.issuer !== conf)];
  });
  let toggling = $state<string | undefined>();

  const load = async (): Promise<void> => {
    const r = await accountApi.ssoProviders();
    if (!r.ok) { error = r.message; return; }
    data = r.data;
    const p = r.data.providers.find((x) => x.issuer === r.data.configured);
    claim = p?.roleClaim ?? '';
    mapText = Object.entries(p?.roleMap ?? {}).map(([k, v]) => `${k} = ${v}`).join('\n');
  };
  onMount(() => { void load(); });

  const toggle = async (issuer: string, on: boolean): Promise<void> => {
    toggling = issuer;
    const r = await accountApi.setJit(issuer, on);
    toggling = undefined;
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

{#if rows.length > 0}
  <Card title="SSO 공급자" sub="JIT 를 켜면 처음 로그인할 때 계정을 자동으로 만들어요. 기본은 꺼짐이고, 만든 계정은 auditor 예요.">
    <ul class="prov" aria-label="SSO 공급자">
      {#each rows as p (p.issuer)}
        <li>
          <span class="iss">{p.issuer}</span>
          {#if p.issuer === data?.configured}<Badge tone="accent" icon={null}>설정됨</Badge>{:else}<Badge tone="neutral" icon={null}>지난 공급자</Badge>{/if}
          <span class="grow"></span>
          <Switch checked={p.jit} disabled={toggling !== undefined} onchange={(v) => { void toggle(p.issuer, v); }}>처음 로그인하면 계정을 자동으로 만들기 · {p.jit ? '켜짐' : '꺼짐'}</Switch>
        </li>
      {/each}
    </ul>
    {#if data?.configured == null && error !== undefined}<FieldMessage tone="error">{error}</FieldMessage>{/if}
    {#if data?.configured != null}
      <div class="roles">
        <Form onsubmit={() => { void saveRoles(); }}>
          <FormSection title="역할" hint="{data.configured} · 권한 정본을 IdP 로 둔 사람만">
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
      </div>
    {/if}
  </Card>
{/if}

<style>
  .prov { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
  .prov li { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 8px 0; border-bottom: 1px solid var(--bd); }
  .prov li:last-child { border-bottom: 0; }
  .iss { font-family: var(--mono); color: var(--tx); overflow-wrap: anywhere; }
  .grow { flex: 1; }
  .roles { margin-top: 16px; }
</style>
