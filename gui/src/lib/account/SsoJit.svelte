<script lang="ts">
  /**
   * SSO 공급자 설정.
   *   · JIT — **기본 꺼짐**(공통 정책). 켜면 연결 없는 SSO 사용자가 처음 올 때 계정이 새로 생긴다(auditor — 공급자 기본 IdP
   *     정본이면 매핑 결과 역할).
   *   · 권한 매핑 — IdP 정본인 사람만 쓴다. 역할 클레임 · 매핑으로 역할을, entitlement 클레임 · 접두 · 표로 범위 더하기(grant)와
   *     빼기(deny)를 정한다. **deny 가 이긴다.** 매핑에 있는 역할 값이 없거나 표에 없는 접두 entitlement 가 오면 로그인 거부.
   *     SSO 로그인마다 맞추고, Role Change(서명된 SET push)를 받으면 그때 바로 맞춘다.
   *   · 공급자 기본 IdP 정본 — 켜면 이 공급자와 이어진 사람은 **모두** IdP 정본이다(사람마다 고르지 않아도). 매핑을 먼저 저장한다.
   *
   * 시안: 공급자 목록과 공급자마다 JIT 토글. 목록은 지금 설정된 공급자와 서버가 기억하는 공급자를 합친 것이다.
   * 매핑은 지금 설정된 공급자만 고친다(로그인이 그 공급자로만 온다). 「프로필로 채우기」 는 입력 칸만 채운다 — 저장해야 바뀐다.
   */
  import { onMount } from 'svelte';
  import { Badge, Button, Card, FieldMessage, Form, FormRow, FormSection, Select, Switch, TextArea, TextInput } from '#lib/ui';
  import { accountApi, type RoleProfile, type SsoProviders } from './api';

  let data = $state<SsoProviders | undefined>();
  let error = $state<string | undefined>();
  let claim = $state('');
  /** 한 줄에 하나: `IdP 값 = 역할` */
  let mapText = $state('');
  let entClaim = $state('');
  let entPrefix = $state('');
  /** 한 줄에 하나: `접두 뒤 이름 = grant:범위 | deny:범위` */
  let entText = $state('');
  let profile = $state('lodestar');
  let saved = $state(false);
  let busy = $state(false);

  const current = $derived(data?.providers.find((p) => p.issuer === data?.configured));
  const profiles = $derived<RoleProfile[]>(data?.profiles ?? []);
  /** 줄마다 공급자 하나 — 설정된 공급자를 맨 앞에. 아직 한 번도 안 온 설정 공급자는 JIT 꺼짐으로 보인다. */
  const rows = $derived.by(() => {
    if (data === undefined) return [];
    const known = data.providers.map((p) => ({ issuer: p.issuer, jit: p.jitEnabled }));
    const conf = data.configured;
    const head = conf === null ? [] : [{ issuer: conf, jit: current?.jitEnabled === true }];
    return [...head, ...known.filter((p) => p.issuer !== conf)];
  });
  let toggling = $state<string | undefined>();

  const lines = (m: Record<string, string> | undefined): string => Object.entries(m ?? {}).map(([k, v]) => `${k} = ${v}`).join('\n');
  const parse = (text: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const at = line.indexOf('=');
      if (at <= 0) continue;
      out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    return out;
  };

  const load = async (): Promise<void> => {
    const r = await accountApi.ssoProviders();
    if (!r.ok) { error = r.message; return; }
    data = r.data;
    const p = r.data.providers.find((x) => x.issuer === r.data.configured);
    claim = p?.roleClaim ?? '';
    mapText = lines(p?.roleMap);
    entClaim = p?.entitlementClaim ?? '';
    entPrefix = p?.entitlementPrefix ?? '';
    entText = lines(p?.entitlementMap);
  };
  onMount(() => { void load(); });

  const toggle = async (issuer: string, on: boolean): Promise<void> => {
    toggling = issuer;
    const r = await accountApi.setJit(issuer, on);
    toggling = undefined;
    error = r.ok ? undefined : r.message;
    await load();
  };
  const setAuthority = async (on: boolean): Promise<void> => {
    if (data?.configured == null) return;
    toggling = data.configured;
    const r = await accountApi.setIdpAuthority(data.configured, on);
    toggling = undefined;
    error = r.ok ? undefined : r.message;
    await load();
  };
  /** 입력 칸만 채운다. 역할 매핑은 비어 있을 때만 권하는 값으로 — 만든 매핑을 덮지 않는다. */
  const fill = (): void => {
    const p = profiles.find((x) => x.name === profile);
    if (p === undefined) return;
    claim = p.roleClaim ?? '';
    entClaim = p.entitlementClaim ?? '';
    entPrefix = p.entitlementPrefix;
    entText = lines(p.entitlementMap);
    if (mapText.trim() === '') mapText = lines(p.roleMap);
    saved = false;
  };
  const save = async (): Promise<void> => {
    if (data?.configured == null) return;
    busy = true;
    const r = await accountApi.setMapping(data.configured, {
      roleClaim: claim.trim() === '' ? null : claim.trim(), roleMap: parse(mapText),
      entitlementClaim: entClaim.trim() === '' ? null : entClaim.trim(), entitlementPrefix: entPrefix.trim(), entitlementMap: parse(entText),
    });
    busy = false;
    error = r.ok ? undefined : r.message;
    saved = r.ok;
    await load();
  };
</script>

