<script lang="ts">
  /**
   * 관리자 — 사람과 초대. 링크는 **만든 순간 한 번만** 보인다(서버에는 해시만 있다). 메일이 꺼져 있으면
   * 링크를 복사해 전한다. 마지막 관리자 보호·관리자 승격의 MFA 조건은 서버가 진다.
   * 삭제는 이름을 똑같이 넣는 확인 대화상자를 거친다(브라우저 대화상자를 쓰지 않는다).
   */
  import { getContext, onMount } from 'svelte';
  import { accountApi, linkFor, type InvitationRow, type Role, type UserRow } from '#lib/account/api';
  import type { Session } from '#lib/account/session.svelte.ts';
  import SsoJit from '#lib/account/SsoJit.svelte';
  import { Badge, Banner, Button, Card, ConfirmDialog, DataTable, FieldMessage, Select, TextInput, toast, type Column, type FilterChip, type MenuItem } from '#lib/ui';

  const session = getContext<Session>('session');
  const ROLES: { value: Role }[] = [{ value: 'auditor' }, { value: 'operator' }, { value: 'admin' }];

  let users = $state<UserRow[]>([]);
  let invites = $state<InvitationRow[]>([]);
  let loading = $state(true);
  let inviteRole = $state<Role>('auditor');
  let inviteEmail = $state('');
  let shown = $state<{ label: string; link: string } | undefined>();
  let error = $state<string | undefined>();
  let deleting = $state<UserRow | undefined>();
  let asking = $state(false);

  const load = async (): Promise<void> => {
    const [u, i] = await Promise.all([accountApi.users(), accountApi.invitations()]);
    if (u.ok) users = u.data; else error = u.message;
    if (i.ok) invites = i.data;
    loading = false;
  };
  onMount(() => { void load(); });

  /** 행 단위 조작의 결과를 같은 방식으로 받는다 — 실패면 서버 문장을 보이고, 어느 쪽이든 다시 읽는다. */
  const act = async (r: { ok: boolean; message?: string }): Promise<void> => {
    error = r.ok ? undefined : r.message;
    await load();
  };
  const invite = async (): Promise<void> => {
    const r = await accountApi.invite(inviteRole, inviteEmail);
    if (!r.ok) { error = r.message; return; }
    shown = {
      label: `${inviteRole} 초대 링크 (72시간)${r.data.mailed ? ' — 메일로도 보냈어요' : inviteEmail !== '' ? ' — 메일은 못 보냈어요. 직접 전해요' : ''}`,
      link: linkFor(r.data.token),
    };
    inviteEmail = '';
    await load();
  };
  const recovery = async (u: UserRow): Promise<void> => {
    const r = await accountApi.recoveryLink(u.id);
    if (!r.ok) { error = r.message; return; }
    shown = { label: `${u.username} 복구 링크 (24시간) — 그 사람의 세션은 지금 끊겼어요`, link: linkFor(r.data.token) };
  };
  const copy = async (): Promise<void> => {
    if (shown === undefined) return;
    try { await navigator.clipboard.writeText(shown.link); toast.ok('링크를 복사했어요', '받을 사람에게 직접 전해요.'); } catch { /* 칸을 눌러 직접 복사한다 */ }
  };
  const openInvites = $derived(invites.filter((i) => i.usedAt === null && i.revokedAt === null));

  const userCols: Column<UserRow>[] = [
    { key: 'username', label: '아이디', mono: true, sort: (r) => r.username },
    { key: 'role', label: '역할', width: '170px', sort: (r) => r.role },
    { key: 'authority', label: '역할 정본', width: '110px', text: (r) => (r.roleAuthority === 'idp' ? 'IdP' : '로컬'), sort: (r) => r.roleAuthority },
    { key: 'status', label: '상태', width: '130px', sort: (r) => r.status },
    { key: 'totp', label: 'MFA', width: '90px', sort: (r) => (r.totp ? 1 : 0) },
    { key: 'email', label: '이메일', mono: true, muted: true, hideable: true, text: (r) => r.email ?? '—' },
  ];
  const chips: FilterChip<UserRow>[] = [
    { key: 'admin', label: '관리자', tone: 'accent', icon: '★', match: (r) => r.role === 'admin' },
    { key: 'suspended', label: '정지', tone: 'neutral', match: (r) => r.status === 'suspended' },
    { key: 'locked', label: '잠김', tone: 'warn', match: (r) => r.lockedUntil !== null },
  ];
  const userMenu = (u: UserRow): MenuItem[] => [
    { label: u.roleAuthority === 'idp' ? '역할 정본을 로컬로' : '역할 정본을 IdP 로', onselect: () => { void accountApi.updateUser(u.id, { roleAuthority: u.roleAuthority === 'idp' ? 'local' : 'idp' }).then(act); } },
    { label: u.status === 'active' ? '정지' : '다시 활성', onselect: () => { void accountApi.updateUser(u.id, { status: u.status === 'active' ? 'suspended' : 'active' }).then(act); } },
    { label: '세션 끊기', onselect: () => { void accountApi.revokeSessions(u.id).then(act); } },
    { label: '복구 링크 만들기', onselect: () => { void recovery(u); } },
    { label: '삭제…', danger: true, onselect: () => { deleting = u; asking = true; } },
  ];
  const inviteCols: Column<InvitationRow>[] = [
    { key: 'role', label: '역할', width: '120px', text: (r) => r.role },
    { key: 'email', label: '이메일', mono: true, text: (r) => r.email ?? '이메일 없음' },
    { key: 'exp', label: '만료', muted: true, text: (r) => new Date(r.expiresAt).toLocaleString(), sort: (r) => r.expiresAt },
    { key: 'act', label: '', align: 'right', width: '90px' },
  ];
