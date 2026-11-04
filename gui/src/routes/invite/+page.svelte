<script lang="ts">
  /**
   * 초대·첫 관리자·복구 링크를 쓴다. 토큰은 주소의 `#` 뒤에 있다 — 서버로 가는 요청 줄에 안 실려
   * 접근 로그에 남지 않는다. 미리보기는 링크를 **쓰지 않는다.**
   *
   * 시안: 인증 앱이 필요하면 두 단계다 — 「비밀번호 → 계속」, 그다음 「인증 앱 등록 → 수락」. 단계는 화면에만 있다.
   * **서버에는 끝에 한 번만 보낸다**(아이디 · 비밀번호 · 인증 앱 코드를 같이) — 전과 같다.
   */
  import { onMount } from 'svelte';
  import { accountApi, type LinkPreview } from '#lib/account/api';
  import { PASSWORD_HELP, ROLE_LABEL } from '#lib/account/text';
  import TotpSetup from '#lib/account/TotpSetup.svelte';
  import RecoveryCodes from '#lib/account/RecoveryCodes.svelte';
  import { Button, Spinner, TextInput } from '#lib/ui';
  import AuthCard from '#lib/shell/AuthCard.svelte';
  import AuthField from '#lib/shell/AuthField.svelte';
  import AuthError from '#lib/shell/AuthError.svelte';

  let token = $state('');
  let preview = $state<LinkPreview | undefined>();
  let username = $state('');
  let password = $state('');
  let confirm = $state('');
  let code = $state('');
  let busy = $state(false);
  let error = $state<string | undefined>();
  let done = $state<{ recoveryCodes?: string[] } | undefined>();
  /** 화면의 단계. 'totp' 는 인증 앱이 필요한 링크에만 있다. */
  let step = $state<'password' | 'totp'>('password');

  const isRecovery = $derived(preview?.kind === 'recovery');
  const passwordsMatch = $derived(password !== '' && password === confirm);
  const mismatch = $derived(confirm !== '' && !passwordsMatch);
  /** 화면이 막은 까닭(시안: 「✕ …」 한 줄). 서버가 거절한 문장은 `error` 다. */
  let local = $state<string | undefined>();

  onMount(async () => {
    token = location.hash.replace(/^#/, '');
    if (token === '') { error = '링크에 토큰이 없어요. 받은 링크를 다시 열어요.'; return; }
    const r = await accountApi.previewLink(token);
    if (r.ok) preview = r.data; else error = r.message;
  });

  const needsTotp = $derived(preview?.totp !== undefined);
  /** 첫 단계의 버튼 — 인증 앱이 필요하면 다음 단계로, 아니면 바로 보낸다. */
  const next = (): void => {
    local = !isRecovery && username.trim() === '' ? '아이디를 입력해요.'
      : password === '' ? '비밀번호를 입력해요.'
      : !passwordsMatch ? '비밀번호가 서로 달라요. 같은 값을 두 번 입력해요.' : undefined;
    if (local !== undefined) return;
    if (needsTotp && step === 'password') { error = undefined; step = 'totp'; return; }
    void submit();
  };
  const submit = async (): Promise<void> => {
    if (preview === undefined || !passwordsMatch) return;
    if (step === 'totp' && code.trim() === '') { local = '숫자 6자리를 입력해요.'; return; }
    local = undefined;
    busy = true;
    error = undefined;
    const r = await accountApi.acceptLink({
      token,
      password,
      ...(isRecovery ? {} : { username }),
      ...(preview.totp === undefined ? {} : { totp: { secret: preview.totp.secret, code } }),
    });
    busy = false;
    // 아이디 · 비밀번호 쪽 거절이면 첫 단계로 돌아가 고친다. 인증 앱 코드가 틀렸으면 그 자리에 둔다.
    if (!r.ok) { error = r.message; if (r.code !== 'totp_mismatch' && r.code !== 'totp_required') step = 'password'; return; }
    // 주소에서 토큰을 지운다 — 다 쓴 링크라도 화면 공유·기록에 남길 이유가 없다.
    history.replaceState(null, '', '/invite');
    done = r.data;
  };
</script>

<!--
  시안 Login(lMode invite): 1단계 「초대 수락 · 비밀번호를 설정해요.」(초대한 계정 상자 · 새 비밀번호 · 확인 · 「계속」),
  2단계 「인증 앱 등록」(QR 상자 · 인증 코드 · 「수락」 · 「← 처음으로」), 카드 밖 「← 로그인으로」.
  아이디 칸 · 첫 관리자 · 복구 링크 · 끝난 뒤의 복구 코드는 시안에 없는 기능이라 같은 모양으로 둔다.
-->
{#snippet back()}<a href="/login">← 로그인으로</a>{/snippet}
{#if done !== undefined}
  <AuthCard title={isRecovery ? '다시 설정했어요' : '계정을 만들었어요'} sub="새 비밀번호로 로그인해요." links={back}>
    {#if done.recoveryCodes !== undefined}<RecoveryCodes codes={done.recoveryCodes} />{/if}
    <div class="full"><Button variant="primary" href="/login">로그인하러 가기</Button></div>
  </AuthCard>
{:else if preview !== undefined}
  <AuthCard links={back}
    title={step === 'totp' ? '인증 앱 등록' : preview.kind === 'bootstrap' ? '첫 관리자 계정 만들기' : isRecovery ? '계정 다시 설정하기' : '초대 수락'}
    sub={step === 'totp' ? '인증 앱에 이 계정을 더하고 앱의 6자리 코드를 입력해요.'
      : preview.kind === 'bootstrap' ? '이 설치의 첫 관리자 계정을 만들어요.'
      : isRecovery ? `${preview.username} 계정의 비밀번호${preview.needsTotp ? '와 인증 앱' : ''}을 다시 정해요.`
      : '비밀번호를 설정해요.'}>
    {#if step === 'password'}
      <form class="std" novalidate onsubmit={(e) => { e.preventDefault(); next(); }}>
        {#if preview.kind === 'invite'}
          <div class="who"><span class="mute">초대한 계정</span> <b>{preview.email ?? '이메일 없음'}</b> <span class="mute">· {ROLE_LABEL[preview.role] ?? preview.role}</span></div>
        {/if}
        {#if !isRecovery}
          <AuthField label="아이디" for="lg-id" help="영소문자 · 숫자 · . _ - 를 써요. 만든 뒤에는 바꿀 수 없어요.">
            <TextInput id="lg-id" autocomplete="username" bind:value={username} invalid={local === '아이디를 입력해요.'} oninput={() => { local = undefined; }} />
          </AuthField>
        {/if}
        <AuthField label="새 비밀번호" for="lg-pw" help={PASSWORD_HELP}>
          <TextInput id="lg-pw" type="password" autocomplete="new-password" mono={false} bind:value={password}
            invalid={(local !== undefined && local !== '아이디를 입력해요.') || mismatch} oninput={() => { local = undefined; }} />
        </AuthField>
        <AuthField label="비밀번호 확인" for="lg-pw2">
          <TextInput id="lg-pw2" type="password" autocomplete="new-password" mono={false} bind:value={confirm}
            invalid={(local !== undefined && local !== '아이디를 입력해요.') || mismatch} oninput={() => { local = undefined; }} />
        </AuthField>
        {#if local !== undefined}<AuthError>{local}</AuthError>{:else if error !== undefined}<AuthError>{error}</AuthError>{/if}
        <Button variant="primary" type="submit" loading={busy} style="width: 100%; height: 36px; font-size: 14px">{needsTotp ? '계속' : isRecovery ? '다시 설정' : '수락'}</Button>
      </form>
    {:else if preview.totp !== undefined}
      <form class="std" novalidate onsubmit={(e) => { e.preventDefault(); void submit(); }}>
        <TotpSetup secret={preview.totp.secret} uri={preview.totp.uri} bind:code />
        {#if local !== undefined}<AuthError>{local}</AuthError>{:else if error !== undefined}<AuthError>{error}</AuthError>{/if}
        <Button variant="primary" type="submit" loading={busy} style="width: 100%; height: 36px; font-size: 14px">{isRecovery ? '다시 설정' : '수락'}</Button>
        <Button variant="text" onclick={() => { step = 'password'; error = undefined; local = undefined; }} style="width: 100%; height: 28px; color: var(--tx2); font-size: 13px; font-weight: 400">← 처음으로</Button>
      </form>
    {/if}
  </AuthCard>
{:else if error !== undefined}
  <AuthCard title="링크를 쓸 수 없어요" links={back}>
    <AuthError>{error}</AuthError>
  </AuthCard>
{:else}
  <AuthCard title="초대 수락" links={back}>
    <p class="wait"><Spinner /> 링크를 확인하는 중이에요.</p>
  </AuthCard>
{/if}

<style>
  /* 링크 버튼(href)에는 style 이 안 붙는다 — 감싸서 시안의 36px 전체 폭 버튼으로 맞춘다. */
  .full { display: flex; }
  .full :global(.btn) { flex: 1; height: 36px; font-size: 14px; }
  .std { display: flex; flex-direction: column; gap: 14px; }
  .who { padding: 8px 10px; background: var(--bg-page); border: 1px solid var(--bd); border-radius: var(--r-md); font-size: 13px; }
  .who b { font-family: var(--mono); }
  .mute { color: var(--tx3); }
  .wait { margin: 0; display: flex; gap: 8px; align-items: center; font-size: 13px; color: var(--tx2); }
</style>
