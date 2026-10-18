<script lang="ts">
  /**
   * 비밀번호 재설정. 주소에 `#토큰` 이 있으면 새 비밀번호를 정하고, 없으면 메일을 요청한다.
   * 요청 결과는 **언제나 같은 문장**이다 — 그 주소에 계정이 있는지 화면이 말하지 않는다.
   * 재설정은 인증 앱을 풀지 않는다(관리자는 로그인 때 코드가 그대로 필요하다).
   */
  import { onMount } from 'svelte';
  import { accountApi } from '$lib/account/api';

  let token = $state('');
  let email = $state('');
  let password = $state('');
  let confirm = $state('');
  let note = $state<{ ok: boolean; text: string } | undefined>();
  let busy = $state(false);
  const matches = $derived(password !== '' && password === confirm);

  onMount(() => { token = location.hash.replace(/^#/, ''); });

  const request = async (): Promise<void> => {
    busy = true;
    const r = await accountApi.requestReset(email);
    busy = false;
    note = r.ok || r.status === 202
      ? { ok: true, text: '그 주소가 계정에 묶여 있으면 재설정 링크를 보냈다. 메일함을 본다 (30분 안).' }
      : { ok: false, text: r.message };
  };
  const reset = async (): Promise<void> => {
    if (!matches) return;
    busy = true;
    const r = await accountApi.confirmReset(token, password);
    busy = false;
    if (!r.ok) { note = { ok: false, text: r.message }; return; }
    history.replaceState(null, '', '/reset');
    token = '';
    note = { ok: true, text: '바꿨다 — 열려 있던 세션은 모두 끊겼다. 다시 로그인한다.' };
  };
</script>

{#if token !== ''}
  <form onsubmit={(e) => { e.preventDefault(); void reset(); }}>
    <label><span>새 비밀번호 (8자 이상, 영소문자·영대문자·숫자·특수문자 중 3종류)</span><input type="password" autocomplete="new-password" bind:value={password} required /></label>
    <label><span>새 비밀번호 확인</span><input type="password" autocomplete="new-password" bind:value={confirm} required /></label>
    {#if confirm !== '' && !matches}<p class="err">두 비밀번호가 다르다</p>{/if}
    <button type="submit" disabled={busy || !matches}>바꾸기</button>
  </form>
{:else if note === undefined || !note.ok}
  <form onsubmit={(e) => { e.preventDefault(); void request(); }}>
    <label><span>계정 이메일</span><input type="email" autocomplete="email" bind:value={email} required /></label>
    <button type="submit" disabled={busy}>재설정 링크 받기</button>
  </form>
{/if}
{#if note !== undefined}<p class:err={!note.ok} role="status">{note.text}</p>{/if}
<p><a href="/login">로그인으로</a></p>

<style>
  form { display: grid; gap: 0.6rem; max-width: 24rem; margin: 1.5rem 0; }
  label { display: flex; flex-direction: column; gap: 0.25rem; }
  span { font-size: 0.8rem; color: var(--mute); }
  input { background: var(--plate); border: 1px solid var(--rule); color: var(--ink); padding: 0.45rem 0.6rem; }
  button { justify-self: start; background: var(--plate); border: 1px solid var(--rule); color: var(--ink); padding: 0.5rem 0.85rem; cursor: pointer; }
  button:disabled { opacity: 0.6; cursor: default; }
  p { margin: 0 0 0.5rem; }
  .err { color: var(--ember); }
</style>
