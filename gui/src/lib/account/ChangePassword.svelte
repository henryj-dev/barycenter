<script lang="ts">
  import { accountApi } from './api';

  let current = $state('');
  let next = $state('');
  let busy = $state(false);
  let note = $state<{ ok: boolean; text: string } | undefined>();

  const submit = async (): Promise<void> => {
    busy = true;
    const r = await accountApi.changePassword(current, next);
    busy = false;
    current = '';
    next = '';
    note = r.ok ? { ok: true, text: '바꿨다 — 이 기기 말고 다른 세션은 모두 끊겼다' } : { ok: false, text: r.message };
  };
</script>

<form onsubmit={(e) => { e.preventDefault(); void submit(); }}>
  <h2>비밀번호</h2>
  <label><span>지금 비밀번호</span><input type="password" autocomplete="current-password" bind:value={current} required /></label>
  <label><span>새 비밀번호 (8자 이상, 영소문자·영대문자·숫자·특수문자 중 3종류)</span><input type="password" autocomplete="new-password" bind:value={next} required /></label>
  <button type="submit" disabled={busy}>바꾸기</button>
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
