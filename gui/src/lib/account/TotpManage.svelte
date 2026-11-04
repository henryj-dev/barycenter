<script lang="ts">
  /**
   * 인증 앱 등록 · 해제 · 복구 코드 재발급. **관리자는 해제할 수 없다**(서버가 409 로 막는다 — 버튼도 안 그린다).
   * 시안: 「인증 앱」 카드와 「복구 코드」 카드를 나눈다. 두 작업 모두 비밀번호를 다시 넣는다 — 칸은 카드마다 하나다.
   * 복구 코드는 만든 순간 한 번만 보인다(서버에는 해시만 있다). 시안의 「코드 보기」 는 그래서 없다.
   * 「새로 만들기」 는 시안대로 확인 대화상자(「복구 코드가 모두 바뀌어요」 · 확인 체크)를 거친다. 그 뒤의 서버
   * 요청(비밀번호 · 민감 작업 step-up)은 전과 같다.
   */
  import { Badge, Button, Card, ConfirmDialog, FieldMessage, FormRow, FormSection, TextInput, toast } from '#lib/ui';
  import { accountApi, type Me } from './api';
  import TotpSetup from './TotpSetup.svelte';
  import RecoveryCodes from './RecoveryCodes.svelte';

  let { me, onChanged }: { me: Me; onChanged: () => Promise<void> } = $props();

  let pending = $state<{ secret: string; uri: string } | undefined>();
  let code = $state('');
  let password = $state('');
  /** 복구 코드 카드의 비밀번호 칸 — 인증 앱 카드의 칸과 따로 둔다. */
  let codePassword = $state('');
  let codeError = $state<string | undefined>();
  let codes = $state<string[] | undefined>();
  let error = $state<string | undefined>();
  let busy = $state(false);
  let asking = $state(false);

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
    codeError = undefined;
    const r = await accountApi.recoveryCodes(codePassword);
    codePassword = '';
    if (r.ok) { codes = r.data.recoveryCodes; toast.ok('복구 코드를 새로 만들었어요', '새 코드는 지금 한 번만 보여요.'); } else codeError = r.message;
    await onChanged();
  });
</script>

<Card title="인증 앱" sub="로그인할 때 6자리 코드를 써요.">
  {#snippet actions()}
    {#if me.mfa.totp}<Badge tone="ok" icon="●">등록됨</Badge>{:else}<Badge tone="warn" icon="▲">등록 안 됨</Badge>{/if}
  {/snippet}
  <div class="tm">
    {#if me.mfa.totp}
      {#if me.role === 'admin'}
        <FieldMessage>관리자는 인증 앱을 풀 수 없어요.</FieldMessage>
      {:else}
        <FormSection>
          <FormRow label="비밀번호 확인" for="tm-pass" help="등록을 풀려면 비밀번호를 넣어요.">
            <TextInput id="tm-pass" type="password" autocomplete="current-password" mono={false} bind:value={password} />
          </FormRow>
        </FormSection>
        <div class="row">
          <Button variant="danger" disabled={password === '' || busy} onclick={() => { void remove(); }}>등록 해제</Button>
        </div>
      {/if}
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

{#if me.mfa.totp || codes !== undefined}
  <Card title="복구 코드" sub="인증 앱이 없을 때 코드로 로그인해요. 코드마다 한 번만 쓸 수 있어요.">
    {#snippet actions()}
      <Badge tone={me.mfa.recoveryCodesLeft > 2 ? 'neutral' : 'warn'} icon={null}>남은 코드 {me.mfa.recoveryCodesLeft}개</Badge>
    {/snippet}
    <div class="tm">
      {#if codes !== undefined}<RecoveryCodes {codes} />{/if}
      {#if me.mfa.totp}
        <FormSection>
          <FormRow label="비밀번호 확인" for="rc-pass" help="새로 만들면 지금 코드는 모두 못 써요.">
            <TextInput id="rc-pass" type="password" autocomplete="current-password" mono={false} bind:value={codePassword} />
          </FormRow>
        </FormSection>
        <div class="row">
          <Button disabled={codePassword === ''} loading={busy} onclick={() => { asking = true; }}>새로 만들기</Button>
        </div>
      {/if}
      {#if codeError !== undefined}<FieldMessage tone="error">{codeError}</FieldMessage>{/if}
    </div>
  </Card>
{/if}

<ConfirmDialog
  bind:open={asking}
  title="복구 코드가 모두 바뀌어요"
  sub="새 코드는 만든 순간 한 번만 보여요."
  lines={[{ tone: 'danger', icon: '✕', text: `기존 복구 코드 ${me.mfa.recoveryCodesLeft}개를 쓸 수 없어요` }]}
  requireCheck confirmLabel="새로 만들기"
  onconfirm={() => { asking = false; void regenerate(); }}
/>

<style>
  .tm { display: grid; gap: 12px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
</style>
