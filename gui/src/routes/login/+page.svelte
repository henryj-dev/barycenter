<script lang="ts">
  import { getContext, onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import type { Session } from '#lib/account/session.svelte.ts';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import PasswordStep from '#lib/account/PasswordStep.svelte';
  import MfaStep from '#lib/account/MfaStep.svelte';
  import { accountApi } from '#lib/account/api';
  import { Button, TextInput } from '#lib/ui';
  import AuthCard from '#lib/shell/AuthCard.svelte';
  import AuthField from '#lib/shell/AuthField.svelte';
  import AuthError from '#lib/shell/AuthError.svelte';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const session = getContext<Session>('session');
  const scope = getContext<Scope>('scope');
  /** 자체 로그인 단계 — 비밀번호 → (필요하면) 인증 코드. */
  let step = $state<'password' | 'mfa'>('password');
  /** 메일이 켜진 배포에서만 「비밀번호를 잊었다」를 그린다. */
  let mailOn = $state(false);
  /** OIDC 가 설정된 배포에서만 「IdP로 로그인해요」 를 그린다 — 누르고 나서 「설정되지 않았어요」 를 보이지 않게. */
  let ssoOn = $state(false);
  onMount(async () => {
    const f = await accountApi.features();
    mailOn = f.ok && f.data.mail;
    ssoOn = f.ok && f.data.sso;
  });

  const signedIn = async (): Promise<void> => {
    await session.refresh();
    // **기다리지 않는다.** `connect` 는 스트림이 끊길 때까지(재연결 고리) 끝나지 않는다 — 기다리면 이동하지 않는다.
    void desk.connect();
    await goto('/');
  };
  let startError = $state<string | undefined>();
  let starting = $state(false);
  let exchanging = $state(false);

  const startLogin = async (): Promise<void> => {
    startError = undefined;
    starting = true;
    try {
      const r = await fetch('/api/v1/oidc/authorization-request');
      if (!r.ok) {
        startError = r.status === 404 ? 'OIDC가 설정되지 않았어요.' : `authorize ${r.status}`;
        return;
      }
      const body = (await r.json()) as { url?: unknown; state?: unknown };
      if (typeof body.url !== 'string' || typeof body.state !== 'string') {
        startError = 'authorize 응답이 아니에요.';
        return;
      }
      window.location.assign(body.url);
    } catch (e) {
      startError = e instanceof Error ? e.message : String(e);
    } finally {
      starting = false;
    }
  };

  const exchange = async (code: string, state: string): Promise<void> => {
    if (state === '') {
      startError = 'state가 없어요. 다시 로그인해요.';
      return;
    }
    exchanging = true;
    try {
      const r = await fetch('/api/v1/oidc/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ code, state }),
      });
      const body = (await r.json()) as { authenticated?: unknown; status?: unknown; message?: unknown };
      // 콜백 주소에서 code·state 를 지운다 — 한 번 쓴 값이 기록·공유 화면에 남지 않게.
      history.replaceState(null, '', '/login');
      if (!r.ok) {
        startError = typeof body.message === 'string' ? body.message : `token ${r.status}`;
        return;
      }
      // 사람 계정: SSO 뒤에도 관리자·인증 앱 등록자는 로컬 코드 단계다(IdP 의 MFA 는 인정하지 않는다).
      if (body.status === 'mfa_required') { step = 'mfa'; return; }
      if (body.status === 'linked') { await goto('/account'); return; }
      if (body.authenticated !== true) {
        startError = `token ${r.status}`;
        return;
      }
      await signedIn();
    } catch (e) {
      startError = e instanceof Error ? e.message : String(e);
    } finally {
      exchanging = false;
    }
  };

  onMount(() => {
    const code = page.url.searchParams.get('code');
    const state = page.url.searchParams.get('state');
    if (code !== null && state !== null) void exchange(code, state);
  });

  /**
   * 토큰으로 연결 — 사람 계정이 없는 자동화·비상 접근용. 셸의 상단에서 옮겨 왔다(#126): 로그인 상태에서는
   * 토큰 칸을 어디에도 안 보인다. 값은 메모리에만 둔다 — 새로고침하면 사라진다.
   */
  let tokenInput = $state('');
  let tokenBusy = $state(false);
  let tokenError = $state<string | undefined>();
  const connectToken = async (): Promise<void> => {
    if (tokenInput.trim() === '') { tokenError = '토큰을 넣어요.'; return; }
    tokenError = undefined;
    tokenBusy = true;
    desk.token = tokenInput.trim();
    if (scope.mode === 'global') {
      // 전역에는 셸 스트림이 없다 — 지역 목록으로 토큰을 잰다. 첫 화면은 전체 합산 대시보드다(2026-11-04 결정).
      const r = await fetch('/api/v1/regions', { headers: { authorization: `Bearer ${desk.token}` } });
      tokenBusy = false;
      if (r.ok) { tokenInput = ''; await goto('/'); return; }
      tokenError = r.status === 401 ? '토큰이 거절됐어요.' : `regions ${r.status}`;
      desk.token = '';
      return;
    }
    void desk.connect();
    // 스트림이 붙으면 들어간다. 거절되면 desk 가 오류를 남긴다.
    for (let i = 0; i < 40 && !desk.live && desk.error === undefined; i++) await new Promise((r) => setTimeout(r, 150));
    tokenBusy = false;
    if (desk.live) { tokenInput = ''; await goto('/'); }
    else { tokenError = desk.error ?? '연결하지 못했어요. 토큰을 확인해요.'; desk.disconnect(); desk.token = ''; }
  };