{#if rows.length > 0}
  <!-- 시안(People · SSO 공급자): 머리 줄 아래 공급자마다 한 줄(이름 | JIT 스위치). 「설정됨 · 지난 공급자」 배지는 시안에 없는 정보다. -->
  <Card title="SSO 공급자" sub="JIT를 켜면 처음 로그인할 때 계정을 자동으로 만들어요." padded={false}>
    <ul class="prov" aria-label="SSO 공급자">
      {#each rows as p (p.issuer)}
        <li>
          <span class="iss">{p.issuer}{#if p.issuer === data?.configured} <Badge tone="accent" icon={null}>설정됨</Badge>{:else} <Badge tone="neutral" icon={null}>지난 공급자</Badge>{/if}</span>
          <Switch checked={p.jit} disabled={toggling !== undefined} onchange={(v) => { void toggle(p.issuer, v); }}>처음 로그인하면 계정을 자동으로 만들기 · {p.jit ? '켜짐' : '꺼짐'}</Switch>
        </li>
      {/each}
    </ul>
    {#if data?.configured == null && error !== undefined}<div class="err"><FieldMessage tone="error">{error}</FieldMessage></div>{/if}
    {#if data?.configured != null}
      <div class="roles">
        <div class="auth">
          <Switch checked={current?.idpAuthority === true} disabled={toggling !== undefined} onchange={(v) => { void setAuthority(v); }}>
            이 공급자의 SSO 사용자는 모두 IdP 가 권한을 정해요 · {current?.idpAuthority === true ? '켜짐' : '꺼짐'}
          </Switch>
          <FieldMessage>켜면 이 공급자와 이어진 사람의 역할을 손으로 못 바꿔요. 다음 SSO 로그인이나 IdP 의 역할 변경 알림에 맞춰요. 마지막 관리자 · 관리자 인증 앱 조건은 그대로예요. 아래 매핑을 먼저 저장해요.</FieldMessage>
        </div>
        <Form onsubmit={() => { void save(); }}>
          <FormSection title="권한 매핑" hint="{data.configured} · IdP 가 권한을 정하는 사람만">
            {#if profiles.length > 0}
              <FormRow label="프로필" for="sso-profile" help="IdP 마다 클레임 자리가 달라요. 고르고 「채우기」 를 누르면 아래 칸을 채워요. 저장해야 바뀌어요.">
                <div class="fill">
                  <Select label="프로필" bind:value={profile} options={profiles.map((p) => ({ value: p.name, label: p.name }))} width="160px" mono={false} />
                  <Button size="sm" onclick={fill}>채우기</Button>
                </div>
              </FormRow>
            {/if}
            <FormRow label="역할 클레임" for="sso-claim" help="예: roles. 점으로 안쪽을 가리켜요(realm_access.roles). 값이 여럿이면 매핑에 있는 것 중 가장 높은 역할이에요.">
              <TextInput id="sso-claim" bind:value={claim} placeholder="roles" width="240px" />
            </FormRow>
            <FormRow label="역할 매핑" for="sso-map" help="한 줄에 하나씩 「IdP 값 = auditor|operator|admin」 으로 넣어요. 매핑에 있는 값이 하나도 없으면 로그인을 거절해요.">
              <TextArea id="sso-map" bind:value={mapText} rows={4} placeholder={'barycenter-auditors = auditor\nbarycenter-operators = operator'} />
            </FormRow>
            <FormRow label="entitlement 클레임" for="sso-ent" help="비우면 읽지 않아요(역할만). lodestar 는 entitlements 예요 — groups 는 조직 소속이라 권한에 쓰지 않아요.">
              <TextInput id="sso-ent" bind:value={entClaim} placeholder="entitlements" width="240px" />
            </FormRow>
            <FormRow label="접두" for="sso-prefix" help="이 접두가 붙은 entitlement 만 봐요(다른 앱의 것은 무시). entitlement 를 읽으면 비울 수 없어요.">
              <TextInput id="sso-prefix" bind:value={entPrefix} placeholder="barycenter." width="240px" />
            </FormRow>
            <FormRow label="entitlement 표" for="sso-entmap" help="한 줄에 하나씩 「접두 뒤 이름 = grant:범위 | deny:범위」. 범위는 read · write · apply · admin. 빼기(deny)가 더하기(grant)를 이겨요. 접두가 붙었는데 표에 없으면 로그인을 거절해요.">
              <TextArea id="sso-entmap" bind:value={entText} rows={6} placeholder={'apply = grant:apply\nno_apply = deny:apply\nno_write = deny:write'} />
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
  /* 시안: 1.4fr 2fr · 높이 --row-h · 위 테두리 */
  .prov li { display: grid; grid-template-columns: 1.4fr 2fr; gap: 12px; padding: 0 16px; min-height: var(--row-h); align-items: center; font-size: 13px; }
  .prov li + li { border-top: 1px solid var(--bd); }
  .iss { font-weight: 500; color: var(--tx); overflow-wrap: anywhere; }
  .prov :global(.sw) { width: fit-content; }
  .roles { padding: 16px 20px; border-top: 1px solid var(--bd); display: flex; flex-direction: column; gap: 16px; }
  .auth { display: flex; flex-direction: column; gap: 4px; }
  .auth :global(.sw) { width: fit-content; }
  .fill { display: flex; gap: 8px; align-items: center; }
  .err { padding: 0 16px 12px; }
</style>
