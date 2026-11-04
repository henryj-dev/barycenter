<script lang="ts">
  /**
   * 비밀번호 바꾸기. 바꾸면 이 기기 말고 다른 세션은 모두 끊긴다(서버).
   * 시안(Account · 비밀번호 카드): 카드 안 제목 · 라벨 150px 격자(현재 · 새 · 새 확인) · 오류 한 줄 · 「비밀번호 변경」.
   * 누르면 화면이 먼저 본다(빈 칸 · 8자 · 두 칸이 같은가) — 확인 칸은 화면만 본다. 서버에는 전과 같이 둘만 간다.
   * 나머지 규칙(종류)은 서버가 진다. 서버가 거절한 문장은 그대로 보인다. 성공은 토스트만 띄운다(시안).
   */
  import { Button, Card, FieldMessage, TextInput, toast } from '#lib/ui';
  import { accountApi } from './api';

  let current = $state('');
  let next = $state('');
  let again = $state('');
  let busy = $state(false);
  let error = $state<string | undefined>();

  const submit = async (): Promise<void> => {
    if (current === '') { error = '현재 비밀번호를 입력해요.'; return; }
    if (next.length < 8) { error = '비밀번호는 8자 이상이어야 해요.'; return; }
    if (next !== again) { error = '비밀번호가 서로 달라요. 같은 값을 두 번 입력해요.'; return; }
    busy = true;
    const r = await accountApi.changePassword(current, next);
    busy = false;
    current = '';
    next = '';
    again = '';
    error = r.ok ? undefined : r.message;
    if (r.ok) toast.ok('비밀번호를 바꿨어요', '다른 세션은 로그아웃해요.');
  };
  const clear = (): void => { error = undefined; };
</script>

<Card>
  <form class="pw" novalidate onsubmit={(e) => { e.preventDefault(); void submit(); }}>
    <div class="t">비밀번호</div>
    <div class="grid">
      <label for="ac-cur">현재 비밀번호</label>
      <TextInput id="ac-cur" type="password" autocomplete="current-password" mono={false} bind:value={current} invalid={error !== undefined} oninput={clear} />
      <label for="ac-n1">새 비밀번호</label>
      <TextInput id="ac-n1" type="password" autocomplete="new-password" mono={false} bind:value={next} invalid={error !== undefined} oninput={clear} />
      <label for="ac-n2">새 비밀번호 확인</label>
      <TextInput id="ac-n2" type="password" autocomplete="new-password" mono={false} bind:value={again} invalid={error !== undefined} oninput={clear} />
    </div>
    {#if error !== undefined}<FieldMessage tone="error">{error}</FieldMessage>{/if}
    <div><Button variant="primary" type="submit" loading={busy}>비밀번호 변경</Button></div>
  </form>
</Card>

<style>
  .pw { display: flex; flex-direction: column; gap: 12px; }
  .t { font-weight: 600; font-size: 14px; }
  .grid { display: grid; grid-template-columns: 150px minmax(0, 360px); gap: 10px 16px; align-items: center; }
  label { font-size: 13px; color: var(--tx2); }
  .pw :global(.msg) { margin-top: 0; }
  @media (max-width: 720px) { .grid { grid-template-columns: minmax(0, 1fr); gap: 4px; } }
</style>
