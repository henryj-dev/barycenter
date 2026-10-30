<script lang="ts">
  /** 인증 앱 등록 · 해제 · 복구 코드 재발급. **관리자는 해제할 수 없다**(서버가 409 로 막는다 — 버튼도 안 그린다). */
  import { Badge, Button, Card, FieldMessage, FormRow, FormSection, TextInput } from '#lib/ui';
  import { accountApi, type Me } from './api';
  import TotpSetup from './TotpSetup.svelte';
  import RecoveryCodes from './RecoveryCodes.svelte';

  let { me, onChanged }: { me: Me; onChanged: () => Promise<void> } = $props();

  let pending = $state<{ secret: string; uri: string } | undefined>();
  let code = $state('');
  let password = $state('');
  let codes = $state<string[] | undefined>();
  let error = $state<string | undefined>();
  let busy = $state(false);

  const run = async (f: () => Promise<void>): Promise<void> => { busy = true; error = undefined; try { await f(); } finally { busy = false; } };
  const begin = (): Promise<void> => run(async () => {
    const r = await accountApi.beginTotp();
    if (r.ok) pending = r.data; else error = r.message;
  });
  const confirm = (): Promise<void> => run(async () => {
    const r = await accountApi.confirmTotp(code);
    code = '';
    if (!r.ok) { error = r.message; return; }
    pending = undefined;
    codes = r.data.recoveryCodes;
    await onChanged();
  });
  const remove = (): Promise<void> => run(async () => {
    const r = await accountApi.removeTotp(password);
    password = '';
    if (!r.ok) { error = r.message; return; }
    await onChanged();
  });
  const regenerate = (): Promise<void> => run(async () => {
    const r = await accountApi.recoveryCodes(password);
    password = '';
    if (r.ok) codes = r.data.recoveryCodes; else error = r.message;
    await onChanged();
  });
</script>

<Card title="인증 앱 (TOTP)">
  {#snippet actions()}
    {#if me.mfa.totp}<Badge tone="ok">등록됨</Badge>{:else}<Badge>등록 안 됨</Badge>{/if}
  {/snippet}
  <div class="tm">
    {#if codes !== undefined}<RecoveryCodes {codes} />{/if}
    {#if me.mfa.totp}
      <FieldMessage>남은 복구 코드 {me.mfa.recoveryCodesLeft}개. 복구 코드를 새로 받거나 등록을 풀려면 비밀번호를 넣어요.</FieldMessage>
      <FormSection>
        <FormRow label="비밀번호 확인" for="tm-pass">
          <TextInput id="tm-pass" type="password" autocomplete="current-password" mono={false} bind:value={password} />
        </FormRow>
      </FormSection>
      <div class="row">
        <Button disabled={password === ''} loading={busy} onclick={() => { void regenerate(); }}>복구 코드 새로 받기</Button>
        {#if me.role !== 'admin'}<Button variant="danger" disabled={password === '' || busy} onclick={() => { void remove(); }}>등록 해제</Button>{/if}
      </div>
    {:else if pending !== undefined}
      <form class="tm" onsubmit={(e) => { e.preventDefault(); void confirm(); }}>
        <TotpSetup secret={pending.secret} uri={pending.uri} bind:code />
        <div><Button variant="primary" type="submit" loading={busy}>등록 확인</Button></div>
      </form>
    {:else}
      <FieldMessage>등록하면 로그인할 때 6자리 코드를 같이 넣어요.</FieldMessage>
      <div><Button variant="primary" loading={busy} onclick={() => { void begin(); }}>등록 시작</Button></div>
    {/if}
    {#if error !== undefined}<FieldMessage tone="error">{error}</FieldMessage>{/if}
  </div>
</Card>

<style>
  .tm { display: grid; gap: 12px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
</style>
