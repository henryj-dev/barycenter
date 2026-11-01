<script lang="ts">
  /**
   * 패스스루 라우트 만들기 — SNI 로 TCP 풀을 고르거나 그 SNI 를 끊는다. 옛 폼 둘을 「동작」 하나로 합쳤다
   * (`insertPassthroughRoute` · `insertPassthroughReject`).
   */
  import { getContext } from 'svelte';
  import { FormRow, FormSection, Select, TextInput } from '#lib/ui';
  import { resourcePath } from '@web/resources';
  import { after } from '#lib/after';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import CreateForm from './CreateForm.svelte';
  import { KEY_HELP, filled, keyError, words } from './checks';

  type Action = 'proxy' | 'reject';
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const listeners = $derived(desk.listeners.rows
    .filter((l) => l.protocol === 'tls_passthrough').map((l) => ({ value: l.key })));
  const pools = $derived(desk.pools.rows.filter((p) => p.protocolClass === 'tcp').map((p) => ({ value: p.key })));
  const ACTIONS: { value: Action; label: string }[] = [{ value: 'proxy', label: '풀로 보내기' }, { value: 'reject', label: '연결을 끊어요' }];

  let key = $state('');
  let listener = $state<string | undefined>();
  let snis = $state('');
  let action = $state<Action>('proxy');
  let pool = $state<string | undefined>();

  const ready = $derived(filled(key, keyError) && listener !== undefined && words(snis).length > 0 && (action === 'reject' || pool !== undefined));
  const submit = (): void => {
    if (listener === undefined) return;
    const base = { key: key.trim(), listener, snis: words(snis) };
    if (action === 'reject') void desk.insertPassthroughReject(base).then(after(resourcePath('passthroughRoute', base.key)));
    else if (pool !== undefined) void desk.insertPassthroughRoute({ ...base, pool }).then(after(resourcePath('passthroughRoute', base.key)));
  };
</script>

<CreateForm {ready} onsubmit={submit} cancelHref="/traffic/route/passthrough">
  <FormSection title="기본">
    <FormRow label="이름" for="pr-key" required error={keyError(key)} help={KEY_HELP}>
      <TextInput id="pr-key" bind:value={key} invalid={keyError(key) !== undefined} autocomplete="off" placeholder="db" />
    </FormRow>
    <FormRow label="리스너" required help={listeners.length === 0 ? 'TLS 패스스루 리스너가 없어요. 리스너를 먼저 만들어요.' : undefined}>
      <Select label="리스너" bind:value={listener} options={listeners} placeholder="리스너를 골라요" width="100%" disabled={listeners.length === 0} />
    </FormRow>
    <FormRow label="SNI" for="pr-sni" required help="쉼표나 공백으로 여러 개를 넣어요.">
      <TextInput id="pr-sni" bind:value={snis} autocomplete="off" placeholder="db.example.com" />
    </FormRow>
  </FormSection>
  <FormSection title="동작">
    <FormRow label="동작" required><Select label="동작" bind:value={action} options={ACTIONS} mono={false} /></FormRow>
    {#if action === 'proxy'}
      <FormRow label="풀" required help={pools.length === 0 ? 'TCP 풀이 없어요. 풀을 먼저 만들어요.' : undefined}>
        <Select label="풀" bind:value={pool} options={pools} placeholder="풀을 골라요" width="100%" disabled={pools.length === 0} />
      </FormRow>
    {/if}
  </FormSection>
</CreateForm>
