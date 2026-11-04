<script lang="ts">
  /** TCP 리스너 만들기 — 바이트를 그대로 풀로 넘긴다 (시안 구획: 기본 · 동작 · 접근 제한). */
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

  const ready = $derived(filled(key, keyError) && filled(bind) && filled(port, portError) && pool !== undefined && !allowBad);
  const submit = (): void => {
    if (pool === undefined) return;
    const body = { bind: bind.trim(), port: Number(port), pool };
    const done = after(resourcePath('listener', key.trim()));
    if (plainSwitches({ enabled })) { void desk.insertTcpListener(key.trim(), body, allow).then(done); return; }
    const sa = parseSourceAllow(allow);
    const op = switchedBody(putTcpListenerPatch(key.trim(), { ...body, ...(sa === undefined ? {} : { sourceAllow: sa }) }), { enabled });
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
  <SourceAllowSection bind:value={allow} bind:invalid={allowBad} {port} />
</CreateForm>
