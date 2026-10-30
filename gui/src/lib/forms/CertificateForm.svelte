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
   * ACME 계정은 「계정」 칸(`AcmeAccountField`)에서 고르고 만든다 — 계정이 없으면 그 자리에 바로 펼치고, 있으면 「＋ 계정 생성」 을 눌러야 펼친다.
   * (전에는 계정이 있어도 만들기 구획이 늘 보였다.) 계정 만들기는 설정이 아니라 바로 걸리는 일이다(계정 키를 만든다).
   */
  import { getContext } from 'svelte';
  import { resourcePath } from '@web/resources';
  import {
    Badge, FormRow, FormSection, ListInput, RadioGroup, TextArea, TextInput,
  } from '#lib/ui';
  import { after } from '#lib/after';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import AcmeAccountField from './AcmeAccountField.svelte';
  import CreateForm from './CreateForm.svelte';
  import { KEY_HELP, filled, keyError } from './checks';

  type Issuer = 'acme' | 'upload';
  const desk = getContext<ReturnType<typeof createDesk>>('desk');

  let key = $state('');
  let issuer = $state<Issuer>('acme');

  // ── ACME ──
  let account = $state<string | undefined>();
  let domains = $state('');

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
      <AcmeAccountField bind:account prefer="staging" />
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

