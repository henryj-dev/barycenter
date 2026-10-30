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

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const pools = $derived(desk.pools.rows.filter((p) => p.protocolClass === 'tcp').map((p) => ({ value: p.key })));

  let key = $state('');
  let bind = $state('0.0.0.0');
  let port = $state('9000');
  let pool = $state<string | undefined>();
  let allow = $state('');

  const ready = $derived(filled(key, keyError) && filled(bind) && filled(port, portError) && pool !== undefined);
  const submit = (): void => {
    if (pool === undefined) return;
    void desk.insertTcpListener(key.trim(), { bind: bind.trim(), port: Number(port), pool }, allow).then(after(resourcePath('listener', key.trim())));
  };
</script>

<CreateForm {ready} onsubmit={submit} cancelHref="/traffic/listener">
  <ListenerBasics protocol="TCP" bind:key bind:bind bind:port />
  <FormSection title="동작">
    <FormRow label="기본 풀" required help={pools.length === 0 ? 'TCP 풀이 없어요. 풀을 먼저 만들어요.' : undefined}>
      <Select label="기본 풀" bind:value={pool} options={pools} placeholder="풀을 골라요" width="100%" disabled={pools.length === 0} />
    </FormRow>
  </FormSection>
  <SourceAllowSection bind:value={allow} {port} />
</CreateForm>
