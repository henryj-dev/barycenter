<script lang="ts">
  /**
   * 관리자 — 사람과 초대. 링크는 **만든 순간 한 번만** 보인다(서버에는 해시만 있다). 메일 발송은 B 단계라
   * 지금은 링크를 복사해 전한다. 마지막 관리자 보호·관리자 승격의 MFA 조건은 서버가 진다.
   */
  import { getContext, onMount } from 'svelte';
  import { accountApi, linkFor, type InvitationRow, type Role, type UserRow } from '$lib/account/api';
  import type { Session } from '$lib/account/session.svelte.ts';

  const session = getContext<Session>('session');
  const ROLES: Role[] = ['auditor', 'operator', 'admin'];

  let users = $state<UserRow[]>([]);
  let invites = $state<InvitationRow[]>([]);
  let inviteRole = $state<Role>('auditor');
  let inviteEmail = $state('');
  let shown = $state<{ label: string; link: string } | undefined>();
  let error = $state<string | undefined>();

  const load = async (): Promise<void> => {
    const [u, i] = await Promise.all([accountApi.users(), accountApi.invitations()]);
    if (u.ok) users = u.data; else error = u.message;
    if (i.ok) invites = i.data;
  };
  onMount(() => { void load(); });

  /** 행 단위 조작의 결과를 같은 방식으로 받는다 — 실패면 서버 문장을 보이고, 어느 쪽이든 다시 읽는다. */
  const act = async (r: { ok: boolean; message?: string }): Promise<void> => {
    error = r.ok ? undefined : r.message;
    await load();
  };
  const remove = async (u: UserRow): Promise<void> => {
    if (!confirm(`${u.username} 을(를) 삭제한다. 아이디는 다시 쓸 수 없다.`)) return;
    await act(await accountApi.deleteUser(u.id));
  };
  const invite = async (): Promise<void> => {
    const r = await accountApi.invite(inviteRole, inviteEmail);
    if (!r.ok) { error = r.message; return; }
    shown = { label: `${inviteRole} 초대 링크 (72시간)`, link: linkFor(r.data.token) };
    inviteEmail = '';
    await load();
  };
  const recovery = async (u: UserRow): Promise<void> => {
    const r = await accountApi.recoveryLink(u.id);
    if (!r.ok) { error = r.message; return; }
    shown = { label: `${u.username} 복구 링크 (24시간) — 그 사람의 세션은 지금 끊겼다`, link: linkFor(r.data.token) };
  };
  const openInvites = $derived(invites.filter((i) => i.usedAt === null && i.revokedAt === null));
</script>

{#if !session.isAdmin}
  <p>관리자만 본다.</p>
{:else}
  {#if shown !== undefined}
    <section class="shown" role="status">
      <p>{shown.label} — <strong>지금 한 번만 보인다</strong></p>
      <input readonly value={shown.link} onfocus={(e) => (e.currentTarget as HTMLInputElement).select()} />
    </section>
  {/if}
  {#if error !== undefined}<p class="err" role="alert">{error}</p>{/if}

  <section>
    <h2>초대</h2>
    <form onsubmit={(e) => { e.preventDefault(); void invite(); }}>
      <select bind:value={inviteRole}>{#each ROLES as r (r)}<option value={r}>{r}</option>{/each}</select>
      <input type="email" placeholder="이메일 (선택)" bind:value={inviteEmail} />
      <button type="submit">초대 링크 만들기</button>
    </form>
    <ul>
      {#each openInvites as i (i.id)}
        <li>{i.role} · {i.email ?? '이메일 없음'} · ~{i.expiresAt.slice(0, 16).replace('T', ' ')}
          <button type="button" class="quiet" onclick={() => { void accountApi.revokeInvitation(i.id).then(act); }}>취소</button></li>
      {/each}
    </ul>
  </section>

  <section>
    <h2>사람</h2>
    <table>
      <thead><tr><th>아이디</th><th>역할</th><th>상태</th><th>MFA</th><th></th></tr></thead>
      <tbody>
        {#each users as u (u.id)}
          <tr>
            <td>{u.username}{u.lockedUntil !== null ? ' (잠김)' : ''}</td>
            <td>
              <select value={u.role} onchange={(e) => { void accountApi.updateUser(u.id, { role: (e.currentTarget as HTMLSelectElement).value as Role }).then(act); }}>
                {#each ROLES as r (r)}<option value={r}>{r}</option>{/each}
              </select>
            </td>
            <td>
              <button type="button" class="quiet" onclick={() => { void accountApi.updateUser(u.id, { status: u.status === 'active' ? 'suspended' : 'active' }).then(act); }}>
                {u.status === 'active' ? '활성 → 정지' : '정지 → 활성'}
              </button>
            </td>
            <td>{u.totp ? '앱' : '—'}</td>
            <td class="ops">
              <button type="button" class="quiet" onclick={() => { void accountApi.revokeSessions(u.id).then(act); }}>세션 끊기</button>
              <button type="button" class="quiet" onclick={() => { void recovery(u); }}>복구 링크</button>
              <button type="button" class="quiet danger" onclick={() => { void remove(u); }}>삭제</button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </section>
{/if}

<style>
  section { display: grid; gap: 0.6rem; margin: 1.5rem 0; }
  h2 { font-size: 1rem; margin: 0; }
  p { margin: 0; }
  form { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  input, select { background: var(--plate); border: 1px solid var(--rule); color: var(--ink); padding: 0.4rem 0.55rem; }
  .shown { border: 1px solid var(--ember); padding: 0.8rem; }
  .shown input { font-family: var(--data); width: 100%; }
  ul { margin: 0; padding-left: 1.1rem; font-size: 0.9rem; color: var(--mute); }
  table { border-collapse: collapse; font-size: 0.9rem; width: 100%; }
  th, td { text-align: left; padding: 0.35rem 0.4rem; border-bottom: 1px solid var(--rule); }
  th { color: var(--mute); font-weight: 400; font-size: 0.8rem; }
  .ops { white-space: nowrap; }
  button { background: var(--plate); border: 1px solid var(--rule); color: var(--ink); padding: 0.4rem 0.7rem; cursor: pointer; }
  .quiet { border-color: transparent; color: var(--mute); padding: 0.2rem 0.4rem; }
  .danger { color: var(--ember); }
  .err { color: var(--ember); }
</style>
