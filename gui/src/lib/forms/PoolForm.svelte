<script lang="ts">
  /**
   * 풀 만들기 — 풀과 첫 백엔드를 같이 연다(빈 풀은 저장되지 않는다).
   *
   * 옛 폼 셋(키 없는 풀 · hash · 출발지 IP 해시)을 시안처럼 「알고리즘」 하나로 합쳤다. 저장 경로는 그대로
   * 셋이다: 알고리즘에 따라 `insertPool` · `insertHashPool` · `insertSourceIpHashPool` 을 부른다.
   */
  import { getContext } from 'svelte';
  import type { ProtocolClass } from '@web/edit';
  import { FormRow, FormSection, Select, TextInput } from '#lib/ui';
  import { resourcePath } from '@web/resources';
  import { after } from '#lib/after';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { UPSTREAM_TLS_OFF, upstreamTlsInputOf, upstreamTlsIssue } from '@web/upstream-tls';
  import CreateForm from './CreateForm.svelte';
  import UpstreamTlsField from './UpstreamTlsField.svelte';
  import { KEY_HELP, filled, keyError, portError } from './checks';
  import { ALGOS, hashKeyError, type Algo } from '#lib/pool/pool-fields';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const FAMILIES: { value: ProtocolClass; label: string }[] = [
    { value: 'http', label: 'HTTP' }, { value: 'tcp', label: 'TCP' }, { value: 'udp', label: 'UDP' },
  ];

  let pool = $state('');
  let protocolClass = $state<ProtocolClass>('http');
  let algorithm = $state<Algo>('round_robin');
  let hashKey = $state('remote_addr');
  let backend = $state('');
  let host = $state('');
  let port = $state('80');
  let tls = $state({ ...UPSTREAM_TLS_OFF });

  const ready = $derived(
    filled(pool, keyError) && filled(backend, keyError) && filled(host) && filled(port, portError)
    && (algorithm !== 'hash' || hashKeyError(hashKey, protocolClass) === undefined)
    && upstreamTlsIssue(protocolClass, tls) === undefined,
  );
  const submit = (): void => {
    const upstreamTls = upstreamTlsInputOf(tls);
    const base = {
      pool: pool.trim(), protocolClass, backend: backend.trim(), host: host.trim(), port: Number(port),
      ...(upstreamTls === undefined ? {} : { upstreamTls }),
    };
    const run = algorithm === 'hash'
      ? desk.insertHashPool({ ...base, hashKey: hashKey.trim() })
      : algorithm === 'source_ip_hash'
        ? desk.insertSourceIpHashPool(base)
        : desk.insertPool({ ...base, algorithm });
    void run.then(after(resourcePath('pool', base.pool)));
  };
</script>

<CreateForm {ready} onsubmit={submit} cancelHref="/traffic/pool">
  <FormSection title="기본">
    <FormRow label="이름" for="pl-key" error={keyError(pool)} help={KEY_HELP}>
      <TextInput id="pl-key" bind:value={pool} invalid={keyError(pool) !== undefined} autocomplete="off" />
    </FormRow>
    <FormRow label="프로토콜 계열">
      <Select label="프로토콜 계열" bind:value={protocolClass} options={FAMILIES} mono={false} width="100%" />
    </FormRow>
    <FormRow label="알고리즘">
      <Select label="알고리즘" bind:value={algorithm} options={ALGOS} width="100%" />
    </FormRow>
    {#if algorithm === 'hash'}
      <FormRow label="hash 키" for="pl-hash" error={hashKey.trim() === '' ? undefined : hashKeyError(hashKey, protocolClass)} help="예: $remote_addr">
        <TextInput id="pl-hash" bind:value={hashKey} autocomplete="off" />
      </FormRow>
    {/if}
  </FormSection>

  <!-- 시안에 없지만 실제 동작: 빈 풀은 저장되지 않아서 풀과 첫 백엔드를 같이 만든다. -->
  <FormSection title="첫 백엔드">
    <FormRow label="이름" for="pl-be" error={keyError(backend)} help="빈 풀은 저장되지 않아요. 풀과 첫 백엔드를 같이 만들어요.">
      <TextInput id="pl-be" bind:value={backend} invalid={keyError(backend) !== undefined} autocomplete="off" />
    </FormRow>
    <FormRow label="호스트" for="pl-host">
      <TextInput id="pl-host" bind:value={host} autocomplete="off" />
    </FormRow>
    <FormRow label="포트" for="pl-port" error={portError(port)}>
      <TextInput id="pl-port" bind:value={port} invalid={portError(port) !== undefined} inputmode="numeric" />
    </FormRow>
  </FormSection>

  <UpstreamTlsField bind:value={tls} {protocolClass} />
</CreateForm>
