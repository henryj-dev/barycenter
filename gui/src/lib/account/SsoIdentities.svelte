<script lang="ts">
  /**
   * 연결된 SSO 계정. 잇기·끊기 둘 다 **비밀번호를 다시 넣는다**(공통 정책). 이메일·이름이 같다고 저절로
   * 이어지지 않는다. 비밀번호가 없는 계정(SSO 로 생긴 것)은 더 잇거나 끊지 못한다 — 유일한 증거가 IdP 다.
   *
   * 시안(Account · SSO 연결): 머리 줄 아래 공급자마다 한 줄(이름 · ● 연결됨 · 「연결 끊기」). 줄은 이어 둔 계정이다
   * (설정된 공급자 목록은 사람 화면의 「SSO 공급자」 가 말한다). 잇기는 한 번에 하나라 줄 아래 「SSO 계정 연결 ↗」 이다.
   */
  import { Badge, Button, Card, FieldMessage, TextInput } from '#lib/ui';
  import { accountApi, type Me } from './api';

  type Ident = Me['identities'][number];
  let { me, onChanged }: { me: Me; onChanged: () => Promise<void> } = $props();

  let password = $state('');
  let error = $state<string | undefined>();

  const link = async (): Promise<void> => {
    const r = await accountApi.linkSso(password);
    password = '';
    if (!r.ok) { error = r.message; return; }
    window.location.assign(r.data.url);
  };
  const unlink = async (issuer: string, subject: string): Promise<void> => {
    const r = await accountApi.unlinkSso(issuer, subject, password);
    password = '';
    if (!r.ok) { error = r.message; return; }
    error = undefined;
    await onChanged();
  };
</script>

<Card title="SSO 연결" padded={false}>
  {#each me.identities as r (r.issuer + r.subject)}
    <div class="r">
      <span class="n" title={r.subject}>{r.issuer}</span>
      {#if r.lastLoginAt !== null}<span class="l" title="마지막 로그인">{new Date(r.lastLoginAt).toLocaleString()}</span>{/if}
      <Badge tone="ok" icon="●">연결됨</Badge>
      {#if me.hasPassword}<Button size="xs" disabled={password === ''} title="비밀번호를 먼저 넣어요" onclick={() => { void unlink(r.issuer, r.subject); }}>연결 끊기</Button>{/if}
    </div>
  {:else}
    <div class="empty">연결된 SSO 계정이 없어요.</div>
  {/each}
  <div class="foot">
    {#if me.hasPassword}
      <div class="grid">
        <label for="sso-pass">비밀번호 확인</label>
        <TextInput id="sso-pass" type="password" autocomplete="current-password" mono={false} bind:value={password} />
      </div>
      <FieldMessage>잇거나 끊으려면 비밀번호를 다시 넣어요. 이메일 · 이름이 같아도 저절로 잇지 않아요.</FieldMessage>
      <div><Button disabled={password === ''} onclick={() => { void link(); }}>SSO 계정 연결 ↗</Button></div>
    {:else}
      <FieldMessage>SSO 로 만든 계정이라 비밀번호가 없어요. 연결을 바꾸려면 관리자에게 부탁해요.</FieldMessage>
    {/if}
    {#if error !== undefined}<FieldMessage tone="error">{error}</FieldMessage>{/if}
  </div>
</Card>

<style>
  /* 시안: 높이 --row-h · 위 테두리 · 이름(flex 1 · 500) | 배지 | 버튼 */
  .r { display: flex; align-items: center; gap: 12px; padding: 0 16px; height: var(--row-h); font-size: 13px; }
  .r + .r { border-top: 1px solid var(--bd); }
  .n { flex: 1; min-width: 0; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .l { font-family: var(--mono); font-size: 12px; color: var(--tx3); white-space: nowrap; }
  .empty { padding: 20px; text-align: center; color: var(--tx3); font-size: 13px; }
  .foot { display: flex; flex-direction: column; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--bd); }
  .grid { display: grid; grid-template-columns: 150px minmax(0, 360px); gap: 10px 16px; align-items: center; }
  .grid label { font-size: 13px; color: var(--tx2); }
  .foot :global(.msg) { margin-top: 0; }
  @media (max-width: 720px) { .grid { grid-template-columns: minmax(0, 1fr); gap: 4px; } }
</style>
