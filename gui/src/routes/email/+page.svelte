<script lang="ts">
  /** 새 이메일 확인 — 새 주소로 간 링크를 열면 바뀐다. 다른 기기에서 열어도 된다(로그인 불필요). */
  import { onMount } from 'svelte';
  import { accountApi } from '#lib/account/api';
  import { Button, Spinner } from '#lib/ui';
  import AuthCard from '#lib/shell/AuthCard.svelte';
  import AuthError from '#lib/shell/AuthError.svelte';

  let note = $state<{ ok: boolean; text: string } | undefined>();

  onMount(async () => {
    const token = location.hash.replace(/^#/, '');
    if (token === '') { note = { ok: false, text: '링크에 토큰이 없어요. 메일의 링크를 다시 열어요.' }; return; }
    const r = await accountApi.confirmEmail(token);
    history.replaceState(null, '', '/email');
    note = r.ok ? { ok: true, text: '이메일을 바꿨어요.' } : { ok: false, text: r.message };
  });
</script>

<!-- 시안에 없는 화면 — 다른 혼자 서는 화면(시안 Login)과 같은 카드 · 링크 줄로 둔다. -->
<AuthCard title="이메일 확인" sub="새 주소로 간 링크를 열면 바뀌어요.">
  {#if note === undefined}
    <p class="msg"><Spinner /> 확인하는 중이에요.</p>
  {:else if note.ok}
    <p class="msg ok" role="status">✓ {note.text}</p>
  {:else}
    <AuthError>{note.text}</AuthError>
  {/if}
  <div class="full"><Button variant="primary" href="/account">내 계정으로 가기</Button></div>
  {#snippet links()}<a href="/login">← 로그인으로</a>{/snippet}
</AuthCard>

<style>
  /* 링크 버튼(href)에는 style 이 안 붙는다 — 감싸서 시안의 36px 전체 폭 버튼으로 맞춘다. */
  .full { display: flex; }
  .full :global(.btn) { flex: 1; height: 36px; font-size: 14px; }
  .msg { margin: 0; display: flex; gap: 8px; align-items: center; font-size: 13px; color: var(--tx2); }
  .msg.ok { color: var(--ok); }
</style>
