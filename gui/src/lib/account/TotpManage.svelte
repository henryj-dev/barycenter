<script lang="ts">
  import { accountApi, type Me } from './api';
  import TotpSetup from './TotpSetup.svelte';
  import RecoveryCodes from './RecoveryCodes.svelte';

  /** 등록·해제·복구 코드 재발급. **관리자는 해제할 수 없다**(서버가 409 로 막는다 — 버튼도 안 그린다). */
  let { me, onChanged }: { me: Me; onChanged: () => Promise<void> } = $props();

  let pending = $state<{ secret: string; uri: string } | undefined>();
  let code = $state('');
  let password = $state('');
  let codes = $state<string[] | undefined>();
  let error = $state<string | undefined>();

  const begin = async (): Promise<void> => {
    error = undefined;
    const r = await accountApi.beginTotp();
    if (r.ok) pending = r.data; else error = r.message;
  };
  const confirm = async (): Promise<void> => {
    const r = await accountApi.confirmTotp(code);
    code = '';
    if (!r.ok) { error = r.message; return; }
    pending = undefined;
    codes = r.data.recoveryCodes;
    await onChanged();
  };
  const remove = async (): Promise<void> => {
    const r = await accountApi.removeTotp(password);
    password = '';
    if (!r.ok) { error = r.message; return; }
    await onChanged();
  };
  const regenerate = async (): Promise<void> => {
    const r = await accountApi.recoveryCodes(password);
    password = '';
    if (r.ok) codes = r.data.recoveryCodes; else error = r.message;
    await onChanged();
  };
</script>

<section>
  <h2>인증 앱 (TOTP)</h2>
  {#if codes !== undefined}<RecoveryCodes {codes} />{/if}
  {#if me.mfa.totp}
    <p>등록됨 · 남은 복구 코드 {me.mfa.recoveryCodesLeft}개</p>
    <label><span>비밀번호 확인</span><input type="password" autocomplete="current-password" bind:value={password} /></label>
    <div class="row">
      <button type="button" onclick={() => { void regenerate(); }}>복구 코드 새로 받기</button>
      {#if me.role !== 'admin'}<button type="button" onclick={() => { void remove(); }}>해제</button>{/if}
    </div>
  {:else if pending !== undefined}
    <form onsubmit={(e) => { e.preventDefault(); void confirm(); }}>
      <TotpSetup secret={pending.secret} uri={pending.uri} bind:code />
      <button type="submit">등록 확인</button>
    </form>
  {:else}
    <p>등록되지 않았다. 등록하면 로그인할 때 코드를 함께 넣는다.</p>
    <button type="button" onclick={() => { void begin(); }}>등록 시작</button>
  {/if}
  {#if error !== undefined}<p class="err" role="alert">{error}</p>{/if}
</section>

<style>
  section, form { display: grid; gap: 0.6rem; max-width: 26rem; }
  h2 { font-size: 1rem; margin: 0; }
  p { margin: 0; font-size: 0.9rem; color: var(--mute); }
  label { display: flex; flex-direction: column; gap: 0.25rem; }
  span { font-size: 0.8rem; color: var(--mute); }
  input { background: var(--plate); border: 1px solid var(--rule); color: var(--ink); padding: 0.45rem 0.6rem; }
  .row { display: flex; gap: 0.5rem; }
  button { justify-self: start; background: var(--plate); border: 1px solid var(--rule); color: var(--ink); padding: 0.5rem 0.85rem; cursor: pointer; }
  .err { color: var(--ember); }
</style>
