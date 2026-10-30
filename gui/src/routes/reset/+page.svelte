<script lang="ts">
  /**
   * 비밀번호 재설정. 주소에 `#토큰` 이 있으면 새 비밀번호를 정하고, 없으면 메일을 요청한다.
   * 요청 결과는 **언제나 같은 문장**이다 — 그 주소에 계정이 있는지 화면이 말하지 않는다.
   * 재설정은 인증 앱을 풀지 않는다(관리자는 로그인 때 코드가 그대로 필요하다).
   */
  import { onMount } from 'svelte';
  import { accountApi } from '#lib/account/api';
  import { PASSWORD_HELP } from '#lib/account/text';
  import { Banner, Button, FormRow, FormSection, TextInput } from '#lib/ui';

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
    if (email.trim() === '') return;
    busy = true;
    const r = await accountApi.requestReset(email);
    busy = false;
    note = r.ok || r.status === 202
      ? { ok: true, text: '그 주소가 계정에 묶여 있으면 재설정 링크를 보냈어요. 30분 안에 메일함을 봐요.' }
      : { ok: false, text: r.message };
  };
  const reset = async (): Promise<void> => {
    if (!matches) return;
    busy = true;
    const r = await accountApi.confirmReset(token, password);
    busy = false;
    if (!r.ok) { note = { ok: false, text: r.message }; return; }
    history.replaceState(null, '', '/reset');
    token = '';
    note = { ok: true, text: '바꿨어요. 열려 있던 세션은 모두 끊겼어요. 다시 로그인해요.' };
  };
</script>

<div class="std">
  {#if token !== ''}
    <form class="std" onsubmit={(e) => { e.preventDefault(); void reset(); }}>
      <FormSection stack>
        <FormRow label="새 비밀번호" for="rs-pass" help={PASSWORD_HELP}>
          <TextInput id="rs-pass" type="password" autocomplete="new-password" mono={false} bind:value={password} required />
        </FormRow>
        <FormRow label="새 비밀번호 확인" for="rs-conf" error={mismatch ? '두 비밀번호가 달라요.' : undefined}>
          <TextInput id="rs-conf" type="password" autocomplete="new-password" mono={false} bind:value={confirm} invalid={mismatch} required />
        </FormRow>
      </FormSection>
      <div><Button variant="primary" type="submit" loading={busy} disabled={!matches}>바꾸기</Button></div>
    </form>
  {:else if note === undefined || !note.ok}
    <form class="std" onsubmit={(e) => { e.preventDefault(); void request(); }}>
      <FormSection stack>
        <FormRow label="계정 이메일" for="rs-mail">
          <TextInput id="rs-mail" type="email" autocomplete="email" bind:value={email} required />
        </FormRow>
      </FormSection>
      <div><Button variant="primary" type="submit" loading={busy}>재설정 링크 받기</Button></div>
    </form>
  {/if}
  {#if note !== undefined}<Banner tone={note.ok ? 'ok' : 'danger'}>{note.text}</Banner>{/if}
  <a href="/login">← 로그인으로</a>
</div>

<style>
  .std { display: grid; gap: 12px; }
  a { color: var(--accent); font: var(--t-small); }
</style>
