<script lang="ts">
  /**
   * 로그인 첫 단계 — 비밀번호가 맞으면 다음 단계를 알린다(관리자·인증 앱 등록자는 `mfa`).
   * 시안: 오류는 칸 아래에 둔다. 빈 칸은 그 칸에, 서버가 거절한 문장은 비밀번호 칸에 붙인다
   * (서버는 아이디와 비밀번호 중 무엇이 틀렸는지 말하지 않는다).
   */
  import { Button, FormRow, FormSection, TextInput } from '#lib/ui';
  import { accountApi } from './api';

  let { onDone }: { onDone: (next: 'ok' | 'mfa') => void } = $props();

  let username = $state('');
  let password = $state('');
  let busy = $state(false);
  let error = $state<string | undefined>();
  let missing = $state<'username' | 'password' | undefined>();

  const submit = async (): Promise<void> => {
    missing = username.trim() === '' ? 'username' : password === '' ? 'password' : undefined;
    if (missing !== undefined) { error = undefined; return; }
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

<form class="step" novalidate onsubmit={(e) => { e.preventDefault(); void submit(); }}>
  <FormSection stack>
    <FormRow label="아이디 또는 이메일" for="lg-user" error={missing === 'username' ? '아이디를 입력해요.' : undefined}>
      <TextInput id="lg-user" autocomplete="username" mono={false} bind:value={username} invalid={missing === 'username'}
        oninput={() => { if (missing === 'username') missing = undefined; }} required />
    </FormRow>
    <FormRow label="비밀번호" for="lg-pass" error={missing === 'password' ? '비밀번호를 입력해요.' : error}>
      <TextInput id="lg-pass" type="password" autocomplete="current-password" mono={false} bind:value={password}
        invalid={missing === 'password' || error !== undefined} oninput={() => { missing = undefined; error = undefined; }} required />
    </FormRow>
  </FormSection>
  <Button variant="primary" type="submit" loading={busy} style="width: 100%">로그인</Button>
</form>

<style>
  .step { display: grid; gap: 12px; }
</style>
