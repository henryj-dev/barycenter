<script lang="ts">
  import { getContext, onMount } from 'svelte';
  import { accountApi } from '#lib/account/api';
  import type { Session } from '#lib/account/session.svelte.ts';
  import ChangePassword from '#lib/account/ChangePassword.svelte';
  import TotpManage from '#lib/account/TotpManage.svelte';
  import ChangeEmail from '#lib/account/ChangeEmail.svelte';
  import SsoIdentities from '#lib/account/SsoIdentities.svelte';

  const session = getContext<Session>('session');
  let note = $state<string | undefined>();
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
    note = r.ok ? `세션 ${r.data.revoked}개를 끊었다 — 이 기기도 다시 로그인한다` : r.message;
    await session.refresh();
  };
</script>

{#if session.me === undefined}
  <p>{session.checked ? '사람 계정으로 로그인하지 않았다 — 토큰으로 붙었으면 계정 화면이 없다.' : '확인하는 중…'}</p>
  <p><a href="/login">로그인</a></p>
{:else}
  {@const me = session.me}
  <section class="who">
    <p><strong>{me.username}</strong> · {me.role}{me.email !== null ? ` · ${me.email}` : ''}</p>
  </section>
  <ChangePassword />
  {#if mailOn}<ChangeEmail />{/if}
  <TotpManage {me} onChanged={session.refresh} />
  {#if ssoOn}<SsoIdentities {me} onChanged={session.refresh} />{/if}
  <section>
    <h2>열린 세션</h2>
    <ul>
      {#each me.sessions as s (s.createdAt + s.lastSeenAt)}
        <li><span class="mono">{s.lastSeenAt.slice(0, 16).replace('T', ' ')}</span> · {s.methods.join('+')} · {s.ip ?? '?'}</li>
      {/each}
    </ul>
    <button type="button" onclick={() => { void logoutAll(); }}>모든 기기에서 로그아웃</button>
    {#if note !== undefined}<p role="status">{note}</p>{/if}
  </section>
{/if}

<style>
  section { display: grid; gap: 0.6rem; margin: 1.5rem 0; max-width: 32rem; }
  :global(form), :global(section) { margin-bottom: 1.5rem; }
  h2 { font-size: 1rem; margin: 0; }
  p { margin: 0; }
  ul { margin: 0; padding-left: 1.1rem; color: var(--mute); font-size: 0.9rem; }
  .mono { font-family: var(--data); }
  button { justify-self: start; background: var(--plate); border: 1px solid var(--rule); color: var(--ink); padding: 0.5rem 0.85rem; cursor: pointer; }
</style>
