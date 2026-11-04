<script lang="ts">
  /**
   * 새 주소로 확인 메일 — 확인 전까지 주소는 그대로다. 메일이 꺼진 배포면 그리지 않는다(부모가 고른다).
   * 시안에 없는 카드라 시안의 「비밀번호」 카드와 같은 모양(카드 안 제목 · 라벨 150px 격자 · 버튼)으로 둔다.
   */
  import { Button, Card, FieldMessage, TextInput } from '#lib/ui';
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

<Card>
  <form class="em" novalidate onsubmit={(e) => { e.preventDefault(); void submit(); }}>
    <div class="t">이메일</div>
    <div class="grid">
      <label for="ce-mail">새 이메일</label>
      <TextInput id="ce-mail" type="email" autocomplete="email" bind:value={email} />
      <label for="ce-pass">비밀번호 확인</label>
      <TextInput id="ce-pass" type="password" autocomplete="current-password" mono={false} bind:value={password} />
    </div>
    {#if note !== undefined}<FieldMessage tone={note.ok ? 'ok' : 'error'}>{note.text}</FieldMessage>{/if}
    <div><Button variant="primary" type="submit" loading={busy} disabled={email.trim() === '' || password === ''}>확인 메일 받기</Button></div>
  </form>
</Card>

<style>
  .em { display: flex; flex-direction: column; gap: 12px; }
  .t { font-weight: 600; font-size: 14px; }
  .grid { display: grid; grid-template-columns: 150px minmax(0, 360px); gap: 10px 16px; align-items: center; }
  label { font-size: 13px; color: var(--tx2); }
  .em :global(.msg) { margin-top: 0; }
  @media (max-width: 720px) { .grid { grid-template-columns: minmax(0, 1fr); gap: 4px; } }
</style>
