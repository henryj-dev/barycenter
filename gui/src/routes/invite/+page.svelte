<script lang="ts">
  /**
   * 초대·첫 관리자·복구 링크를 쓴다. 토큰은 주소의 `#` 뒤에 있다 — 서버로 가는 요청 줄에 안 실려
   * 접근 로그에 남지 않는다. 미리보기는 링크를 **쓰지 않는다.**
   */
  import { onMount } from 'svelte';
  import { accountApi, type LinkPreview } from '$lib/account/api';
  import TotpSetup from '$lib/account/TotpSetup.svelte';
  import RecoveryCodes from '$lib/account/RecoveryCodes.svelte';

  let token = $state('');
  let preview = $state<LinkPreview | undefined>();
  let username = $state('');
  let password = $state('');
  let confirm = $state('');
  let code = $state('');
  let busy = $state(false);
  let error = $state<string | undefined>();
  let done = $state<{ recoveryCodes?: string[] } | undefined>();

  const isRecovery = $derived(preview?.kind === 'recovery');
  const passwordsMatch = $derived(password !== '' && password === confirm);

  onMount(async () => {
    token = location.hash.replace(/^#/, '');
    if (token === '') { error = '링크에 토큰이 없다'; return; }
    const r = await accountApi.previewLink(token);
    if (r.ok) preview = r.data; else error = r.message;
  });

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
    if (!r.ok) { error = r.message; return; }
    // 주소에서 토큰을 지운다 — 다 쓴 링크라도 화면 공유·기록에 남길 이유가 없다.
    history.replaceState(null, '', '/invite');
    done = r.data;
  };
</script>

{#if done !== undefined}
  <section>
    <h2>{isRecovery ? '다시 설정했다' : '계정을 만들었다'}</h2>
    {#if done.recoveryCodes !== undefined}<RecoveryCodes codes={done.recoveryCodes} />{/if}
    <p><a href="/login">로그인하러 가기</a></p>
  </section>
{:else if preview !== undefined}
  <form onsubmit={(e) => { e.preventDefault(); void submit(); }}>
    <p class="lead">
      {#if preview.kind === 'bootstrap'}첫 관리자 계정을 만든다.
      {:else if isRecovery}<strong>{preview.username}</strong> 계정의 비밀번호{preview.needsTotp ? '와 인증 앱' : ''}을 다시 정한다.
      {:else}<strong>{preview.role}</strong> 역할로 초대받았다{preview.email !== null ? ` (${preview.email})` : ''}.{/if}
    </p>
    {#if !isRecovery}
      <label><span>아이디 (영소문자·숫자·._-, 바꿀 수 없다)</span><input autocomplete="username" bind:value={username} required /></label>
    {/if}
    <label><span>비밀번호 (12자 이상)</span><input type="password" autocomplete="new-password" bind:value={password} required /></label>
    <label><span>비밀번호 확인</span><input type="password" autocomplete="new-password" bind:value={confirm} required /></label>
    {#if confirm !== '' && !passwordsMatch}<p class="err">두 비밀번호가 다르다</p>{/if}
    {#if preview.totp !== undefined}
      <TotpSetup secret={preview.totp.secret} uri={preview.totp.uri} bind:code />
    {/if}
    <button type="submit" disabled={busy || !passwordsMatch}>{isRecovery ? '다시 설정' : '계정 만들기'}</button>
    {#if error !== undefined}<p class="err" role="alert">{error}</p>{/if}
  </form>
{:else if error !== undefined}
  <p class="err" role="alert">{error}</p>
{:else}
  <p>링크를 확인하는 중…</p>
{/if}

<style>
  form, section { display: grid; gap: 0.7rem; max-width: 26rem; margin: 1.5rem 0; }
  h2 { font-size: 1.1rem; margin: 0; }
  .lead { margin: 0; }
  label { display: flex; flex-direction: column; gap: 0.25rem; }
  span { font-size: 0.8rem; color: var(--mute); }
  input { background: var(--plate); border: 1px solid var(--rule); color: var(--ink); padding: 0.45rem 0.6rem; }
  button { justify-self: start; background: var(--plate); border: 1px solid var(--rule); color: var(--ink); padding: 0.5rem 0.85rem; cursor: pointer; }
  button:disabled { opacity: 0.6; cursor: default; }
  .err { margin: 0; color: var(--ember); }
</style>
