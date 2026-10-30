<script lang="ts" module>
  /** 고를 수 있는 CA. 처음에는 스테이징으로 확인하고, 되면 운영으로 바꾼다. */
  export const CAS = [
    { value: 'https://acme-v02.api.letsencrypt.org/directory', label: "Let's Encrypt", hint: '운영' },
    { value: 'https://acme-staging-v02.api.letsencrypt.org/directory', label: "Let's Encrypt 스테이징", hint: '시험용 · 브라우저가 안 믿어요' },
  ] as const;
  export const caLabel = (url: string): string => CAS.find((c) => c.value === url)?.label ?? url;
  /** 스테이징 CA 인가 — 그 인증서는 브라우저가 안 믿는다. */
  export const isStaging = (url: string): boolean => url.includes('staging');
</script>

<script lang="ts">
  /**
   * ACME 계정 칸 — 고르기와 만들기 (인증서 만들기 · 인증서 상세의 「CA 바꾸기」 가 같이 쓴다).
   *
   * 계정이 있으면 셀렉트와 「＋ 계정 생성」. 누르면 만들기 칸이 펼쳐진다. 계정이 없으면 그 자리에 바로 펼친다.
   * 계정 만들기는 설정이 아니라 바로 걸리는 일이다(서버가 계정 키를 만든다). CA 등록은 첫 주문 때 러너가 한다.
   * `except` 의 계정은 목록에서 뺀다(지금 쓰는 계정으로 「바꾸기」 는 뜻이 없다).
   */
  import { getContext, onMount } from 'svelte';
  import { Button, FieldMessage, FormRow, FormSection, Select, TextInput } from '#lib/ui';
  import type { AcmeAccountRow, createDesk } from '#lib/desk.svelte.ts';
  import { keyError } from './checks';

  let { account = $bindable(), label = '계정', except, prefer }: {
    account?: string;
    label?: string;
    except?: string;
    /** 처음 고를 때 이 CA 의 계정을 먼저 고른다(예: 스테이징 → 운영 바꾸기는 운영). */
    prefer?: 'production' | 'staging';
  } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');

  let accounts = $state<AcmeAccountRow[] | undefined>();
  let adding = $state(false);
  // svelte-ignore state_referenced_locally
  let newKey = $state(prefer === 'production' ? 'letsencrypt' : 'letsencrypt-staging');
  // svelte-ignore state_referenced_locally
  let newCa = $state<string>(prefer === 'staging' ? CAS[1].value : CAS[0].value);
  let newContact = $state('');
  let creating = $state(false);
  let problem = $state<string | undefined>();

  const shown = $derived((accounts ?? []).filter((a) => a.key !== except));
  const noAccount = $derived(accounts !== undefined && shown.length === 0);

  const load = async (): Promise<void> => {
    accounts = await desk.acmeAccounts();
    if (account === undefined && shown.length > 0) {
      const want = prefer === undefined ? undefined
        : shown.find((a) => (prefer === 'staging') === isStaging(a.directoryUrl));
      account = (want ?? shown[0]!).key;
    }
  };
  onMount(() => { void load(); });

  const create = async (): Promise<void> => {
    problem = undefined;
    if (newKey.trim() === '' || keyError(newKey) !== undefined) { problem = '계정 이름 규칙에 맞지 않아요.'; return; }
    creating = true;
    const contact = newContact.trim() === '' ? [] : [`mailto:${newContact.trim().replace(/^mailto:/, '')}`];
    const ok = await desk.createAcmeAccount({ key: newKey.trim(), directoryUrl: newCa, contact });
    creating = false;
    if (!ok) { problem = desk.error ?? '계정을 만들지 못했어요.'; return; }
    account = newKey.trim();
    adding = false;
    newKey = '';
    newContact = '';
    await load();
  };
</script>

<FormRow {label} required help={noAccount ? '고를 ACME 계정이 없어요. 먼저 만들어요. 계정 키는 서버가 만들어 보관하고, CA 등록은 첫 주문 때 해요.' : undefined}>
  {#if !noAccount}
    <Select label="ACME 계정" bind:value={account} width="100%" placeholder="계정을 골라요" disabled={accounts === undefined}
      options={shown.map((a) => ({ value: a.key, hint: `${caLabel(a.directoryUrl)}${a.registered ? '' : ' · 첫 주문 때 등록'}` }))} />
    {#if !adding}
      <div class="add"><Button variant="text" size="sm" onclick={() => { adding = true; }}>＋ 계정 생성</Button></div>
    {/if}
  {/if}
  {#if noAccount || adding}
    <!-- 계정이 없으면 이 자리에 바로 펼친다. 있으면 「＋ 계정 생성」 을 눌렀을 때만. -->
    <div class="newacct">
      <FormSection stack>
        <FormRow label="계정 이름" for="acme-key" error={keyError(newKey)}>
          <TextInput id="acme-key" bind:value={newKey} invalid={keyError(newKey) !== undefined} autocomplete="off" width="240px" />
        </FormRow>
        <FormRow label="CA" help="처음에는 스테이징으로 확인해요. 운영 CA 는 실패가 잦으면 잠시 막아요(속도 제한).">
          <Select label="CA" bind:value={newCa} options={CAS} width="100%" mono={false} />
        </FormRow>
        <FormRow label="연락 이메일" for="acme-mail" help="만료 · 문제 알림을 CA 가 보내요. 비워도 돼요.">
          <TextInput id="acme-mail" type="email" bind:value={newContact} autocomplete="email" placeholder="ops@example.com" />
        </FormRow>
      </FormSection>
      <div class="acct">
        <Button loading={creating} disabled={desk.editing} onclick={() => { void create(); }}>계정 만들기</Button>
        {#if !noAccount}<Button variant="text" onclick={() => { adding = false; problem = undefined; }}>취소</Button>{/if}
        {#if problem !== undefined}<FieldMessage tone="error">{problem}</FieldMessage>{/if}
      </div>
    </div>
  {/if}
</FormRow>

<style>
  .add { margin-top: 6px; }
  .newacct { margin-top: 8px; padding: 12px 14px; border: 1px solid var(--bd); border-radius: var(--r-md); background: var(--bg-page); }
  .acct { display: flex; gap: 8px; align-items: center; margin-top: 12px; flex-wrap: wrap; }
</style>
