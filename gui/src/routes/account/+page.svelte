<script lang="ts">
  /** 내 계정 — 누구인가 · 비밀번호 · 이메일 · 인증 앱 · SSO 연결 · 열린 세션. */
  import { getContext, onMount } from 'svelte';
  import { accountApi, type Me } from '#lib/account/api';
  import type { Session } from '#lib/account/session.svelte.ts';
  import ChangePassword from '#lib/account/ChangePassword.svelte';
  import TotpManage from '#lib/account/TotpManage.svelte';
  import ChangeEmail from '#lib/account/ChangeEmail.svelte';
  import SsoIdentities from '#lib/account/SsoIdentities.svelte';
  import { Badge, Button, Card, DataTable, DescriptionList, FieldMessage, Skeleton, type Column } from '#lib/ui';

  type Sess = Me['sessions'][number];
  const session = getContext<Session>('session');
  let note = $state<{ ok: boolean; text: string } | undefined>();
  let mailOn = $state(false);
  let ssoOn = $state(false);

  onMount(async () => {
    void session.refresh();
    const f = await accountApi.features();
    mailOn = f.ok && f.data.mail;
    ssoOn = f.ok && f.data.sso;
  });

  const logoutAll = async (): Promise<void> => {
    const r = await accountApi.logoutAll();
    note = r.ok ? { ok: true, text: `세션 ${r.data.revoked}개를 끊었어요. 이 기기도 다시 로그인해요.` } : { ok: false, text: r.message };
    await session.refresh();
  };
  const columns: Column<Sess>[] = [
    { key: 'last', label: '마지막 사용', mono: true, width: '200px', text: (r) => new Date(r.lastSeenAt).toLocaleString(), sort: (r) => r.lastSeenAt },
    { key: 'methods', label: '인증', mono: true, text: (r) => r.methods.join(' + ') },
    { key: 'ip', label: 'IP', mono: true, text: (r) => r.ip ?? '?' },
    { key: 'ua', label: '브라우저', muted: true, hideable: true, text: (r) => r.userAgent ?? '' },
  ];
</script>

{#if session.me === undefined}
  {#if session.checked}
    <Card title="사람 계정으로 로그인하지 않았어요">
      <FieldMessage>토큰으로 연결했으면 계정 화면이 없어요.</FieldMessage>
      <div class="pad"><Button variant="primary" href="/login">로그인</Button></div>
    </Card>
  {:else}
    <Skeleton height="120px" label="확인하는 중" />
  {/if}
{:else}
  {@const me = session.me}
  <div class="acct">
    <Card title={me.username}>
      {#snippet actions()}<Badge tone="accent" icon={null}>{me.role}</Badge>{/snippet}
      <DescriptionList items={[
        { label: '이름', value: me.displayName ?? '—' },
        { label: '이메일', value: me.email ?? '—', mono: true },
        { label: '역할 정본', value: me.roleAuthority === 'idp' ? 'IdP — SSO 로그인이 역할을 맞춰요' : '로컬' },
      ]} />
    </Card>
    {#if me.hasPassword}<ChangePassword />{/if}
    {#if mailOn}<ChangeEmail />{/if}
    <TotpManage {me} onChanged={session.refresh} />
    {#if ssoOn}<SsoIdentities {me} onChanged={session.refresh} />{/if}
    <Card title="열린 세션" sub={`${me.sessions.length}개`} padded={false}>
      {#snippet actions()}<Button size="sm" variant="danger" onclick={() => { void logoutAll(); }}>모든 기기에서 로그아웃</Button>{/snippet}
      <DataTable rows={me.sessions} rowKey={(r) => r.createdAt + r.lastSeenAt} {columns} label="열린 세션" emptyTitle="열린 세션이 없어요" minHeight="0" />
    </Card>
    {#if note !== undefined}<FieldMessage tone={note.ok ? 'ok' : 'error'}>{note.text}</FieldMessage>{/if}
  </div>
{/if}

<style>
  .acct { display: flex; flex-direction: column; gap: 16px; max-width: 860px; }
  .pad { margin-top: 12px; }
</style>