</script>

{#snippet userCell(u: UserRow, c: Column<UserRow>)}
  {#if c.key === 'username'}
    <code>{u.username}</code>{#if u.lockedUntil !== null} <Badge tone="warn">잠김</Badge>{/if}
  {:else if c.key === 'role'}
    <!-- IdP 가 정본이면 역할은 SSO 로그인이 맞춘다 — 손으로 못 바꾼다 -->
    <Select label={`${u.username} 역할`} value={u.role} options={ROLES} width="140px" disabled={u.roleAuthority === 'idp'}
      onchange={(v) => { void accountApi.updateUser(u.id, { role: v }).then(act); }} />
  {:else if c.key === 'status'}
    {#if u.status === 'active'}<Badge tone="ok">활성</Badge>{:else}<Badge>정지</Badge>{/if}
  {:else if c.key === 'totp'}
    {#if u.totp}<Badge tone="ok" icon={null}>앱</Badge>{:else}—{/if}
  {:else}{c.text?.(u) ?? ''}{/if}
{/snippet}

{#snippet inviteCell(i: InvitationRow, c: Column<InvitationRow>)}
  {#if c.key === 'act'}<Button size="sm" onclick={() => { void accountApi.revokeInvitation(i.id).then(act); }}>취소</Button>
  {:else}{c.text?.(i) ?? ''}{/if}
{/snippet}

{#if !session.isAdmin}
  <FieldMessage>관리자만 봐요.</FieldMessage>
{:else}
  <div class="adm">
    {#if shown !== undefined}
      <Banner tone="warn" ondismiss={() => { shown = undefined; }}>
        {shown.label}. <b>지금 한 번만 보여요.</b>
        {#snippet action()}<Button size="sm" onclick={() => { void copy(); }}>복사</Button>{/snippet}
      </Banner>
      <TextInput value={shown.link} readonly aria-label="한 번만 보이는 링크" onfocus={(e) => (e.currentTarget as HTMLInputElement).select()} />
    {/if}
    {#if error !== undefined}<Banner tone="danger" ondismiss={() => { error = undefined; }}>{error}</Banner>{/if}

    <Card title="초대" sub={`열린 초대 ${openInvites.length}개`}>
      <form class="inv" onsubmit={(e) => { e.preventDefault(); void invite(); }}>
        <Select label="초대할 역할" bind:value={inviteRole} options={ROLES} width="140px" />
        <TextInput type="email" placeholder="이메일 (선택)" aria-label="초대 이메일" bind:value={inviteEmail} width="260px" />
        <Button variant="primary" type="submit">초대 링크 만들기</Button>
      </form>
      {#if openInvites.length > 0}
        <div class="list">
          <DataTable rows={openInvites} rowKey={(r) => r.id} columns={inviteCols} cell={inviteCell} label="열린 초대" minHeight="0" />
        </div>
      {/if}
    </Card>

    <SsoJit />

    <DataTable rows={users} rowKey={(r) => r.id} columns={userCols} cell={userCell} {chips} {loading} label="사람"
      search={{ placeholder: '아이디 · 이메일 검색', match: (r, q) => r.username.includes(q.toLowerCase()) || (r.email ?? '').toLowerCase().includes(q.toLowerCase()) }}
      rowMenu={userMenu} emptyTitle="사람이 없어요" />
  </div>

  <ConfirmDialog
    bind:open={asking}
    title="{deleting?.username ?? ''} 을(를) 삭제해요"
    sub="그 사람의 세션은 모두 끊겨요."
    lines={[{ tone: 'danger', icon: '✕', text: '아이디는 다시 쓸 수 없어요.' }]}
    requireName={deleting?.username} confirmLabel="삭제해요"
    onconfirm={() => { const u = deleting; asking = false; if (u !== undefined) void accountApi.deleteUser(u.id).then(act); }}
  />
{/if}

<style>
  .adm { display: flex; flex-direction: column; gap: 16px; }
  .inv { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .list { margin-top: 12px; }
  code { font-family: var(--mono); }
</style>
