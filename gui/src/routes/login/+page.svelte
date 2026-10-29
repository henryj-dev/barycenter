<script lang="ts">
  import { getContext, onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import type { Session } from '#lib/account/session.svelte.ts';
  import PasswordStep from '#lib/account/PasswordStep.svelte';
  import MfaStep from '#lib/account/MfaStep.svelte';
  import { accountApi } from '#lib/account/api';

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
    await desk.connect();
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
</script>

<section>
  <h2>계정으로 로그인</h2>
  {#if step === 'password'}
    <PasswordStep onDone={(next) => { if (next === 'mfa') step = 'mfa'; else void signedIn(); }} />
  {:else}
    <MfaStep onDone={() => { void signedIn(); }} onRestart={() => { step = 'password'; }} />
  {/if}
  {#if mailOn && step === 'password'}<p><a href="/reset">비밀번호를 잊었다</a></p>{/if}
</section>

<section>
  <h2>SSO</h2>
  <button type="button" onclick={() => { void startLogin(); }} disabled={starting || exchanging}>
    IdP로 로그인
  </button>
  <p>계정이 없으면 관리자에게 초대를 받는다 — 공개 가입은 없다. 해시 토큰은 위 칸에 넣는다.</p>
  {#if startError !== undefined}
    <p class="err" role="alert">{startError}</p>
  {/if}
</section>

<style>
  section { display: grid; gap: 0.75rem; margin: 1.5rem 0; }
  h2 { font-size: 1rem; margin: 0; }
  button {
    justify-self: start;
    background: var(--plate);
    border: 1px solid var(--rule);
    color: var(--ink);
    padding: 0.5rem 0.85rem;
    cursor: pointer;
  }
  button:disabled { opacity: 0.6; cursor: default; }
  p { margin: 0; color: var(--mute); font-size: 0.9rem; }
  .err { color: var(--ember); }
</style>
