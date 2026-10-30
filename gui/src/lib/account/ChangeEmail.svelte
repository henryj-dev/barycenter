<script lang="ts">
  /** 새 주소로 확인 메일 — 확인 전까지 주소는 그대로다. 메일이 꺼진 배포면 그리지 않는다(부모가 고른다). */
  import { Button, Card, FieldMessage, Form, FormRow, FormSection, TextInput } from '#lib/ui';
  import { accountApi } from './api';

  let email = $state('');
  let password = $state('');
  let busy = $state(false);
  let note = $state<{ ok: boolean; text: string } | undefined>();

  const submit = async (): Promise<void> => {
    if (email.trim() === '' || password === '') return;
    busy = true;
    const r = await accountApi.changeEmail(email, password);
    busy = false;
    password = '';
    note = r.ok
      ? { ok: true, text: `${email} 로 확인 메일을 보냈어요. 그 링크를 열어야 바뀌어요.` }
      : { ok: false, text: r.message };
  };
</script>

<Card title="이메일">
  <Form onsubmit={() => { void submit(); }}>
    <FormSection>
      <FormRow label="새 이메일" for="ce-mail" required>
        <TextInput id="ce-mail" type="email" autocomplete="email" bind:value={email} required />
      </FormRow>
      <FormRow label="비밀번호 확인" for="ce-pass" required>
        <TextInput id="ce-pass" type="password" autocomplete="current-password" mono={false} bind:value={password} required />
      </FormRow>
    </FormSection>
    {#snippet actions()}
      <Button variant="primary" type="submit" loading={busy}>확인 메일 받기</Button>
      {#if note !== undefined}<FieldMessage tone={note.ok ? 'ok' : 'error'}>{note.text}</FieldMessage>{/if}
    {/snippet}
  </Form>
</Card>
