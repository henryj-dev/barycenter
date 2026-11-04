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
  import { Badge, Banner, Button, FormRow, FormSection, Spinner, TextInput } from '#lib/ui';

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

  onMount(async () => {
    token = location.hash.replace(/^#/, '');
    if (token === '') { error = '링크에 토큰이 없어요. 받은 링크를 다시 열어요.'; return; }
    const r = await accountApi.previewLink(token);
    if (r.ok) preview = r.data; else error = r.message;
  });

  const needsTotp = $derived(preview?.totp !== undefined);
  /** 첫 단계의 버튼 — 인증 앱이 필요하면 다음 단계로, 아니면 바로 보낸다. */
  const next = (): void => {
    if (!passwordsMatch) return;
    if (needsTotp && step === 'password') { error = undefined; step = 'totp'; return; }
    void submit();
  };
  const submit = async (): Promise<void> => {
    if (preview === undefined || !passwordsMatch) return;
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

<div class="std">
  {#if done !== undefined}
    <h1>{isRecovery ? '다시 설정했어요' : '계정을 만들었어요'}</h1>
    {#if done.recoveryCodes !== undefined}<RecoveryCodes codes={done.recoveryCodes} />{/if}
    <p class="lead">새 비밀번호로 로그인해요.</p>
    <div><Button variant="primary" href="/login">로그인하러 가기</Button></div>
  {:else if preview !== undefined}
    <h1>
      {#if step === 'totp'}인증 앱 등록
      {:else if preview.kind === 'bootstrap'}첫 관리자 계정 만들기
      {:else if isRecovery}계정 다시 설정하기
      {:else}초대받은 계정 만들기{/if}
    </h1>
    <p class="lead">
      {#if step === 'totp'}인증 앱으로 QR 코드를 찍고, 나온 6자리 코드를 입력해요.
      {:else if preview.kind === 'bootstrap'}이 설치의 첫 관리자 계정을 만들어요.
      {:else if isRecovery}<b>{preview.username}</b> 계정의 비밀번호{preview.needsTotp ? '와 인증 앱' : ''}을 다시 정해요.
      {:else}초대한 계정{#if preview.email !== null} <b>{preview.email}</b>{/if} · <Badge tone="accent" icon={null}>{ROLE_LABEL[preview.role] ?? preview.role}</Badge> 비밀번호를 설정해요.{/if}
    </p>
    {#if step === 'password'}
      <form class="std" onsubmit={(e) => { e.preventDefault(); next(); }}>
        <FormSection stack>
          {#if !isRecovery}
            <FormRow label="아이디" for="iv-user" help="영소문자 · 숫자 · . _ - 를 써요. 만든 뒤에는 바꿀 수 없어요.">
              <TextInput id="iv-user" autocomplete="username" bind:value={username} required />
            </FormRow>
          {/if}
          <FormRow label="비밀번호" for="iv-pass" help={PASSWORD_HELP}>
            <TextInput id="iv-pass" type="password" autocomplete="new-password" mono={false} bind:value={password} required />
          </FormRow>
          <FormRow label="비밀번호 확인" for="iv-conf" error={mismatch ? '비밀번호가 서로 달라요. 같은 값을 두 번 입력해요.' : undefined}>
            <TextInput id="iv-conf" type="password" autocomplete="new-password" mono={false} bind:value={confirm} invalid={mismatch} required />
          </FormRow>
        </FormSection>
        <Button variant="primary" type="submit" loading={busy} disabled={!passwordsMatch} style="width: 100%">{needsTotp ? '계속' : isRecovery ? '다시 설정' : '수락'}</Button>
        {#if error !== undefined}<Banner tone="danger">{error}</Banner>{/if}
      </form>
    {:else if preview.totp !== undefined}
      <form class="std" onsubmit={(e) => { e.preventDefault(); void submit(); }}>
        <TotpSetup secret={preview.totp.secret} uri={preview.totp.uri} bind:code />
        <Button variant="primary" type="submit" loading={busy} disabled={code.trim() === ''} style="width: 100%">{isRecovery ? '다시 설정' : '수락'}</Button>
        <Button variant="text" onclick={() => { step = 'password'; error = undefined; }}>← 비밀번호로</Button>
        {#if error !== undefined}<Banner tone="danger">{error}</Banner>{/if}
      </form>
    {/if}
  {:else if error !== undefined}
    <h1>링크를 쓸 수 없어요</h1>
    <Banner tone="danger">{error}</Banner>
  {:else}
    <p class="wait"><Spinner /> 링크를 확인하는 중이에요.</p>
  {/if}
</div>

<style>
  .std { display: grid; gap: 12px; }
  h1 { font: var(--t-title); margin: 0; }
  .lead { margin: 0; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; font: var(--t-body); color: var(--tx2); }
  .lead b { color: var(--tx); }
  .wait { margin: 0; display: flex; gap: 8px; align-items: center; font: var(--t-small); color: var(--tx2); }
</style>
