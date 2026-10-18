<script lang="ts">
  import { accountApi } from './api';

  /** 새 주소로 확인 메일 — 확인 전까지 주소는 그대로다. 메일이 꺼진 배포면 그리지 않는다(부모가 고른다). */
  let email = $state('');
  let password = $state('');
  let note = $state<{ ok: boolean; text: string } | undefined>();

  const submit = async (): Promise<void> => {
    const r = await accountApi.changeEmail(email, password);
    password = '';
    note = r.ok
      ? { ok: true, text: `${email} 로 확인 메일을 보냈다 — 그 링크를 열어야 바뀐다` }
      : { ok: false, text: r.message };
  };
</script>

<form onsubmit={(e) => { e.preventDefault(); void submit(); }}>
  <h2>이메일</h2>
  <label><span>새 이메일</span><input type="email" autocomplete="email" bind:value={email} required /></label>
  <label><span>비밀번호 확인</span><input type="password" autocomplete="current-password" bind:value={password} required /></label>
  <button type="submit">확인 메일 받기</button>
  {#if note !== undefined}<p class:err={!note.ok} role="status">{note.text}</p>{/if}
</form>

<style>
  form { display: grid; gap: 0.6rem; max-width: 24rem; }
  h2 { font-size: 1rem; margin: 0; }
  label { display: flex; flex-direction: column; gap: 0.25rem; }
  span { font-size: 0.8rem; color: var(--mute); }
  input { background: var(--plate); border: 1px solid var(--rule); color: var(--ink); padding: 0.45rem 0.6rem; }
  button { justify-self: start; background: var(--plate); border: 1px solid var(--rule); color: var(--ink); padding: 0.5rem 0.85rem; cursor: pointer; }
  p { margin: 0; font-size: 0.9rem; color: var(--moss); }
  .err { color: var(--ember); }
</style>