</script>

<!--
  시안 Login(lMode login): 카드 — 단계마다 제목과 한 줄 설명, 그 아래 폼. 카드 밖 아래에 「비밀번호 찾기」 · 「초대 수락」.
  SSO 와 토큰 연결은 시안에 없는 기능이라 같은 카드 안, 폼 아래에 같은 모양(라벨 13 · 칸 36 · 버튼 36)으로 둔다.
-->
<AuthCard title={step === 'password' ? '로그인' : '2단계 인증'} sub={step === 'password' ? '계정으로 콘솔에 로그인해요.' : '인증 앱의 6자리 코드를 입력해요.'}>
  {#if step === 'password'}
    <PasswordStep onDone={(next) => { if (next === 'mfa') step = 'mfa'; else void signedIn(); }} />
  {:else}
    <MfaStep onDone={() => { void signedIn(); }} onRestart={() => { step = 'password'; }} />
  {/if}

  <!-- SSO 콜백을 받는 중이거나 그 오류는 OIDC 설정과 상관없이 보인다. -->
  {#if step === 'password' && (ssoOn || exchanging || startError !== undefined)}
    <div class="more">
      <Button onclick={() => { void startLogin(); }} disabled={starting || exchanging} loading={starting || exchanging} style="width: 100%; height: 36px; font-size: 14px">IdP로 로그인해요</Button>
      {#if startError !== undefined}<AuthError>{startError}</AuthError>{/if}
      <div class="note">계정이 없으면 관리자에게 초대를 받아요. 공개 가입은 없어요.</div>
    </div>
  {/if}

  {#if step === 'password'}
    <form class="more" novalidate onsubmit={(e) => { e.preventDefault(); void connectToken(); }}>
      <AuthField label="토큰으로 연결" for="lg-token" help="자동화나 비상 접근에 써요. 토큰은 이 탭의 메모리에만 있어요. 새로고침하면 다시 넣어요.">
        <TextInput id="lg-token" type="password" autocomplete="off" placeholder="Bearer 토큰" bind:value={tokenInput} invalid={tokenError !== undefined} />
      </AuthField>
      {#if tokenError !== undefined}<AuthError>{tokenError}</AuthError>{/if}
      <Button type="submit" loading={tokenBusy} style="width: 100%; height: 36px; font-size: 14px">연결해요</Button>
    </form>
  {/if}

  {#snippet links()}
    {#if mailOn}<a href="/reset">비밀번호 찾기</a>{/if}
    <a href="/invite">초대 수락</a>
  {/snippet}
</AuthCard>

<style>
  .more { display: flex; flex-direction: column; gap: 14px; padding-top: 16px; border-top: 1px solid var(--bd); }
  .note { font-size: 12px; color: var(--tx3); }
</style>
