<script lang="ts">
  /**
   * 내 계정 — 시안(Account) 순서: 비밀번호 · 인증 앱 · 복구 코드 · SSO 연결. 최대 폭 820 · 카드 사이 16.
   * 시안에 없는 기능은 같은 모양의 카드로 둔다: 맨 위 「누구인가」, SSO 다음 이메일 · 토큰 · 열린 세션.
   * 「토큰」 은 시안에서는 사람 화면의 카드다 — 토큰은 사람 한 명의 것(내 역할 이하)이라 내 계정에 둔다.
   */
  import { getContext, onMount } from 'svelte';
  import { accountApi } from '#lib/account/api';
  import type { Session } from '#lib/account/session.svelte.ts';
  import ChangePassword from '#lib/account/ChangePassword.svelte';
  import TotpManage from '#lib/account/TotpManage.svelte';
  import ChangeEmail from '#lib/account/ChangeEmail.svelte';
  import SsoIdentities from '#lib/account/SsoIdentities.svelte';
  import ApiTokens from '#lib/account/ApiTokens.svelte';
  import { Button, Card, FieldMessage, Skeleton } from '#lib/ui';

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
</script>

{#if session.me === undefined}
  {#if session.checked}
    <Card>
      <div class="hd"><div class="t">사람 계정으로 로그인하지 않았어요</div><div class="s">토큰으로 연결했으면 계정 화면이 없어요.</div></div>
      <div class="pad"><Button variant="primary" href="/login">로그인</Button></div>
    </Card>
  {:else}
    <Skeleton height="120px" label="확인하는 중" />
  {/if}
{:else}
  {@const me = session.me}
  <div class="acct">
    <!-- 시안 내 계정은 비밀번호 카드부터다 — 이름 · 역할은 상단 사용자 메뉴가 말한다. -->
    {#if me.hasPassword}<ChangePassword />{/if}
    <TotpManage {me} onChanged={session.refresh} />
    {#if ssoOn}<SsoIdentities {me} onChanged={session.refresh} />{/if}
    {#if mailOn}<ChangeEmail />{/if}
    <ApiTokens {me} />
    <Card title="열린 세션 · {me.sessions.length}" padded={false}>
      {#snippet actions()}<Button size="sm" variant="danger" onclick={() => { void logoutAll(); }}>모든 기기에서 로그아웃</Button>{/snippet}
      <div class="th"><span>마지막 사용</span><span>인증</span><span>IP</span><span>브라우저</span></div>
      {#each me.sessions as r (r.createdAt + r.lastSeenAt)}
        <div class="tr">
          <span class="m">{new Date(r.lastSeenAt).toLocaleString()}</span>
          <span class="m">{r.methods.join(' + ')}</span>
          <span class="m">{r.ip ?? '?'}</span>
          <span class="mu" title={r.userAgent ?? ''}>{r.userAgent ?? ''}</span>
        </div>
      {:else}
        <div class="empty">열린 세션이 없어요.</div>
      {/each}
    </Card>
    {#if note !== undefined}<FieldMessage tone={note.ok ? 'ok' : 'error'}>{note.text}</FieldMessage>{/if}
  </div>
{/if}

<style>
  .acct { display: flex; flex-direction: column; gap: 16px; max-width: 820px; }
  .hd { margin-bottom: 12px; }
  .t { font-weight: 600; font-size: 14px; }
  .s { font-size: 12px; color: var(--tx3); }
  .pad { margin-top: 12px; }
  /* 시안의 카드 표 — 머리 행 --bg-hover 32px · 행 --row-h · 위 테두리 */
  .th, .tr { display: grid; grid-template-columns: 1.2fr 1fr 1fr 1.6fr; gap: 12px; padding: 0 16px; align-items: center; }
  .th { height: 32px; background: var(--bg-hover); font-size: 12px; font-weight: 600; color: var(--tx2); }
  .tr { height: var(--row-h); border-top: 1px solid var(--bd); font-size: 13px; }
  .tr:hover { background-image: linear-gradient(var(--hov), var(--hov)); }
  .m { font-family: var(--mono); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mu { font-size: 12px; color: var(--tx3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty { padding: 20px; text-align: center; color: var(--tx3); font-size: 13px; border-top: 1px solid var(--bd); }
</style>
