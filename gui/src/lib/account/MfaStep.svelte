<script lang="ts">
  /**
   * 로그인 둘째 단계 — 인증 앱 6자리 코드 또는 복구 코드(xxxx-xxxx). 5분 안에 넣어야 한다.
   * 시안: 오류는 코드 칸 아래에, 「← 처음으로」 로 첫 단계로 돌아간다.
   */
  import { Button, FormRow, FormSection, TextInput } from '#lib/ui';
  import { accountApi } from './api';

  let { onDone, onRestart }: { onDone: () => void; onRestart: () => void } = $props();

  let code = $state('');
  let busy = $state(false);
  let error = $state<string | undefined>();

  const submit = async (): Promise<void> => {
    if (code.trim() === '') { error = '코드를 입력해요.'; return; }
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
  <FormSection stack>
    <FormRow label="인증 코드" for="lg-code" error={error} help="인증 앱의 6자리 코드를 넣어요. 앱이 없으면 복구 코드를 넣어요.">
      <TextInput id="lg-code" inputmode="numeric" autocomplete="one-time-code" bind:value={code} width="200px"
        invalid={error !== undefined} oninput={() => { error = undefined; }} required />
    </FormRow>
  </FormSection>
  <Button variant="primary" type="submit" loading={busy} style="width: 100%">로그인</Button>
  <div><Button variant="text" onclick={onRestart}>← 처음으로</Button></div>
</form>

<style>
  .step { display: grid; gap: 12px; }
</style>
