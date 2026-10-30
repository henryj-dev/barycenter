<script lang="ts">
  /**
   * 연결된 SSO 계정. 잇기·끊기 둘 다 **비밀번호를 다시 넣는다**(공통 정책). 이메일·이름이 같다고 저절로
   * 이어지지 않는다. 비밀번호가 없는 계정(SSO 로 생긴 것)은 더 잇거나 끊지 못한다 — 유일한 증거가 IdP 다.
   */
  import { Button, Card, DataTable, FieldMessage, FormRow, FormSection, TextInput, type Column } from '#lib/ui';
  import { accountApi, type Me } from './api';

  type Ident = Me['identities'][number];
  let { me, onChanged }: { me: Me; onChanged: () => Promise<void> } = $props();

  let password = $state('');
  let error = $state<string | undefined>();

  const link = async (): Promise<void> => {
    const r = await accountApi.linkSso(password);
    password = '';
    if (!r.ok) { error = r.message; return; }
    window.location.assign(r.data.url);
  };
  const unlink = async (issuer: string, subject: string): Promise<void> => {
    const r = await accountApi.unlinkSso(issuer, subject, password);
    password = '';
    if (!r.ok) { error = r.message; return; }
    error = undefined;
    await onChanged();
  };
  const columns: Column<Ident>[] = [
    { key: 'issuer', label: '공급자', mono: true, text: (r) => r.issuer },
    { key: 'subject', label: '주체', mono: true, text: (r) => r.subject },
    { key: 'last', label: '마지막 로그인', muted: true, text: (r) => (r.lastLoginAt === null ? '—' : new Date(r.lastLoginAt).toLocaleString()) },
    { key: 'act', label: '', align: 'right', width: '90px' },
  ];
</script>

{#snippet cell(r: Ident, c: Column<Ident>)}
  {#if c.key === 'act'}
    {#if me.hasPassword}<Button size="sm" disabled={password === ''} title="비밀번호를 먼저 넣어요" onclick={() => { void unlink(r.issuer, r.subject); }}>끊기</Button>{/if}
  {:else}{c.text?.(r) ?? ''}{/if}
{/snippet}

<Card title="SSO 연결">
  <div class="sso">
    <DataTable rows={me.identities} rowKey={(r) => r.issuer + r.subject} {columns} {cell} label="연결된 SSO 계정" emptyTitle="연결된 SSO 계정이 없어요" minHeight="0" />
    {#if me.hasPassword}
      <FormSection>
        <FormRow label="비밀번호 확인" for="sso-pass" help="잇거나 끊으려면 비밀번호를 다시 넣어요.">
          <TextInput id="sso-pass" type="password" autocomplete="current-password" mono={false} bind:value={password} />
        </FormRow>
      </FormSection>
      <div><Button disabled={password === ''} onclick={() => { void link(); }}>SSO 계정 잇기 ↗</Button></div>
    {:else}
      <FieldMessage>SSO 로 만든 계정이라 비밀번호가 없어요. 연결을 바꾸려면 관리자에게 부탁해요.</FieldMessage>
    {/if}
    {#if error !== undefined}<FieldMessage tone="error">{error}</FieldMessage>{/if}
  </div>
</Card>

<style>
  .sso { display: grid; gap: 12px; }
</style>
