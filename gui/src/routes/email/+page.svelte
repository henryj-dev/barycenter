<script lang="ts">
  /** 새 이메일 확인 — 새 주소로 간 링크를 열면 바뀐다. 다른 기기에서 열어도 된다(로그인 불필요). */
  import { onMount } from 'svelte';
  import { accountApi } from '$lib/account/api';

  let note = $state<{ ok: boolean; text: string } | undefined>();

  onMount(async () => {
    const token = location.hash.replace(/^#/, '');
    if (token === '') { note = { ok: false, text: '링크에 토큰이 없다' }; return; }
    const r = await accountApi.confirmEmail(token);
    history.replaceState(null, '', '/email');
    note = r.ok ? { ok: true, text: '이메일을 바꿨다.' } : { ok: false, text: r.message };
  });
</script>

<p class:err={note !== undefined && !note.ok} role="status">{note?.text ?? '확인하는 중…'}</p>
<p><a href="/account">내 계정</a></p>

<style>
  p { margin: 1rem 0 0; }
  .err { color: var(--ember); }
</style>
