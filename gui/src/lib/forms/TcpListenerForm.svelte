<script lang="ts">
  /**
   * TCP 리스너 만들기 — 바이트를 그대로 풀로 넘긴다 (시안 구획: 기본 · 동작 · 접근 제한 · 원본 IP).
   * 원본 IP 는 PROXY protocol 수신만이다. 출발지 제한과 함께 못 쓴다(stream 에 `if` 가 없다).
   */
  import { getContext } from 'svelte';
  import { FormRow, FormSection, Select } from '#lib/ui';
  import { resourcePath } from '@web/resources';
  import { after } from '#lib/after';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import CreateForm from './CreateForm.svelte';
  import ListenerBasics from './ListenerBasics.svelte';
  import SourceAllowSection from './SourceAllowSection.svelte';
  import { filled, keyError, portError } from './checks';
  import { plainSwitches, switchedBody } from './listener-create';
  import RealIpSection, { type RealIpHeader, type RealIpSource } from '#lib/listener/RealIpSection.svelte';
  import { putTcpListenerPatch, parseSourceAllow } from '@web/edit';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const pools = $derived(desk.pools.rows.filter((p) => p.protocolClass === 'tcp').map((p) => ({ value: p.key })));

  let key = $state('');
  let bind = $state('0.0.0.0');
  let port = $state('9000');
  let pool = $state<string | undefined>();
  let allow = $state('');
  let allowBad = $state(false);
  let enabled = $state(true);
  let ipSource = $state<RealIpSource>('none');
  let ipHeader = $state<RealIpHeader>('CF-Connecting-IP');
  let ipTrusted = $state('');
  let ipBad = $state(false);
  const proxySrc = $derived(ipSource === 'proxy');
  const sw = $derived({ enabled, realIp: { source: ipSource, header: ipHeader, trusted: ipTrusted } });

  const ready = $derived(filled(key, keyError) && filled(bind) && filled(port, portError) && pool !== undefined && !allowBad && !ipBad && !(proxySrc && allow.trim() !== ''));
  const submit = (): void => {
    if (pool === undefined) return;
    const body = { bind: bind.trim(), port: Number(port), pool };
    const done = after(resourcePath('listener', key.trim()));
    if (plainSwitches(sw)) { void desk.insertTcpListener(key.trim(), body, allow).then(done); return; }
    const sa = parseSourceAllow(allow);
    const op = switchedBody(putTcpListenerPatch(key.trim(), { ...body, ...(sa === undefined ? {} : { sourceAllow: sa }) }), sw);
    void desk.putResource('listener', op.key, op.body).then(done);
  };
</script>

<CreateForm {ready} onsubmit={submit} cancelHref="/traffic/listener">
  <ListenerBasics protocol="TCP" bind:key bind:bind bind:port bind:enabled />
  <FormSection title="동작">
    <FormRow label="기본 풀" help={pools.length === 0 ? 'TCP 풀이 없어요. 풀을 먼저 만들어요.' : undefined}>
      <Select label="기본 풀" bind:value={pool} options={pools} placeholder="풀을 골라요" width="100%" disabled={pools.length === 0} />
    </FormRow>
  </FormSection>
  <SourceAllowSection bind:value={allow} bind:invalid={allowBad} {port} noSrc={proxySrc} conflict={proxySrc && allow.trim() !== ''} />
  <RealIpSection bind:source={ipSource} bind:header={ipHeader} bind:trusted={ipTrusted} bind:invalid={ipBad} http={false} />
</CreateForm>
