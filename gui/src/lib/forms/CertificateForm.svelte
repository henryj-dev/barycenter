<script lang="ts">
  /**
   * 인증서 만들기 — 콘솔 시안 `fieldsFor('certs', v, true, 'drawer')`: 구획 「기본」 한 개.
   * 이름 · 도메인 · 발급자(ACME / 업로드) · ACME 계정(＋ 새 계정 → 계정 이름 · 연락 이메일) · 자동 갱신 · 검증 방식 ·
   * (DNS-01 이면) DNS 공급자 「준비 중」 · 적용 안내.
   *
   * **ACME:** 「이 도메인들을 이 계정으로 자동 발급 · 갱신한다」 는 의도만 커밋한다(`acme`). 발급과 갱신은
   * 스케줄러가 한다 — 화면에서 따로 누를 것이 없다. 트래픽이 안 바뀌므로 서버가 바로 활성으로 올린다 —
   * 적용 대기에 남지 않는다(2026-11-02, `ControlPlane.applyIfTrafficNeutral`). 단, 다른 변경이 적용 대기 중이면
   * 같이 적용해야 한다 — 「적용」 줄이 `desk.pendingCount` 로 미리 말한다. 첫 발급 전에는 자료가 없어서 리스너 · SNI 에 아직 걸 수 없다.
   *
   * 실제 동작이 시안과 다른 곳(사실을 지킨다):
   *   · 자동 갱신은 고르는 칸이 모델에 없다 — ACME 는 늘 갱신한다. 켜짐으로 잠근다.
   *   · 검증 방식은 서버가 도메인을 보고 고른다(와일드카드 → DNS-01, 나머지 → HTTP-01). 고른 값을 잠가 보인다.
   *   · 업로드는 PEM 자료(체인 · 개인 키)가 있어야 한다 — 시안에 없는 두 줄을 발급자 아래에 둔다. 도메인은 자료(SAN)에서 오므로 받지 않는다.
   *
   * **업로드:** PEM 자료를 올리고(`/certificates/material`) 그 참조로 커밋한다. 개인 키는 서버가 암호화해서
   * 둔다. 화면은 붙여 넣은 값을 다시 보이지 않는다.
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { resourcePath } from '@web/resources';
  import { FormRow, FormSection, Select, Switch, TextArea, TextInput } from '#lib/ui';
  import { after } from '#lib/after';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import Resolved from '#lib/tls/Resolved.svelte';
  import { challengeOf, domainsError, parseDomains } from '#lib/tls/cert-edit.ts';
  import AcmeAccountField from './AcmeAccountField.svelte';
  import CreateForm from './CreateForm.svelte';
  import { filled, keyError } from './checks';

  type Issuer = 'acme' | 'upload';
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');

  /**
   * **자료 교체** — 목록 · 상세의 「자료를 교체해요」 가 `?key=<이름>&issuer=upload` 로 연다. 같은 이름에 새 자료를 올려
   * 커밋한다(`put`). 이름과 발급자는 고정이다 — 다른 이름이면 교체가 아니라 새 인증서다.
   */
  const replaceKey = page.url.searchParams.get('key') ?? undefined;
  const replacing = replaceKey !== undefined && replaceKey !== '' && page.url.searchParams.get('issuer') === 'upload';

  let key = $state(replacing ? replaceKey ?? '' : '');
  let issuer = $state<Issuer>(replacing ? 'upload' : 'acme');
  /** 시안의 이름 오류 문구. 빈 칸은 오류가 아니다(「만들기」 만 잠근다). */
  const keyBad = $derived(keyError(key) === undefined ? undefined : '도메인 형식으로 입력해요.');

  /**
   * **클러스터에서 HTTP-01 은 실패할 수 있다.** ACME 실행기는 리더에서만 돌고, 확인 토큰도 리더의 데이터 평면에만
   * 둔다(`src/control/acme-runner.ts`). CA 가 리더가 아닌 노드로 오면 토큰이 없다. 노드가 둘 이상이면 미리 말한다.
   * 전역은 지역마다 다르므로 묻지 않는다(시안도 지역 모드에서만 띄운다).
   */
  let nodeCount = $state(0);
  $effect(() => {
    if (!desk.live || scope?.mode === 'global') return;
    void desk.clusterNodes().then((r) => {
      const b = r as { enabled?: boolean; nodes?: unknown[] } | undefined;
      nodeCount = b?.enabled === true && Array.isArray(b.nodes) ? b.nodes.length : 0;
    });
  });

  // ── ACME ──
  let account = $state<string | undefined>();
  let accountReady = $state(false);
  let field: { ensure: () => Promise<string | undefined> } | undefined = $state();
  let domains = $state('');
  const domainList = $derived(parseDomains(domains));
  const domainsBad = $derived(domains.trim() === '' ? undefined : domainsError(domains));
  const challenge = $derived(challengeOf(domainList));
  const clusterWarn = $derived(challenge === 'HTTP-01' && nodeCount >= 2);

  // ── 업로드 ──
  let fullchain = $state('');
  let privkey = $state('');
  const pem = (v: string, label: string): string | undefined =>
    (v.trim() === '' || v.includes(`-----BEGIN ${label}`) ? undefined : `PEM 이 아니에요. -----BEGIN ${label} 으로 시작해요.`);
  const chainBad = $derived(pem(fullchain, 'CERTIFICATE'));
  const keyPemBad = $derived(privkey.trim() === '' || /-----BEGIN [A-Z ]*PRIVATE KEY/.test(privkey) ? undefined : 'PEM 개인 키가 아니에요. -----BEGIN … PRIVATE KEY 로 시작해요.');

  /**
   * 바로 적용되나 — 서버(`applyIfTrafficNeutral`)는 활성 리비전과 이 커밋의 차이가 인증서 의도뿐일 때만 바로 올린다.
   * 다른 변경이 적용 대기 중이면 그 차이에 섞이므로 바로 올리지 않는다. 화면은 미리 말만 하고,
   * 실제로 올라갔는지는 커밋 응답(`applied`)을 `after` 가 토스트로 알린다.
   */
  const waiting = $derived(desk.pendingCount > 0);

  const ready = $derived(filled(key, keyError) && (issuer === 'acme'
    ? accountReady && domainList.length > 0 && domainsError(domains) === undefined
    : filled(fullchain) && filled(privkey) && chainBad === undefined && keyPemBad === undefined));

  const submit = async (): Promise<void> => {
    const k = key.trim();
    const go = after(resourcePath('certificate', k));
    if (issuer === 'acme') {
      // 「＋ 새 계정」 이면 계정을 먼저 만든다(바로 걸리는 일). 못 만들면 인증서를 커밋하지 않는다.
      const account = await field?.ensure();
      if (account === undefined) return;
      void desk.putResource('certificate', k, { acme: { account, domains: domainList } }).then(go);
    } else {
      void desk.insertCertificate(k, { fullchain: fullchain.trim(), privkey: privkey.trim() }).then(go);
    }
  };
