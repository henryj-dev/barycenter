<script lang="ts">
  /** 새 이메일 확인 — 새 주소로 간 링크를 열면 바뀐다. 다른 기기에서 열어도 된다(로그인 불필요). */
  import { onMount } from 'svelte';
  import { accountApi } from '#lib/account/api';
  import { Banner, Button, Spinner } from '#lib/ui';

  let note = $state<{ ok: boolean; text: string } | undefined>();

  onMount(async () => {
    const token = location.hash.replace(/^#/, '');
    if (token === '') { note = { ok: false, text: '링크에 토큰이 없어요. 메일의 링크를 다시 열어요.' }; return; }
    const r = await accountApi.confirmEmail(token);
    history.replaceState(null, '', '/email');
    note = r.ok ? { ok: true, text: '이메일을 바꿨어요.' } : { ok: false, text: r.message };
  });
</script>

<div class="std">
  <div class="head">
    <h1>이메일 확인</h1>
    <p>새 주소로 간 링크를 열면 바뀌어요.</p>
  </div>
  {#if note === undefined}
    <p class="wait"><Spinner /> 확인하는 중이에요.</p>
  {:else}
    <Banner tone={note.ok ? 'ok' : 'danger'}>{note.text}</Banner>
  {/if}
  <div><Button href="/account">내 계정으로 가기</Button></div>
</div>

<style>
  .std { display: grid; gap: 12px; }
  .head { display: grid; gap: 4px; }
  h1 { font: var(--t-title); margin: 0; }
  .head p { margin: 0; color: var(--tx2); font: var(--t-small); }
  .wait { margin: 0; display: flex; gap: 8px; align-items: center; font: var(--t-small); color: var(--tx2); }
</style>
