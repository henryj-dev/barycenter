<script lang="ts">
  /**
   * TLS 정책 만들기 — 콘솔 시안 `fieldsFor('tlspol', v, true, 'drawer')`: 기본(이름 · 최소 · 최대 버전 · 암호군) ·
   * HSTS(HSTS · max-age) · 검증(SNI-Host 불일치).
   *
   * 기본값과 같은 칸은 싣지 않는다 — 최소 버전만 고르면 전과 똑같은 몸체(`{ minVersion }`)다.
   * 모양 검사는 저장소의 해독기 · 검증기가 한다. 여기서는 보내기 전에 잡을 수 있는 것만 잡는다.
   *
   * 시안과 다른 처음 값(사실을 지킨다): 시안은 HSTS 켜짐 · 거절 · modern-2026 · 최대 TLS 1.3 으로 연다.
   * 여기는 모델 기본(HSTS 꺼짐 · 허용 · intermediate-2026 · 최대 제한 없음)으로 연다.
   * **HSTS 는 브라우저 쪽에서 되돌릴 수 없다** — `max-age` 동안 이 도메인을 https 로만 간다. 켜는 것은 사람이 정한다(`TlsPolicy.hsts`).
   * 「하위 도메인」 은 시안에 없는 기존 칸이다(모델 `includeSubdomains`) — max-age 아래에 둔다.
   */
  import { getContext } from 'svelte';
  import { FormRow, FormSection, NumberInput, Select, Switch, TextInput } from '#lib/ui';
  import { resourcePath } from '@web/resources';
  import { after } from '#lib/after';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { CIPHERS, HSTS_MAX, MAX_VERSIONS, MISMATCH, VERSIONS, ageError, policyBody, policyForm, rangeError } from '#lib/tls/policy-edit.ts';
  import CreateForm from './CreateForm.svelte';
  import { filled, keyError } from './checks';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const start = policyForm(undefined);
  let key = $state('');
  let min = $state(start.min);
  let max = $state(start.max);
  let cipher = $state(start.cipher);
  let mismatch = $state(start.mismatch);
  let hsts = $state(start.hsts);
  let maxAge = $state<number | string>(start.maxAge);
  let subdomains = $state(start.subdomains);

  const keyBad = $derived(keyError(key) === undefined ? undefined : '이름은 영문·숫자로 시작하고 영문, 숫자, 점(.), 밑줄(_), 하이픈(-)만 쓸 수 있어요. 63자까지예요.');
  const range = $derived(rangeError({ min, max }));
  const age = $derived(ageError({ hsts, maxAge: String(maxAge) }));

  const ready = $derived(filled(key, keyError) && range === undefined && age === undefined);
  const submit = (): void => {
    const k = key.trim();
    const go = after(resourcePath('tlsPolicy', k));
    const { minVersion, ...extra } = policyBody({ min, max, cipher, mismatch, hsts, maxAge: String(maxAge), subdomains });
    // 고른 것이 최소 버전뿐이면 전처럼 만든다. 나머지 칸이 있으면 같은 put 에 몸체를 통째로 싣는다.
    if (Object.keys(extra).length === 0) void desk.insertTlsPolicy(k, min).then(go);
    else void desk.putResource('tlsPolicy', k, { minVersion, ...extra }).then(go);
  };
</script>

<CreateForm {ready} onsubmit={submit} cancelHref="/tls/policy">
  <FormSection title="기본">
    <FormRow label="이름" for="tp-key" error={keyBad}>
      <TextInput id="tp-key" bind:value={key} invalid={keyBad !== undefined} autocomplete="off" />
    </FormRow>
    <FormRow label="최소 버전">
      <Select label="최소 버전" bind:value={min} options={VERSIONS} mono={false} width="100%" />
    </FormRow>
    <FormRow label="최대 버전" error={range}>
      <Select label="최대 버전" bind:value={max} options={MAX_VERSIONS} mono={false} width="100%" invalid={range !== undefined} />
    </FormRow>
    <FormRow label="암호군">
      <Select label="암호군" bind:value={cipher} options={CIPHERS} width="100%" />
    </FormRow>
  </FormSection>

  <FormSection title="HSTS">
    <FormRow label="HSTS" warn={hsts}
      help={hsts ? '▲ HSTS 는 브라우저에서 되돌릴 수 없어요. 설정을 꺼도 max-age 동안 https 로만 와요. 인증서가 깨지면 사용자가 우회하지 못해요.' : undefined}>
      <Switch bind:checked={hsts}>{hsts ? '켜짐' : '꺼짐'}</Switch>
    </FormRow>
    {#if hsts}
      <FormRow label="max-age" error={age}>
        <NumberInput label="max-age" bind:value={maxAge} unit="s" width="100%" min="0" max={HSTS_MAX} invalid={age !== undefined} />
      </FormRow>
      <FormRow label="하위 도메인">
        <Switch bind:checked={subdomains}>{subdomains ? '켜짐' : '꺼짐'}</Switch>
      </FormRow>
    {/if}
  </FormSection>

  <FormSection title="검증">
    <FormRow label="SNI-Host 불일치">
      <Select label="SNI-Host 불일치" bind:value={mismatch} options={MISMATCH} mono={false} width="100%" />
    </FormRow>
  </FormSection>
</CreateForm>
