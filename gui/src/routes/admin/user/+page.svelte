<script lang="ts">
  /**
   * 관리자 — 사람과 초대. 링크는 **만든 순간 한 번만** 보인다(서버에는 해시만 있다). 메일이 꺼져 있으면
   * 링크를 복사해 전한다. 마지막 관리자 보호·관리자 승격의 MFA 조건은 서버가 진다.
   * 삭제는 이름을 똑같이 넣는 확인 대화상자를 거친다(브라우저 대화상자를 쓰지 않는다).
   *
   * 시안의 배치: 머리의 「＋ 초대」 → 인라인 「사람 초대」 폼 · 「사용자 · N」 표(역할 셀렉트 · 상태 · MFA · 행 작업) ·
   * 「초대 · N」(행마다 「다시 보내기」 · 「취소」) · SSO 공급자(공급자마다 JIT). 「마지막 로그인」 은 MFA 까지 끝난
   * 로그인의 시각이다(서버가 세션을 만들 때 적는다).
   * 「다시 보내기」 는 옛 링크를 죽이고 새 링크를 만든다 — 전달은 만들 때와 같다(메일, 아니면 한 번만 보이는 링크).
   * 「토큰」 칸은 그 사람의 살아 있는 개인 API 토큰 수다. 누르면 목록이 열리고 폐기할 수 있다(대신 만들지는 않는다).
   *
   * 시안(People)의 열 순서 · 문구를 따른다: 이름 · 역할 · 상태(● 활성 / ○ 비활성) · MFA · 마지막 로그인 · 「비활성화」.
   * 시안에 없는 열(역할 정본 · 이메일 · 토큰)은 「컬럼」 메뉴에 두고 처음에는 숨긴다. 서버 값 `suspended` 를 「비활성」 이라 부른다.
   */
  import { getContext, onMount } from 'svelte';
  import { ago } from '#lib/detail/facts';
  import { accountApi, linkFor, type InvitationRow, type Role, type UserRow } from '#lib/account/api';
  import type { Session } from '#lib/account/session.svelte.ts';
  import { ROLE_LABEL } from '#lib/account/text';
  import SsoJit from '#lib/account/SsoJit.svelte';
  import UserTokens from '#lib/account/UserTokens.svelte';
  import { usePageActions } from '#lib/shell/page-actions.svelte.ts';
  import { Badge, Banner, Button, Card, ConfirmDialog, DataTable, FieldMessage, Select, TextInput, toast, type Column, type MenuItem } from '#lib/ui';

  const session = getContext<Session>('session');
  /** 시안의 역할 이름은 `ROLE_LABEL`(계정 화면 공통). 서버 값은 옆에 흐리게 둔다. */
  const ROLES: { value: Role; label: string; hint: string }[] = (['auditor', 'operator', 'admin'] as const)
    .map((r) => ({ value: r, label: ROLE_LABEL[r], hint: r }));

  let users = $state<UserRow[]>([]);
  let invites = $state<InvitationRow[]>([]);
  let loading = $state(true);
  let inviteOpen = $state(false);
  let inviteRole = $state<Role>('auditor');
  let inviteEmail = $state('');
  let sending = $state(false);
  let shown = $state<{ label: string; link: string } | undefined>();
  let error = $state<string | undefined>();
  let deleting = $state<UserRow | undefined>();
  let asking = $state(false);
  /** 토큰 목록을 연 사람. 목록을 다시 읽어도 같은 사람을 가리키도록 id 로 둔다. */
  let tokensOf = $state<string | undefined>();
  const tokensUser = $derived(users.find((u) => u.id === tokensOf));

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
  /** 이메일은 비워도 된다(링크를 직접 전한다). 넣었으면 메일 주소 모양이어야 한다. */
  const emailError = $derived(inviteEmail.trim() === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inviteEmail.trim())
    ? undefined : 'name@example.com 형식으로 입력해요.');
  const closeInvite = (): void => { inviteOpen = false; inviteEmail = ''; };
  const invite = async (): Promise<void> => {
    if (emailError !== undefined) return;
    const email = inviteEmail.trim();
    sending = true;
    const r = await accountApi.invite(inviteRole, email);
    sending = false;
    if (!r.ok) { error = r.message; return; }
    shown = {
      label: `${ROLE_LABEL[inviteRole]} 초대 링크 (72시간)${r.data.mailed ? ' — 메일로도 보냈어요' : email !== '' ? ' — 메일은 못 보냈어요. 직접 전해요' : ''}`,
      link: linkFor(r.data.token),
    };
    toast.ok('초대를 만들었어요', email === '' ? '링크를 직접 전해요.' : email);
    closeInvite();
    await load();
  };
  /** 다시 보내기 — 새 링크의 전달은 `invite` 와 같은 모양으로 알린다. */
  const resend = async (i: InvitationRow): Promise<void> => {
    const r = await accountApi.resendInvitation(i.id);
    if (!r.ok) { await act(r); return; }
    const role = ROLE_LABEL[i.role] ?? i.role;
    if (r.data.mailed) {
      shown = undefined;
      toast.ok('초대를 다시 보냈어요', `${i.email ?? ''} — 옛 링크는 이제 못 써요.`);
    } else {
      shown = {
        label: `${role} 초대 새 링크 (72시간)${i.email !== null ? ' — 메일은 못 보냈어요. 직접 전해요' : ''}. 옛 링크는 이제 못 써요`,
        link: linkFor(r.data.token),
      };
      toast.ok('초대 링크를 새로 만들었어요', '링크를 직접 전해요.');
    }
    await act(r);
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
  const setRole = (u: UserRow, role: Role): void => {
    void accountApi.updateUser(u.id, { role }).then(async (r) => {
      if (r.ok) toast.ok(`${u.username}의 역할을 바꿨어요`, ROLE_LABEL[role]);
      await act(r);
    });
  };
  const setStatus = (u: UserRow): void => {
    const next = u.status === 'active' ? 'suspended' : 'active';
    void accountApi.updateUser(u.id, { status: next }).then(async (r) => {
      if (r.ok) toast.ok(`${u.username} ${next === 'active' ? '활성화' : '비활성화'}`, next === 'active' ? '로그인 권한을 열었어요.' : '로그인 권한을 막았어요.');
      await act(r);
    });
  };
  /** 쓰지도 거두지도 않은 초대. 만료된 것도 남긴다 — 「만료」 로 보인다. */
  const openInvites = $derived(invites.filter((i) => i.usedAt === null && i.revokedAt === null));
  const expired = (i: InvitationRow): boolean => new Date(i.expiresAt).getTime() < Date.now();

  const userCols: Column<UserRow>[] = [
    { key: 'username', label: '이름', mono: true, sort: (r) => r.username },
    { key: 'role', label: '역할', width: '170px', hideable: false, sort: (r) => r.role },
    { key: 'status', label: '상태', width: '130px', hideable: false, sort: (r) => r.status },
    { key: 'totp', label: 'MFA', width: '110px', hideable: false, sort: (r) => (r.totp ? 1 : 0) },
    { key: 'login', label: '마지막 로그인', mono: true, muted: true, width: '140px', hideable: false,
      text: (r) => (r.lastLoginAt === null ? '아직 없어요' : ago(r.lastLoginAt) ?? '—'), sort: (r) => r.lastLoginAt ?? '' },
    { key: 'act', label: '', align: 'right', width: '130px', hideable: false },
  ];
  const userMenu = (u: UserRow): MenuItem[] => [
    { label: u.roleAuthority === 'idp' ? '역할 정본을 로컬로' : '역할 정본을 IdP 로', onselect: () => { void accountApi.updateUser(u.id, { roleAuthority: u.roleAuthority === 'idp' ? 'local' : 'idp' }).then(act); } },
    { label: u.status === 'active' ? '비활성화' : '활성화', onselect: () => { setStatus(u); } },
    { label: '세션 끊기', onselect: () => { void accountApi.revokeSessions(u.id).then(act); } },
    { label: `API 토큰 보기 · ${u.tokens}`, onselect: () => { tokensOf = u.id; } },
    { label: '복구 링크 만들기', onselect: () => { void recovery(u); } },
    { label: '삭제…', danger: true, onselect: () => { deleting = u; asking = true; } },
  ];
  const inviteCols: Column<InvitationRow>[] = [
    { key: 'email', label: '이메일', mono: true, text: (r) => r.email ?? '이메일 없음' },
    { key: 'role', label: '역할', width: '110px', hideable: false, text: (r) => ROLE_LABEL[r.role] ?? r.role },
    { key: 'sent', label: '보낸 때', hideable: false, mono: true, muted: true, width: '130px', text: (r) => ago(r.createdAt) ?? '—', sort: (r) => r.createdAt },
    { key: 'state', label: '상태', width: '110px', hideable: false },
    { key: 'act', label: '', align: 'right', width: '180px', hideable: false },
  ];
  usePageActions(() => (session.isAdmin ? head : undefined));
</script>

{#snippet head()}<Button variant="primary" onclick={() => { inviteOpen = true; }}>＋ 초대</Button>{/snippet}

{#snippet userCell(u: UserRow, c: Column<UserRow>)}
  {#if c.key === 'username'}
    <code>{u.username}</code>{#if u.lockedUntil !== null} <Badge tone="warn">잠김</Badge>{/if}
  {:else if c.key === 'role'}
    <!-- IdP 가 정본이면 역할은 SSO 로그인이 맞춘다 — 손으로 못 바꾼다 -->
    <Select label={`${u.username} 역할`} size="sm" value={u.role} options={ROLES} width="140px" mono={false} disabled={u.roleAuthority === 'idp'}
      onchange={(v) => { setRole(u, v); }} />
  {:else if c.key === 'status'}
    {#if u.status === 'active'}<Badge tone="ok" icon="●">활성</Badge>{:else}<Badge tone="neutral" icon="○">비활성</Badge>{/if}
  {:else if c.key === 'login'}
    <span title={u.lastLoginAt === null ? undefined : new Date(u.lastLoginAt).toLocaleString()}>{c.text?.(u) ?? ''}</span>
  {:else if c.key === 'totp'}
    {#if u.totp}<Badge tone="ok" icon="●">켜짐</Badge>{:else}<Badge tone="warn" icon="▲">꺼짐</Badge>{/if}
  {:else if c.key === 'tokens'}
    <Button size="sm" title="{u.username}의 API 토큰 보기" onclick={() => { tokensOf = u.id; }}>{u.tokens}</Button>
  {:else if c.key === 'act'}
    <Button size="xs" onclick={() => { setStatus(u); }}>{u.status === 'active' ? '비활성화' : '활성화'}</Button>
  {:else}{c.text?.(u) ?? ''}{/if}
{/snippet}

{#snippet inviteCell(i: InvitationRow, c: Column<InvitationRow>)}
  {#if c.key === 'state'}
    {#if expired(i)}<Badge tone="neutral" icon="○">만료</Badge>{:else}<Badge tone="info" icon="↻">수락 대기</Badge>{/if}
  {:else if c.key === 'sent'}
    <span title={new Date(i.createdAt).toLocaleString()}>{c.text?.(i) ?? ''}</span>
  {:else if c.key === 'act'}{#if i.kind === 'invite'}<Button size="xs" onclick={() => { void resend(i); }}>다시 보내기</Button> {/if}<Button size="xs" outline="danger" onclick={() => { void accountApi.revokeInvitation(i.id).then(async (r) => { if (r.ok) toast.ok('초대를 취소했어요', i.email ?? ''); await act(r); }); }}>취소</Button>
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

    {#if inviteOpen}
      <!-- 시안: 카드 안 제목 「사람 초대」 · 라벨 150px 격자(이메일 · 역할) · 「초대 보내기」 · 「취소」 -->
      <Card>
        <form class="inv" novalidate onsubmit={(e) => { e.preventDefault(); void invite(); }}>
          <div class="t">사람 초대</div>
          <div class="grid">
            <label for="inv-mail">이메일</label>
            <div>
              <TextInput id="inv-mail" type="email" placeholder="name@example.com" bind:value={inviteEmail} invalid={emailError !== undefined} autocomplete="off" />
              {#if emailError !== undefined}<FieldMessage tone="error">{emailError}</FieldMessage>{:else}<FieldMessage>비우면 링크만 만들어요. 직접 전해요. 링크는 72시간 동안 써요. 만든 순간 한 번만 보여요.</FieldMessage>{/if}
            </div>
            <span class="lbl" aria-hidden="true">역할</span>
            <Select label="역할" bind:value={inviteRole} options={ROLES} width="160px" mono={false} />
          </div>
          <div class="acts">
            <Button variant="primary" type="submit" loading={sending} disabled={emailError !== undefined}>초대 보내기</Button>
            <Button onclick={closeInvite}>취소</Button>
          </div>
        </form>
      </Card>
    {/if}

    <Card title="사용자 · {users.length}" padded={false}>
      <!-- 시안 사람 화면의 표는 도구 줄(찾기 · 칩 · 컬럼)이 없다. -->
      <DataTable rows={users} rowKey={(r) => r.id} columns={userCols} cell={userCell} {loading} label="사용자"
        rowMenu={userMenu} emptyTitle="사람이 없어요" minHeight="0" />
    </Card>

    {#if tokensUser !== undefined}
      <UserTokens user={tokensUser} onclose={() => { tokensOf = undefined; }} onchanged={load} />
    {/if}

    <Card title="초대 · {openInvites.length}" padded={false}>
      <DataTable rows={openInvites} rowKey={(r) => r.id} columns={inviteCols} cell={inviteCell} {loading} label="열린 초대"
        emptyTitle="대기 중인 초대가 없어요." minHeight="0" />
    </Card>

    <SsoJit />
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
  .inv { display: flex; flex-direction: column; gap: 12px; }
  .t { font-weight: 600; font-size: 14px; }
  .grid { display: grid; grid-template-columns: 150px minmax(0, 360px); gap: 4px 16px; align-items: start; }
  .grid label, .grid .lbl { padding-top: 6px; font-size: 13px; color: var(--tx2); }
  .acts { display: flex; gap: 8px; }
  @media (max-width: 720px) { .grid { grid-template-columns: minmax(0, 1fr); } }
  code { font-family: var(--mono); }
</style>
