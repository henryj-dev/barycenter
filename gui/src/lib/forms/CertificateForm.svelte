<script lang="ts">
  /**
   * 인증서 만들기 — 시안: 이름 · 도메인 · 발급자(ACME / 업로드).
   *
   * **ACME:** 「이 도메인들을 이 계정으로 자동 발급 · 갱신한다」 는 의도만 커밋한다(`acme`). 발급과 갱신은
   * 스케줄러가 한다 — 화면에서 따로 누를 것이 없다. 검증 방식은 서버가 고른다: 보통 HTTP-01(:80 리스너가
   * 응답한다), 와일드카드는 DNS-01. 첫 발급 전에는 자료가 없어서 리스너 · SNI 에 아직 걸 수 없다.
   *
   * **업로드:** PEM 자료를 올리고(`/certificates/material`) 그 참조로 커밋한다. 개인 키는 서버가 암호화해서
   * 둔다. 화면은 붙여 넣은 값을 다시 보이지 않는다.
   *
   * ACME 계정은 「계정」 칸에서 만든다 — 계정이 없으면 그 자리에 바로 펼치고, 있으면 「＋ 계정 생성」 을 눌러야 펼친다.
   * (전에는 계정이 있어도 만들기 구획이 늘 보였다.) 계정 만들기는 설정이 아니라 바로 걸리는 일이다(계정 키를 만든다).
   */
  import { getContext, onMount } from 'svelte';
  import { resourcePath } from '@web/resources';
  import {
    Badge, Button, FieldMessage, FormRow, FormSection, ListInput, RadioGroup, Select, TextArea, TextInput,
  } from '#lib/ui';
  import { after } from '#lib/after';
  import type { AcmeAccountRow, createDesk } from '#lib/desk.svelte.ts';
  import CreateForm from './CreateForm.svelte';
  import { KEY_HELP, filled, keyError } from './checks';

  type Issuer = 'acme' | 'upload';
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const CAS = [
    { value: 'https://acme-v02.api.letsencrypt.org/directory', label: "Let's Encrypt", hint: '운영' },
    { value: 'https://acme-staging-v02.api.letsencrypt.org/directory', label: "Let's Encrypt 스테이징", hint: '시험용 · 브라우저가 안 믿어요' },
  ] as const;
  const caLabel = (url: string): string => CAS.find((c) => c.value === url)?.label ?? url;

  let key = $state('');
  let issuer = $state<Issuer>('acme');

  // ── ACME ──
  let accounts = $state<AcmeAccountRow[] | undefined>();
  let account = $state<string | undefined>();
  let domains = $state('');
  let newKey = $state('letsencrypt');
  let newCa = $state<string>(CAS[0].value);
  let newContact = $state('');
  let creating = $state(false);
  let accountProblem = $state<string | undefined>();
  /** 「＋ 계정 생성」 을 눌렀다. 계정이 하나도 없으면 누르지 않아도 펼친다(`noAccount`). */
  let adding = $state(false);
  const noAccount = $derived(accounts !== undefined && accounts.length === 0);

  const loadAccounts = async (): Promise<void> => {
    accounts = await desk.acmeAccounts();
    if (account === undefined && accounts !== undefined && accounts.length > 0) account = accounts[0]!.key;
  };
  onMount(() => { void loadAccounts(); });

  /** 호스트 이름 한 줄. 와일드카드는 맨 앞 `*.` 하나만. */
  const HOST = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
  const domainLine = (line: string): string | undefined => {
    const d = line.toLowerCase();
    if (!HOST.test(d)) return '도메인 이름이 아니에요. 예: app.example.com · *.example.com';
    return undefined;
  };
  const domainList = $derived(domains.split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter((d) => d !== ''));
  const domainsOk = $derived(domainList.length > 0 && domainList.every((d) => domainLine(d) === undefined));
  const wildcard = $derived(domainList.some((d) => d.startsWith('*.')));

  const createAccount = async (): Promise<void> => {
    accountProblem = undefined;
    if (keyError(newKey) !== undefined || newKey.trim() === '') { accountProblem = '계정 이름 규칙에 맞지 않아요.'; return; }
    creating = true;
    const contact = newContact.trim() === '' ? [] : [`mailto:${newContact.trim().replace(/^mailto:/, '')}`];
    const ok = await desk.createAcmeAccount({ key: newKey.trim(), directoryUrl: newCa, contact });
    creating = false;
    if (!ok) { accountProblem = desk.error ?? '계정을 만들지 못했어요.'; return; }
    account = newKey.trim();
    adding = false;
    newKey = '';
    newContact = '';
    await loadAccounts();
  };

  // ── 업로드 ──
  let fullchain = $state('');
  let privkey = $state('');
  const pem = (v: string, label: string): string | undefined =>
    (v.trim() === '' || v.includes(`-----BEGIN ${label}`) ? undefined : `PEM 이 아니에요. -----BEGIN ${label} 으로 시작해요.`);
  const chainBad = $derived(pem(fullchain, 'CERTIFICATE'));
  const keyBad = $derived(privkey.trim() === '' || /-----BEGIN [A-Z ]*PRIVATE KEY/.test(privkey) ? undefined : 'PEM 개인 키가 아니에요. -----BEGIN … PRIVATE KEY 로 시작해요.');

  const ready = $derived(filled(key, keyError) && (issuer === 'acme'
    ? account !== undefined && domainsOk
    : filled(fullchain) && filled(privkey) && chainBad === undefined && keyBad === undefined));

  const submit = (): void => {
    const k = key.trim();
    const go = after(resourcePath('certificate', k));
    if (issuer === 'acme') {
      if (account === undefined) return;
      void desk.putResource('certificate', k, { acme: { account, domains: domainList } }).then(go);
    } else {
      void desk.insertCertificate(k, { fullchain: fullchain.trim(), privkey: privkey.trim() }).then(go);
    }
  };
