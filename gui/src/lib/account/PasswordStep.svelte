<script lang="ts">
  import { accountApi } from './api';

  /** 비밀번호가 맞으면 다음 단계를 알린다 — 관리자·인증 앱 등록자는 `mfa`. */
  let { onDone }: { onDone: (next: 'ok' | 'mfa') => void } = $props();

  let username = $state('');
  let password = $state('');
  let busy = $state(false);
  let error = $state<string | undefined>();

  const submit = async (): Promise<void> => {
    busy = true;
    error = undefined;
    const r = await accountApi.login(username, password);
    busy = false;
    password = '';
    if (!r.ok) {
      error = r.message;
      return;
    }
    onDone(r.data.status === 'mfa_required' ? 'mfa' : 'ok');
  };
</script>

<form onsubmit={(e) => { e.preventDefault(); void submit(); }}>
  <label><span>아이디 또는 이메일</span><input autocomplete="username" bind:value={username} required /></label>
  <label><span>비밀번호</span><input type="password" autocomplete="current-password" bind:value={password} required /></label>
  <button type="submit" disabled={busy}>로그인</button>
  {#if error !== undefined}<p class="err" role="alert">{error}</p>{/if}
</form>

<style>
  form { display: grid; gap: 0.6rem; max-width: 22rem; }
  label { display: flex; flex-direction: column; gap: 0.25rem; }
  span { font-size: 0.8rem; color: var(--mute); }
  input { background: var(--plate); border: 1px solid var(--rule); color: var(--ink); padding: 0.45rem 0.6rem; }
  button { justify-self: start; background: var(--plate); border: 1px solid var(--rule); color: var(--ink); padding: 0.5rem 0.85rem; cursor: pointer; }
  button:disabled { opacity: 0.6; cursor: default; }
  .err { margin: 0; color: var(--ember); }
</style>