</script>

<CreateForm {ready} onsubmit={() => { void submit(); }} cancelHref={replacing ? resourcePath('certificate', key) : '/tls/certificate'} submitLabel={issuer === 'acme' ? '만들기' : replacing ? '자료를 교체해요' : '만들기'}
  note={issuer === 'acme' && !waiting ? '만들면 바로 적용해요. 발급은 이어서 진행해요.' : undefined}>
  <FormSection title="기본">
    <FormRow label="이름" for="ct-key" error={keyBad}>
      <TextInput id="ct-key" bind:value={key} invalid={keyBad !== undefined} autocomplete="off" disabled={replacing} />
    </FormRow>
    {#if issuer === 'acme'}
      <FormRow label="도메인" for="ct-domains" error={domainsBad} help="쉼표로 구분해요.">
        <TextInput id="ct-domains" bind:value={domains} invalid={domainsBad !== undefined} autocomplete="off" />
      </FormRow>
    {/if}
    <FormRow label="발급자">
      <Select label="발급자" bind:value={issuer} mono={false} width="100%" disabled={replacing}
        options={[{ value: 'acme', label: 'ACME' }, { value: 'upload', label: '업로드' }]} />
    </FormRow>
    {#if issuer === 'acme'}
      <AcmeAccountField bind:this={field} bind:account bind:ready={accountReady} prefer="staging" />
      <FormRow label="자동 갱신">
        <Switch checked disabled>켜짐</Switch>
      </FormRow>
      <FormRow label="검증 방식" warn={clusterWarn}
        help={clusterWarn ? '▲ 클러스터에서는 http-01이 실패할 수 있어요. CA가 리더가 아닌 노드로 올 수 있어요. dns-01이나 업로드 인증서를 써요.' : undefined}>
        <Select label="검증 방식" value={challenge} options={[{ value: 'HTTP-01' }, { value: 'DNS-01' }]} width="100%" disabled />
      </FormRow>
      {#if challenge === 'DNS-01'}
        <FormRow label="DNS 공급자">
          <Resolved items={[['상태', '준비 중']]} help="DNS-01 공급자 설정은 아직 없어요. 준비 중이에요." />
        </FormRow>
      {/if}
      <FormRow label="적용">
        {#if waiting}
          <Resolved items={[['안내', '적용 대기 중인 변경이 있어서 함께 적용해야 해요. 적용하면 발급을 시작해요.']]} link={{ label: '적용 대기로 가기', href: '/change/pending' }} />
        {:else}
          <Resolved items={[['안내', '트래픽이 바뀌지 않아서 바로 적용해요. 발급은 이어서 진행해요.']]} />
        {/if}
      </FormRow>
    {:else}
      <FormRow label="인증서 체인" for="ct-chain" error={chainBad} help={replacing ? '이 이름에 새 PEM 자료를 올려요. 적용해야 트래픽에 걸려요.' : '서버 인증서 다음에 중간 인증서를 붙여요(fullchain).'}>
        <TextArea id="ct-chain" bind:value={fullchain} invalid={chainBad !== undefined} rows={8} placeholder="-----BEGIN CERTIFICATE-----" />
      </FormRow>
      <FormRow label="개인 키" for="ct-key-pem" error={keyPemBad} help="서버가 암호화해서 보관해요.">
        <TextArea id="ct-key-pem" bind:value={privkey} invalid={keyPemBad !== undefined} rows={6} placeholder="-----BEGIN PRIVATE KEY-----" autocomplete="off" />
      </FormRow>
    {/if}
  </FormSection>
</CreateForm>
