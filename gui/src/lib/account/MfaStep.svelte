<script lang="ts">
  import { accountApi } from './api';

  /** 인증 앱 6자리 코드 또는 복구 코드(xxxx-xxxx). 5분 안에 넣어야 한다. */
  let { onDone, onRestart }: { onDone: () => void; onRestart: () => void } = $props();

  let code = $state('');
  let busy = $state(false);
  let error = $state<string | undefined>();

  const submit = async (): Promise<void> => {
    busy = true;
    error = undefined;
    const r = await accountApi.mfa(code.trim());
    busy = false;
    code = '';
    if (!r.ok) {
      error = r.message;
      return;
    }
    onDone();
  };
</script>

<form onsubmit={(e) => { e.preventDefault(); void submit(); }}>
  <label>
    <span>인증 앱의 6자리 코드 (또는 복구 코드)</span>
    <input inputmode="numeric" autocomplete="one-time-code" bind:value={code} required />
  </label>
  <button type="submit" disabled={busy}>확인</button>
  <button type="button" class="quiet" onclick={onRestart}>처음부터</button>
  {#if error !== undefined}<p class="err" role="alert">{error}</p>{/if}
</form>

<style>
  form { display: grid; gap: 0.6rem; max-width: 22rem; }
  label { display: flex; flex-direction: column; gap: 0.25rem; }
  span { font-size: 0.8rem; color: var(--mute); }
  input { background: var(--plate); border: 1px solid var(--rule); color: var(--ink); padding: 0.45rem 0.6rem; font-family: var(--data); letter-spacing: 0.1em; }
  button { justify-self: start; background: var(--plate); border: 1px solid var(--rule); color: var(--ink); padding: 0.5rem 0.85rem; cursor: pointer; }
  button:disabled { opacity: 0.6; cursor: default; }
  .quiet { border-color: transparent; color: var(--mute); }
  .err { margin: 0; color: var(--ember); }
</style>
