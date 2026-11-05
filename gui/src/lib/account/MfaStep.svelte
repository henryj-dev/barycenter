<script lang="ts">
  /**
   * 로그인 둘째 단계 — 인증 앱 6자리 코드 또는 복구 코드(xxxx-xxxx). 5분 안에 넣어야 한다.
   * 시안(Login · lMode login, 2단계): 「인증 코드 6자리」 큰 칸(44 · 고정폭 22 · 자간 8 · 가운데), 도움말, 오류 한 줄,
   * 「로그인」, 「← 처음으로」. 복구 코드도 받으므로 칸 길이를 6자로 막지 않는다.
   */
  import { Button, TextInput } from '#lib/ui';
  import AuthField from '#lib/shell/AuthField.svelte';
  import AuthError from '#lib/shell/AuthError.svelte';
  import { accountApi } from './api';

  /** `idp` — IdP OTP 대상이면 IdP 호스트. 그 IdP 에 등록한 인증 앱의 코드를 받는다(복구 코드는 그대로 여기 것). */
  let { onDone, onRestart, idp }: { onDone: () => void; onRestart: () => void; idp?: string | undefined } = $props();
  const help = $derived(idp === undefined
    ? '인증 앱의 코드를 입력해요. 앱이 없으면 복구 코드를 넣어요.'
    : `${idp} 에 등록한 인증 앱의 코드를 입력해요. 앱이 없으면 복구 코드를 넣어요.`);

  let code = $state('');
  let busy = $state(false);
  let error = $state<string | undefined>();

  const submit = async (): Promise<void> => {
    if (code.trim() === '') { error = '숫자 6자리를 입력해요.'; return; }
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

<form class="step" novalidate onsubmit={(e) => { e.preventDefault(); void submit(); }}>
  <AuthField label="인증 코드 6자리" for="lg-code" code {help}>
    <TextInput id="lg-code" inputmode="numeric" autocomplete="one-time-code" bind:value={code}
      invalid={error !== undefined} oninput={() => { error = undefined; }} />
  </AuthField>
  {#if error !== undefined}<AuthError>{error}</AuthError>{/if}
  <Button variant="primary" type="submit" loading={busy} style="width: 100%; height: 36px; font-size: 14px">로그인</Button>
  <Button variant="text" onclick={onRestart} style="width: 100%; height: 28px; color: var(--tx2); font-size: 13px; font-weight: 400">← 처음으로</Button>
</form>

<style>
  .step { display: flex; flex-direction: column; gap: 14px; }
</style>
