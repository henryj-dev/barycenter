<script lang="ts">
  /**
   * 비밀번호 재설정. 주소에 `#토큰` 이 있으면 새 비밀번호를 정하고, 없으면 메일을 요청한다.
   * 요청 결과는 **언제나 같은 문장**이다 — 그 주소에 계정이 있는지 화면이 말하지 않는다.
   * 재설정은 인증 앱을 풀지 않는다(관리자는 로그인 때 코드가 그대로 필요하다).
   */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { accountApi } from '#lib/account/api';
  import { PASSWORD_HELP } from '#lib/account/text';
  import { Button, TextInput, toast } from '#lib/ui';
  import AuthCard from '#lib/shell/AuthCard.svelte';
  import AuthField from '#lib/shell/AuthField.svelte';
  import AuthError from '#lib/shell/AuthError.svelte';

  let token = $state('');
  let email = $state('');
  let password = $state('');
  let confirm = $state('');
  let note = $state<{ ok: boolean; text: string } | undefined>();
  let busy = $state(false);
  const matches = $derived(password !== '' && password === confirm);
  const mismatch = $derived(confirm !== '' && !matches);

  onMount(() => { token = location.hash.replace(/^#/, ''); });

  const request = async (): Promise<void> => {
    if (email.trim() === '') { note = { ok: false, text: '이메일을 입력해요.' }; return; }
    busy = true;
    const r = await accountApi.requestReset(email);
    busy = false;
    note = r.ok || r.status === 202
      ? { ok: true, text: '그 주소가 계정에 묶여 있으면 재설정 링크를 보냈어요. 30분 안에 메일함을 봐요.' }
      : { ok: false, text: r.message };
  };
  const reset = async (): Promise<void> => {
    if (password === '') { note = { ok: false, text: '비밀번호를 입력해요.' }; return; }
    if (!matches) { note = { ok: false, text: '비밀번호가 서로 달라요. 같은 값을 두 번 입력해요.' }; return; }
    busy = true;
    const r = await accountApi.confirmReset(token, password);
    busy = false;
    if (!r.ok) { note = { ok: false, text: r.message }; return; }
    history.replaceState(null, '', '/reset');
    token = '';
    note = undefined;
    // 시안: 바꾸면 토스트를 띄우고 로그인으로 간다. 열려 있던 세션은 서버가 모두 끊었다.
    toast.ok('비밀번호를 바꿨어요', '새 비밀번호로 로그인해요.');
    await goto('/login');
  };
</script>

<!--
  시안 Login(lMode reset): 1단계 「비밀번호 재설정」(칸 하나 · 「링크 보내기」), 2단계 「새 비밀번호 설정」(새 비밀번호 · 확인 ·
  「비밀번호 변경」 · 「← 처음으로」), 카드 밖 「← 로그인으로」. 링크는 메일로 가므로 칸은 아이디가 아니라 계정 이메일이다.
-->
{#snippet back()}<a href="/login">← 로그인으로</a>{/snippet}
{#if token !== ''}
  <AuthCard title="새 비밀번호 설정" sub="새 비밀번호를 두 번 입력해요." links={back}>
    <form class="std" novalidate onsubmit={(e) => { e.preventDefault(); void reset(); }}>
      <AuthField label="새 비밀번호" for="lg-pw" help={PASSWORD_HELP}>
        <TextInput id="lg-pw" type="password" autocomplete="new-password" mono={false} bind:value={password}
          invalid={(note !== undefined && !note.ok) || mismatch} oninput={() => { note = undefined; }} />
      </AuthField>
      <AuthField label="비밀번호 확인" for="lg-pw2">
        <TextInput id="lg-pw2" type="password" autocomplete="new-password" mono={false} bind:value={confirm}
          invalid={(note !== undefined && !note.ok) || mismatch} oninput={() => { note = undefined; }} />
      </AuthField>
      {#if note !== undefined && !note.ok}<AuthError>{note.text}</AuthError>{/if}
      <Button variant="primary" type="submit" loading={busy} style="width: 100%; height: 36px; font-size: 14px">비밀번호 변경</Button>
      <Button variant="text" onclick={() => { token = ''; note = undefined; history.replaceState(null, '', '/reset'); }} style="width: 100%; height: 28px; color: var(--tx2); font-size: 13px; font-weight: 400">← 처음으로</Button>
    </form>
  </AuthCard>
{:else}
  <AuthCard title="비밀번호 재설정" sub="계정 이메일을 입력하면 재설정 링크를 보내 줘요." links={back}>
    {#if note !== undefined && note.ok}
      <!-- 결과는 언제나 같은 문장이다 — 그 주소에 계정이 있는지 말하지 않는다. -->
      <p class="sent" role="status">✓ {note.text}</p>
    {:else}
      <form class="std" novalidate onsubmit={(e) => { e.preventDefault(); void request(); }}>
        <AuthField label="계정 이메일" for="lg-id">
          <TextInput id="lg-id" type="email" autocomplete="email" bind:value={email} invalid={note !== undefined} oninput={() => { note = undefined; }} />
        </AuthField>
        {#if note !== undefined}<AuthError>{note.text}</AuthError>{/if}
        <Button variant="primary" type="submit" loading={busy} style="width: 100%; height: 36px; font-size: 14px">링크 보내기</Button>
      </form>
    {/if}
  </AuthCard>
{/if}

<style>
  .std { display: flex; flex-direction: column; gap: 14px; }
  .sent { margin: 0; font-size: 13px; color: var(--ok); }
</style>