</script>

<CreateForm {ready} onsubmit={submit} cancelHref="/tls/certificate" submitLabel={issuer === 'acme' ? '만들기' : '자료를 넣어요'}>
  <FormSection title="기본">
    <FormRow label="이름" for="ct-key" required error={keyError(key)} help={KEY_HELP}>
      <TextInput id="ct-key" bind:value={key} invalid={keyError(key) !== undefined} autocomplete="off" placeholder="example-com" />
    </FormRow>
    <FormRow label="발급자" required>
      <RadioGroup label="발급자" bind:value={issuer} options={[{ value: 'acme', label: 'ACME 자동 발급' }, { value: 'upload', label: '파일 업로드 (PEM)' }]} />
    </FormRow>
  </FormSection>

  {#if issuer === 'acme'}
    <FormSection title="ACME">
      <FormRow label="도메인" required help="한 줄에 하나씩 넣어요. 이 이름들이 인증서에 들어가요.">
        <ListInput label="도메인" bind:value={domains} check={domainLine} minRows={2} placeholder={'app.example.com\nwww.example.com'} />
      </FormRow>
      <FormRow label="계정" required help={noAccount ? 'ACME 계정이 없어요. 먼저 만들어요. 계정 키는 서버가 만들어 보관하고, CA 등록은 첫 주문 때 해요.' : undefined}>
        {#if !noAccount}
          <Select label="ACME 계정" bind:value={account} width="100%" placeholder="계정을 골라요" disabled={accounts === undefined}
            options={(accounts ?? []).map((a) => ({ value: a.key, hint: `${caLabel(a.directoryUrl)}${a.registered ? '' : ' · 첫 주문 때 등록'}` }))} />
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
              <Button loading={creating} disabled={desk.editing} onclick={() => { void createAccount(); }}>계정 만들기</Button>
              {#if !noAccount}<Button variant="text" onclick={() => { adding = false; accountProblem = undefined; }}>취소</Button>{/if}
              {#if accountProblem !== undefined}<FieldMessage tone="error">{accountProblem}</FieldMessage>{/if}
            </div>
          </div>
        {/if}
      </FormRow>
      <FormRow label="검증 방식" help={wildcard
        ? '와일드카드는 DNS-01 로만 받아요. DNS 프로바이더 연결이 필요해요.'
        : 'HTTP-01 이에요. CA 가 공개 DNS 로 이 이름을 찾아 :80 의 /.well-known/acme-challenge/ 로 확인해요. :80 HTTP 리스너가 있어야 해요. 리스너의 기본 동작이 거절이어도 확인 경로는 응답해요.'}>
        {#if wildcard}<Badge tone="info" icon={null}>DNS-01</Badge>{:else}<Badge tone="info" icon={null}>HTTP-01</Badge>{/if}
      </FormRow>
      <FormRow label="자동 갱신" help="만료 전에 스케줄러가 다시 받아요. 따로 누를 것이 없어요.">
        <Badge tone="ok">켜짐</Badge>
      </FormRow>
    </FormSection>
  {:else}
    <FormSection title="자료" hint="PEM">
      <FormRow label="인증서 체인" for="ct-chain" required error={chainBad} help="서버 인증서 다음에 중간 인증서를 붙여요(fullchain).">
        <TextArea id="ct-chain" bind:value={fullchain} invalid={chainBad !== undefined} rows={8} placeholder="-----BEGIN CERTIFICATE-----" />
      </FormRow>
      <FormRow label="개인 키" for="ct-key-pem" required error={keyBad} help="서버가 암호화해서 보관해요.">
        <TextArea id="ct-key-pem" bind:value={privkey} invalid={keyBad !== undefined} rows={6} placeholder="-----BEGIN PRIVATE KEY-----" autocomplete="off" />
      </FormRow>
    </FormSection>
  {/if}
</CreateForm>

<style>
  .add { margin-top: 6px; }
  .newacct { margin-top: 8px; padding: 12px 14px; border: 1px solid var(--bd); border-radius: var(--r-md); background: var(--bg-page); }
  .acct { display: flex; gap: 8px; align-items: center; margin-top: 12px; flex-wrap: wrap; }
</style>
