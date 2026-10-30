<script lang="ts">
  /** 비밀번호 바꾸기. 바꾸면 이 기기 말고 다른 세션은 모두 끊긴다(서버). */
  import { Button, Card, FieldMessage, Form, FormRow, FormSection, TextInput } from '#lib/ui';
  import { accountApi } from './api';
  import { PASSWORD_HELP } from './text';

  let current = $state('');
  let next = $state('');
  let busy = $state(false);
  let note = $state<{ ok: boolean; text: string } | undefined>();

  const submit = async (): Promise<void> => {
    if (current === '' || next === '') return;
    busy = true;
    const r = await accountApi.changePassword(current, next);
    busy = false;
    current = '';
    next = '';
    note = r.ok ? { ok: true, text: '바꿨어요. 이 기기 말고 다른 세션은 모두 끊겼어요.' } : { ok: false, text: r.message };
  };
</script>

<Card title="비밀번호">
  <Form onsubmit={() => { void submit(); }}>
    <FormSection>
      <FormRow label="지금 비밀번호" for="cp-cur" required>
        <TextInput id="cp-cur" type="password" autocomplete="current-password" mono={false} bind:value={current} required />
      </FormRow>
      <FormRow label="새 비밀번호" for="cp-new" required help={PASSWORD_HELP}>
        <TextInput id="cp-new" type="password" autocomplete="new-password" mono={false} bind:value={next} required />
      </FormRow>
    </FormSection>
    {#snippet actions()}
      <Button variant="primary" type="submit" loading={busy}>바꾸기</Button>
      {#if note !== undefined}<FieldMessage tone={note.ok ? 'ok' : 'error'}>{note.text}</FieldMessage>{/if}
    {/snippet}
  </Form>
</Card>
