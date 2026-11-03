<script lang="ts">
  /**
   * TLS 정책 만들기 — 시안: 기본(이름 · 최소 · 최대 버전 · 암호군) · HSTS · 검증(SNI-Host 불일치).
   *
   * 기본값과 같은 칸은 싣지 않는다 — 최소 버전만 고르면 전과 똑같은 몸체(`{ minVersion }`)다.
   * 모양 검사는 저장소의 해독기 · 검증기가 한다. 여기서는 보내기 전에 잡을 수 있는 것만 잡는다.
   *
   * **HSTS 는 기본이 꺼짐이다.** 브라우저 쪽에서 되돌릴 수 없다 — `max-age` 동안 이 도메인을 https 로만 간다.
   * 켜는 것은 사람이 정한다(`TlsPolicy.hsts`).
   */
  import { getContext } from 'svelte';
  import type { TlsVersion } from '@web/edit';
  import { Banner, Checkbox, FormRow, FormSection, NumberInput, Select, Switch, TextInput } from '#lib/ui';
  import { resourcePath } from '@web/resources';
  import { after } from '#lib/after';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import CreateForm from './CreateForm.svelte';
  import { KEY_HELP, filled, keyError } from './checks';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const VERSIONS: { value: TlsVersion; label: string }[] = [{ value: '1.2', label: 'TLS 1.2' }, { value: '1.3', label: 'TLS 1.3' }];
  const MAX: { value: TlsVersion | 'none'; label: string }[] = [{ value: 'none', label: '제한 없음' }, ...VERSIONS];
  const CIPHERS = [
    { value: 'intermediate-2026', label: 'intermediate-2026', hint: '기본' },
    { value: 'modern-2026', label: 'modern-2026', hint: '옛 클라이언트가 못 붙을 수 있어요' },
  ] as const;
  const MISMATCH = [
    { value: 'allow', label: '허용', hint: '기본' },
    { value: 'reject_421', label: '거절 (421)', hint: '멀티테넌트' },
  ] as const;
  /** 해독기의 상한(2년). 되돌릴 수 없는 설정에서 오타는 비싸다. */
  const HSTS_MAX = 63_072_000;

  let key = $state('');
  let minVersion = $state<TlsVersion>('1.2');
  let maxVersion = $state<TlsVersion | 'none'>('none');
  let cipher = $state<(typeof CIPHERS)[number]['value']>('intermediate-2026');
  let mismatch = $state<(typeof MISMATCH)[number]['value']>('allow');
  let hsts = $state(false);
  let maxAge = $state<number | string>(31_536_000);
  let subdomains = $state(false);

  const rangeError = $derived(maxVersion !== 'none' && maxVersion < minVersion ? '최대 버전이 최소 버전보다 낮아요.' : undefined);
  const ageError = $derived(!hsts ? undefined
    : !/^\d+$/.test(String(maxAge)) ? '초 단위 정수를 입력해요.'
    : Number(maxAge) > HSTS_MAX ? `${HSTS_MAX}초(2년)까지예요.` : undefined);

  const ready = $derived(filled(key, keyError) && rangeError === undefined && ageError === undefined);
  const submit = (): void => {
    const k = key.trim();
    const go = after(resourcePath('tlsPolicy', k));
    const extra = {
      ...(maxVersion === 'none' ? {} : { maxVersion }),
      ...(cipher === 'intermediate-2026' ? {} : { cipherPolicy: cipher }),
      ...(mismatch === 'allow' ? {} : { sniHostMismatch: mismatch }),
      ...(hsts ? { hsts: { maxAgeSeconds: Number(maxAge), ...(subdomains ? { includeSubdomains: true } : {}) } } : {}),
    };
    // 고른 것이 최소 버전뿐이면 전처럼 만든다. 나머지 칸이 있으면 같은 put 에 몸체를 통째로 싣는다.
    if (Object.keys(extra).length === 0) void desk.insertTlsPolicy(k, minVersion).then(go);
    else void desk.putResource('tlsPolicy', k, { minVersion, ...extra }).then(go);
  };
</script>

<CreateForm {ready} onsubmit={submit} cancelHref="/tls/policy">
  <FormSection title="기본">
    <FormRow label="이름" for="tp-key" required error={keyError(key)} help={KEY_HELP}>
      <TextInput id="tp-key" bind:value={key} invalid={keyError(key) !== undefined} autocomplete="off" placeholder="modern" />
    </FormRow>
    <FormRow label="최소 버전" required help="이보다 낮은 버전의 연결은 거절해요.">
      <Select label="최소 버전" bind:value={minVersion} options={VERSIONS} mono={false} />
    </FormRow>
    <FormRow label="최대 버전" error={rangeError} help="보통은 제한하지 않아요.">
      <Select label="최대 버전" bind:value={maxVersion} options={MAX} mono={false} invalid={rangeError !== undefined} />
    </FormRow>
    <FormRow label="암호군" help="TLS 1.2 와 1.3 의 암호군을 함께 정해요.">
      <Select label="암호군" bind:value={cipher} options={CIPHERS} width="240px" />
    </FormRow>
  </FormSection>

  <FormSection title="HSTS" hint="기본 꺼짐">
    <FormRow label="HSTS">
      <Switch bind:checked={hsts}>{hsts ? '켜짐' : '꺼짐'}</Switch>
    </FormRow>
    {#if hsts}
      <FormRow label="max-age" required error={ageError} help="이 시간 동안 브라우저가 https 로만 와요.">
        <NumberInput label="max-age" bind:value={maxAge} unit="s" width="120px" min="0" max={HSTS_MAX} invalid={ageError !== undefined} />
      </FormRow>
      <FormRow label="하위 도메인">
        <Checkbox bind:checked={subdomains}>하위 도메인에도 적용해요</Checkbox>
      </FormRow>
    {/if}
  </FormSection>
  {#if hsts}
    <Banner tone="warn">HSTS 는 브라우저에서 되돌릴 수 없어요. 설정을 꺼도 max-age 동안 https 로만 와요. 인증서가 깨지면 사용자가 우회하지 못해요.</Banner>
  {/if}

  <FormSection title="검증">
    <FormRow label="SNI-Host 불일치" help="SNI 와 Host 가 다른 요청이에요. 거절하면 421 로 답해요. 옛 클라이언트 · 프록시 뒤 트래픽이 끊길 수 있어요.">
      <Select label="SNI-Host 불일치" bind:value={mismatch} options={MISMATCH} mono={false} />
    </FormRow>
  </FormSection>
</CreateForm>
