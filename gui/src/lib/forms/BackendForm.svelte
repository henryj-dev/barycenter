<script lang="ts">
  /** 백엔드 넣기 — 풀을 먼저 고른다. `pool` 을 주면(풀 상세의 `?pool=`) 그 풀로 시작한다. */
  import { getContext } from 'svelte';
  import { FormRow, FormSection, Select, TextInput } from '#lib/ui';
  import { after } from '#lib/after';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import CreateForm from './CreateForm.svelte';
  import { KEY_HELP, filled, keyError, portError } from './checks';

  let { pool: initial }: { pool?: string } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const pools = $derived(desk.pools.rows.map((p) => ({ value: p.key, hint: p.protocolClass })));

  // svelte-ignore state_referenced_locally
  let pool = $state<string | undefined>(initial);
  let key = $state('');
  let host = $state('');
  let port = $state('80');

  const ready = $derived(pool !== undefined && filled(key, keyError) && filled(host) && filled(port, portError));
  const submit = (): void => {
    if (pool === undefined) return;
    const p = pool;
    void desk.insertBackend(key.trim(), { pool: p, host: host.trim(), port: Number(port) }).then(after);
  };
</script>

<CreateForm {ready} onsubmit={submit} cancelHref="/traffic/backend">
  <FormSection title="기본">
    <FormRow label="풀" required help={pools.length === 0 ? '풀이 없어요. 풀 만들기에서 풀과 첫 백엔드를 같이 열어요.' : undefined}>
      <Select label="풀" bind:value={pool} options={pools} placeholder="풀을 골라요" width="100%" disabled={pools.length === 0} />
    </FormRow>
    <FormRow label="이름" for="be-key" required error={keyError(key)} help={KEY_HELP}>
      <TextInput id="be-key" bind:value={key} invalid={keyError(key) !== undefined} autocomplete="off" placeholder="web-2" />
    </FormRow>
    <FormRow label="호스트" for="be-host" required>
      <TextInput id="be-host" bind:value={host} autocomplete="off" placeholder="10.0.0.6" />
    </FormRow>
    <FormRow label="포트" for="be-port" required error={portError(port)}>
      <TextInput id="be-port" bind:value={port} invalid={portError(port) !== undefined} inputmode="numeric" width="120px" />
    </FormRow>
  </FormSection>
</CreateForm>
