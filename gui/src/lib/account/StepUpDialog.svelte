<script lang="ts">
  /** 민감 작업 앞에서 한 번 묻는다. 레이아웃에 하나만 둔다. */
  import { accountApi } from './api';
  import { stepUp } from './step-up.svelte';

  let code = $state('');
  let error = $state<string | undefined>();
  let busy = $state(false);

  const submit = async (): Promise<void> => {
    busy = true;
    const r = await accountApi.stepUp(code.trim());
    busy = false;
    code = '';
    if (!r.ok) { error = r.message; return; }
    error = undefined;
    stepUp.answer(true);
  };
  const cancel = (): void => { error = undefined; code = ''; stepUp.answer(false); };
</script>

{#if stepUp.asking}
  <div class="veil" role="dialog" aria-modal="true" aria-labelledby="stepup-h">
    <form onsubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2 id="stepup-h">인증 앱으로 한 번 더 확인한다</h2>
      <p>이 작업은 최근 15분 안에 인증 앱 확인이 필요하다. 코드(또는 복구 코드)를 넣으면 바로 이어서 한다.</p>
      <input inputmode="numeric" autocomplete="one-time-code" bind:value={code} required />
      <div class="row">
        <button type="submit" disabled={busy}>확인</button>
        <button type="button" class="quiet" onclick={cancel}>그만둔다</button>
      </div>
      {#if error !== undefined}<p class="err" role="alert">{error}</p>{/if}
    </form>
  </div>
{/if}

<style>
  .veil { position: fixed; inset: 0; background: color-mix(in srgb, var(--ink) 35%, transparent); display: grid; place-items: center; padding: 1rem; }
  form { background: var(--paper, var(--plate)); border: 1px solid var(--rule); padding: 1.2rem; display: grid; gap: 0.7rem; max-width: 24rem; width: 100%; }
  h2 { font-size: 1rem; margin: 0; }
  p { margin: 0; font-size: 0.9rem; color: var(--mute); }
  input { background: var(--plate); border: 1px solid var(--rule); color: var(--ink); padding: 0.45rem 0.6rem; font-family: var(--data); }
  .row { display: flex; gap: 0.5rem; }
  button { background: var(--plate); border: 1px solid var(--rule); color: var(--ink); padding: 0.5rem 0.85rem; cursor: pointer; }
  .quiet { border-color: transparent; color: var(--mute); }
  .err { color: var(--ember); }
</style>
