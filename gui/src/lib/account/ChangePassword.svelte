<script lang="ts">
  /**
   * 비밀번호 바꾸기. 바꾸면 이 기기 말고 다른 세션은 모두 끊긴다(서버).
   * 시안: 현재 · 새 · 새 확인 세 칸, 칸 아래 오류. 확인 칸은 화면만 본다(오타를 막는다) — 서버에는 전과 같이 둘만 간다.
   * 규칙(길이 · 종류)은 서버가 진다. 서버가 거절한 문장은 그대로 보인다.
   */
  import { Button, Card, FieldMessage, Form, FormRow, FormSection, TextInput, toast } from '#lib/ui';
  import { accountApi } from './api';
  import { PASSWORD_HELP } from './text';

  let current = $state('');
  let next = $state('');
  let again = $state('');
  let busy = $state(false);
  let note = $state<{ ok: boolean; text: string } | undefined>();

  const mismatch = $derived(again !== '' && again !== next ? '비밀번호가 서로 달라요. 같은 값을 두 번 입력해요.' : undefined);

  const submit = async (): Promise<void> => {
    if (current === '' || next === '' || again !== next) return;
    busy = true;
    const r = await accountApi.changePassword(current, next);
    busy = false;
    current = '';
    next = '';
    again = '';
    note = r.ok ? { ok: true, text: '바꿨어요. 이 기기 말고 다른 세션은 모두 끊겼어요.' } : { ok: false, text: r.message };
    if (r.ok) toast.ok('비밀번호를 바꿨어요', '다른 세션은 로그아웃했어요.');
  };
</script>

<Card title="비밀번호">
  <Form onsubmit={() => { void submit(); }}>
    <FormSection>
      <FormRow label="현재 비밀번호" for="cp-cur" required>
        <TextInput id="cp-cur" type="password" autocomplete="current-password" mono={false} bind:value={current} required />
      </FormRow>
      <FormRow label="새 비밀번호" for="cp-new" required help={PASSWORD_HELP}>
        <TextInput id="cp-new" type="password" autocomplete="new-password" mono={false} bind:value={next} required />
      </FormRow>
      <FormRow label="새 비밀번호 확인" for="cp-again" required error={mismatch}>
        <TextInput id="cp-again" type="password" autocomplete="new-password" mono={false} bind:value={again} invalid={mismatch !== undefined} required />
      </FormRow>
    </FormSection>
    {#snippet actions()}
      <Button variant="primary" type="submit" loading={busy} disabled={current === '' || next === '' || again !== next}>비밀번호 변경</Button>
      {#if note !== undefined}<FieldMessage tone={note.ok ? 'ok' : 'error'}>{note.text}</FieldMessage>{/if}
    {/snippet}
  </Form>
</Card>
