<script lang="ts">
  /**
   * 로그인 첫 단계 — 비밀번호가 맞으면 다음 단계를 알린다(관리자·인증 앱 등록자는 `mfa`).
   * 시안(Login · lMode login, 1단계): 아이디 · 비밀번호 두 칸, 오류는 제출 버튼 위 한 줄(`✕ …`), 버튼은 「계속」.
   * 빈 칸이면 「아이디와 비밀번호를 입력해요.」 와 함께 빈 칸의 테두리를, 서버가 거절했으면 비밀번호 칸의 테두리를 붉힌다
   * (서버는 아이디와 비밀번호 중 무엇이 틀렸는지 말하지 않는다).
   */
  import { Button, TextInput } from '#lib/ui';
  import AuthField from '#lib/shell/AuthField.svelte';
  import AuthError from '#lib/shell/AuthError.svelte';
  import { accountApi } from './api';

  /** `idp` — 둘째 인증이 IdP OTP 면 그 IdP 호스트(다음 단계의 안내 문구). */
  let { onDone }: { onDone: (next: 'ok' | 'mfa', idp?: string) => void } = $props();

  let username = $state('');
  let password = $state('');
  let busy = $state(false);
  let error = $state<string | undefined>();
  /** 빈 칸으로 냈다 — 빈 칸만 붉힌다. 서버 거절이면 거짓. */
  let missing = $state(false);

  const submit = async (): Promise<void> => {
    if (username.trim() === '' || password === '') { missing = true; error = '아이디와 비밀번호를 입력해요.'; return; }
    missing = false;
    busy = true;
    error = undefined;
    const r = await accountApi.login(username, password);
    busy = false;
    password = '';
    if (!r.ok) {
      error = r.message;
      return;
    }
    if (r.data.status === 'mfa_required') onDone('mfa', r.data.method === 'idp' ? r.data.idp : undefined);
    else onDone('ok');
  };
  const clear = (): void => { error = undefined; missing = false; };
</script>

<form class="step" novalidate onsubmit={(e) => { e.preventDefault(); void submit(); }}>
  <!-- 서버는 아이디와 이메일을 둘 다 받는다 — 라벨이 그렇게 말한다. -->
  <AuthField label="아이디 또는 이메일" for="lg-id">
    <TextInput id="lg-id" autocomplete="username" mono={false} bind:value={username}
      invalid={error !== undefined && missing && username.trim() === ''} oninput={clear} />
  </AuthField>
  <AuthField label="비밀번호" for="lg-pw">
    <TextInput id="lg-pw" type="password" autocomplete="current-password" mono={false} bind:value={password}
      invalid={error !== undefined && (!missing || password === '')} oninput={clear} />
  </AuthField>
  {#if error !== undefined}<AuthError>{error}</AuthError>{/if}
  <Button variant="primary" type="submit" loading={busy} style="width: 100%; height: 36px; font-size: 14px">계속</Button>
</form>

<style>
  .step { display: flex; flex-direction: column; gap: 14px; }
</style>
