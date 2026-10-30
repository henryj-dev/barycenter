<script lang="ts">
  /** 로그인 첫 단계 — 비밀번호가 맞으면 다음 단계를 알린다(관리자·인증 앱 등록자는 `mfa`). */
  import { Button, FieldMessage, FormRow, FormSection, TextInput } from '#lib/ui';
  import { accountApi } from './api';

  let { onDone }: { onDone: (next: 'ok' | 'mfa') => void } = $props();

  let username = $state('');
  let password = $state('');
  let busy = $state(false);
  let error = $state<string | undefined>();

  const submit = async (): Promise<void> => {
    if (username.trim() === '' || password === '') return;
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

<form class="step" onsubmit={(e) => { e.preventDefault(); void submit(); }}>
  <FormSection stack>
    <FormRow label="아이디 또는 이메일" for="lg-user">
      <TextInput id="lg-user" autocomplete="username" mono={false} bind:value={username} required />
    </FormRow>
    <FormRow label="비밀번호" for="lg-pass">
      <TextInput id="lg-pass" type="password" autocomplete="current-password" mono={false} bind:value={password} required />
    </FormRow>
  </FormSection>
  <div><Button variant="primary" type="submit" loading={busy}>로그인</Button></div>
  {#if error !== undefined}<FieldMessage tone="error">{error}</FieldMessage>{/if}
</form>

<style>
  .step { display: grid; gap: 12px; }
</style>
