<script lang="ts">
  /**
   * TLS 패스스루 리스너 만들기 — 복호화하지 않고 SNI 만 보고 풀을 고른다.
   *
   * 폴백은 둘이고 서로 다르다: **유효한 SNI 인데 맞는 라우트가 없을 때**(`pool`)와 **TLS 는 맞는데
   * SNI 가 없을 때**(`noSniPool`, S9). TLS 로 읽히지 않는 바이트(비-TLS · 깨진 ClientHello)에는 폴백이
   * 없다 — 언제나 끊는다. 스파이크가 그 통이 no-SNI 와 갈린다는 것을 실측했다. 그래서 칸을 만들지 않고
   * 도움말에 적는다.
   *
   * preread 타임아웃과 원본 IP(PROXY protocol 수신)도 여기서 정한다. PROXY 수신은 출발지 제한과 함께 못 쓴다.
   */
  import { getContext } from 'svelte';
  import { FormRow, FormSection, Select, TextInput } from '#lib/ui';
  import { resourcePath } from '@web/resources';
  import { after } from '#lib/after';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import CreateForm from './CreateForm.svelte';
  import ListenerBasics from './ListenerBasics.svelte';
  import SourceAllowSection from './SourceAllowSection.svelte';
  import { filled, keyError, portError } from './checks';
  import { plainSwitches, prereadError, switchedBody } from './listener-create';
  import RealIpSection, { type RealIpHeader, type RealIpSource } from '#lib/listener/RealIpSection.svelte';
  import { parseSourceAllow, putPassthroughListenerPatch } from '@web/edit';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  /** 빈 값 = 연결 거절(시안 「연결 거절」). 모델은 폴백마다 풀을 따로 둔다. */
  const choices = $derived([
    { value: '', label: '연결 거절' },
    ...desk.pools.rows.filter((p) => p.protocolClass === 'tcp').map((p) => ({ value: p.key, label: `풀 ${p.key}` })),
  ]);

  let key = $state('');
  let bind = $state('0.0.0.0');
  let port = $state('443');
  let pool = $state('');
  let noSniPool = $state('');
  let allow = $state('');
  let allowBad = $state(false);
  let enabled = $state(true);
  let preread = $state('');
  let ipSource = $state<RealIpSource>('none');
  let ipHeader = $state<RealIpHeader>('CF-Connecting-IP');
  let ipTrusted = $state('');
  let ipBad = $state(false);
  const proxySrc = $derived(ipSource === 'proxy');
  const sw = $derived({ enabled, preread, realIp: { source: ipSource, header: ipHeader, trusted: ipTrusted } });

  const ready = $derived(filled(key, keyError) && filled(bind) && filled(port, portError) && !allowBad && !ipBad
    && prereadError(preread) === undefined && !(proxySrc && allow.trim() !== ''));
  const submit = (): void => {
    const body = {
      bind: bind.trim(),
      port: Number(port),
      ...(pool === '' ? {} : { pool }),
      ...(noSniPool === '' ? {} : { noSniPool }),
    };
    const done = after(resourcePath('listener', key.trim()));
    if (plainSwitches(sw)) { void desk.insertPassthroughListener(key.trim(), body, allow).then(done); return; }
    const sa = parseSourceAllow(allow);
    const op = switchedBody(putPassthroughListenerPatch(key.trim(), { ...body, ...(sa === undefined ? {} : { sourceAllow: sa }) }), sw);
    void desk.putResource('listener', op.key, op.body).then(done);
  };
</script>

<CreateForm {ready} onsubmit={submit} cancelHref="/traffic/listener">
  <ListenerBasics protocol="TLS 패스스루" bind:key bind:bind bind:port bind:enabled />
  <FormSection title="동작">
    <FormRow label="SNI 매칭 없음 폴백" help="유효한 SNI 인데 맞는 라우트가 없을 때 보낼 곳이에요.">
      <Select label="SNI 매칭 없음 폴백" bind:value={pool} options={choices} mono={false} width="100%" />
    </FormRow>
    <FormRow label="SNI 없음 폴백" help="TLS 는 맞는데 SNI 가 없을 때 보낼 곳이에요. TLS 로 읽히지 않는 바이트는 어느 쪽으로도 안 가요. 언제나 끊어요.">
      <Select label="SNI 없음 폴백" bind:value={noSniPool} options={choices} mono={false} width="100%" />
    </FormRow>
    <FormRow label="preread 타임아웃" for="lc-preread" error={prereadError(preread)} help="ClientHello 를 기다리는 시간(초)이에요. 비우면 nginx 기본값이에요.">
      <TextInput id="lc-preread" bind:value={preread} invalid={prereadError(preread) !== undefined} inputmode="numeric" placeholder="30" unit="s" />
    </FormRow>
  </FormSection>
  <SourceAllowSection bind:value={allow} bind:invalid={allowBad} {port} noSrc={proxySrc} conflict={proxySrc && allow.trim() !== ''} />
  <RealIpSection bind:source={ipSource} bind:header={ipHeader} bind:trusted={ipTrusted} bind:invalid={ipBad} http={false} />
</CreateForm>
