<script lang="ts">
  /**
   * 인증 앱 등록 · 해제 · 복구 코드 재발급. **관리자는 해제할 수 없다**(서버가 409 로 막는다 — 버튼도 안 그린다).
   * 시안(Account): 「인증 앱」 카드 — 한 줄(제목 · 설명 | 배지 | 버튼), 「복구 코드」 카드 — 한 줄(제목 · 설명 | 버튼) 아래 코드 격자.
   * 시안의 「다시 등록…」 은 서버에 없다(등록된 앱이 있으면 409 — 먼저 해제한다). 그 자리에 「등록 해제…」 를 둔다.
   * 해제 · 재발급은 비밀번호를 다시 넣는다(서버) — 칸은 카드마다 한 줄(라벨 150px)로 한 줄 아래에 둔다.
   * 복구 코드는 만든 순간 한 번만 보인다(서버에는 해시만 있다). 시안의 「코드 보기」 는 그래서 없다.
   * 「새로 만들기…」 는 시안대로 확인 대화상자(「복구 코드가 모두 바뀌어요」 · 확인 체크)를 거친다. 그 뒤의 서버
   * 요청(비밀번호 · 민감 작업 step-up)은 전과 같다.
   */
  import { Badge, Button, Card, ConfirmDialog, FieldMessage, TextInput, toast } from '#lib/ui';
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
  /** 「등록 해제…」 를 눌러 비밀번호 줄을 열었다. */
  let removing = $state(false);
  /** 시안: 비밀번호 줄은 「새로 만들기…」 를 누른 뒤에 열린다. */
  let regenOpen = $state(false);
  /** 「새로 만들기…」 를 눌렀는데 비밀번호가 비었다. */
  const askCodes = (): void => {
    if (!regenOpen) { regenOpen = true; codeError = undefined; return; }
    if (codePassword === '') { codeError = '비밀번호를 입력해요.'; return; }
    codeError = undefined;
    asking = true;
  };

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
    removing = false;
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

<Card>
  <div class="tm">
    <div class="row">
      <div class="tx"><div class="t">인증 앱</div><div class="s">로그인할 때 6자리 코드를 써요.{#if me.mfa.totp && me.role === 'admin'}{' '}관리자는 인증 앱을 풀 수 없어요.{/if}</div></div>
      {#if me.mfa.totp}<Badge tone="ok" icon="●">등록됨</Badge>{:else}<Badge tone="warn" icon="▲">등록 안 됨</Badge>{/if}
      {#if me.mfa.totp}
        {#if me.role !== 'admin'}<Button onclick={() => { removing = !removing; error = undefined; password = ''; }}>등록 해제…</Button>{/if}
      {:else if pending === undefined}
        <Button variant="primary" loading={busy} onclick={() => { void begin(); }}>등록 시작</Button>
      {/if}
    </div>
    {#if me.mfa.totp && me.role !== 'admin' && removing}
      <form class="grid" novalidate onsubmit={(e) => { e.preventDefault(); void remove(); }}>
        <label for="tm-pass">비밀번호 확인</label>
        <div class="line">
          <TextInput id="tm-pass" type="password" autocomplete="current-password" mono={false} bind:value={password} />
          <Button variant="danger" type="submit" disabled={password === '' || busy}>등록 해제</Button>
        </div>
      </form>
    {:else if !me.mfa.totp && pending !== undefined}
      <form class="setup" novalidate onsubmit={(e) => { e.preventDefault(); void confirm(); }}>
        <TotpSetup secret={pending.secret} uri={pending.uri} bind:code />
        <div><Button variant="primary" type="submit" loading={busy}>등록 확인</Button></div>
      </form>
    {/if}
    {#if error !== undefined}<FieldMessage tone="error">{error}</FieldMessage>{/if}
  </div>
</Card>

{#if me.mfa.totp || codes !== undefined}
  <Card>
    <div class="tm">
      <div class="row">
        <div class="tx"><div class="t">복구 코드</div><div class="s">인증 앱이 없을 때 코드로 로그인해요. 코드마다 한 번만 쓸 수 있어요.</div></div>
        <Badge tone={me.mfa.recoveryCodesLeft > 2 ? 'neutral' : 'warn'} icon={null}>남은 코드 {me.mfa.recoveryCodesLeft}개</Badge>
        {#if me.mfa.totp}<Button loading={busy} onclick={askCodes} outline="danger">새로 만들기…</Button>{/if}
      </div>
      {#if me.mfa.totp && regenOpen}
        <div class="grid">
          <label for="rc-pass">비밀번호 확인</label>
          <TextInput id="rc-pass" type="password" autocomplete="current-password" mono={false} bind:value={codePassword} oninput={() => { codeError = undefined; }} invalid={codeError !== undefined} />
        </div>
      {/if}
      {#if codeError !== undefined}<FieldMessage tone="error">{codeError}</FieldMessage>{/if}
      {#if codes !== undefined}<RecoveryCodes {codes} />{/if}
    </div>
  </Card>
{/if}

<ConfirmDialog
  bind:open={asking}
  title="복구 코드가 모두 바뀌어요"
  sub="새 코드 10개를 만들어요."
  lines={[{ tone: 'danger', icon: '✕', text: `기존 복구 코드 ${me.mfa.recoveryCodesLeft}개를 쓸 수 없어요.` }]}
  requireCheck confirmLabel="새로 만들기"
  onconfirm={() => { asking = false; regenOpen = false; void regenerate(); }}
/>

<style>
  .tm { display: flex; flex-direction: column; gap: 12px; }
  /* 시안: 한 줄 — 제목 · 설명(flex 1 · 최소 220) | 배지 | 버튼 */
  .row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .tx { flex: 1; min-width: 220px; }
  .t { font-weight: 600; font-size: 14px; }
  .s { font-size: 12px; color: var(--tx3); }
  .grid { display: grid; grid-template-columns: 150px minmax(0, 360px); gap: 10px 16px; align-items: center; }
  .grid label { font-size: 13px; color: var(--tx2); }
  .line { display: flex; gap: 8px; align-items: center; }
  .setup { display: flex; flex-direction: column; gap: 12px; max-width: 400px; }
  .tm :global(.msg) { margin-top: 0; }
  @media (max-width: 720px) { .grid { grid-template-columns: minmax(0, 1fr); gap: 4px; } }
</style>
