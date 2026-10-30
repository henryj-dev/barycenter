<script lang="ts">
  import { getContext, onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import type { Session } from '#lib/account/session.svelte.ts';
  import PasswordStep from '#lib/account/PasswordStep.svelte';
  import MfaStep from '#lib/account/MfaStep.svelte';
  import { accountApi } from '#lib/account/api';
  import { Button, FieldMessage, TextInput } from '#lib/ui';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const session = getContext<Session>('session');
  /** 자체 로그인 단계 — 비밀번호 → (필요하면) 인증 코드. */
  let step = $state<'password' | 'mfa'>('password');
  /** 메일이 켜진 배포에서만 「비밀번호를 잊었다」를 그린다. */
  let mailOn = $state(false);
  onMount(async () => {
    const f = await accountApi.features();
    mailOn = f.ok && f.data.mail;
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
        startError = r.status === 404 ? 'OIDC 가 설정되지 않았다' : `authorize ${r.status}`;
        return;
      }
      const body = (await r.json()) as { url?: unknown; state?: unknown };
      if (typeof body.url !== 'string' || typeof body.state !== 'string') {
        startError = 'authorize 응답이 아니다';
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
      startError = 'state 가 없다';
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
    void desk.connect();
    // 스트림이 붙으면 들어간다. 거절되면 desk 가 오류를 남긴다.
    for (let i = 0; i < 40 && !desk.live && desk.error === undefined; i++) await new Promise((r) => setTimeout(r, 150));
    tokenBusy = false;
    if (desk.live) { tokenInput = ''; await goto('/'); }
    else { tokenError = desk.error ?? '연결하지 못했어요. 토큰을 확인해요.'; desk.disconnect(); desk.token = ''; }
  };
</script>

<section>
  <h2>계정으로 로그인</h2>
  {#if step === 'password'}
    <PasswordStep onDone={(next) => { if (next === 'mfa') step = 'mfa'; else void signedIn(); }} />
  {:else}
    <MfaStep onDone={() => { void signedIn(); }} onRestart={() => { step = 'password'; }} />
  {/if}
  {#if mailOn && step === 'password'}<p><a href="/reset">비밀번호를 잊었어요</a></p>{/if}
</section>

<section>
  <h2>SSO</h2>
  <div><Button onclick={() => { void startLogin(); }} disabled={starting || exchanging} loading={starting || exchanging}>IdP로 로그인해요</Button></div>
  <p>계정이 없으면 관리자에게 초대를 받아요. 공개 가입은 없어요.</p>
  {#if startError !== undefined}<FieldMessage tone="error">{startError}</FieldMessage>{/if}
</section>

<section>
  <h2>토큰으로 연결</h2>
  <form class="tok" onsubmit={(e) => { e.preventDefault(); void connectToken(); }}>
    <TextInput type="password" autocomplete="off" aria-label="Bearer 토큰" placeholder="Bearer 토큰" bind:value={tokenInput} invalid={tokenError !== undefined} />
    <Button type="submit" loading={tokenBusy}>연결해요</Button>
  </form>
  {#if tokenError !== undefined}<FieldMessage tone="error">{tokenError}</FieldMessage>{/if}
  <p>자동화나 비상 접근에 써요. 토큰은 이 탭의 메모리에만 있어요. 새로고침하면 다시 넣어요.</p>
</section>

<style>
  section { display: grid; gap: 10px; padding-top: 16px; border-top: 1px solid var(--bd); }
  section:first-of-type { padding-top: 0; border-top: 0; }
  h2 { font: var(--t-h); margin: 0; }
  p { margin: 0; color: var(--tx2); font: var(--t-small); }
  .tok { display: flex; gap: 8px; }
</style>
