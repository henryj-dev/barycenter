<script lang="ts">
  /**
   * HTTP 라우트 만들기 (시안 구획: 기본 · 동작). 옛 폼 셋(풀로 보내기 · redirect · reject)을 「동작」 하나로
   * 합쳤다. 저장 경로는 그대로 셋이다(`insertHttpRoute` · `insertHttpRedirect` · `insertHttpReject`).
   * 경로 바꾸기 · 이 라우트의 요청 헤더(#109)는 「프록시 옵션」 에 접혀 있다.
   */
  import { getContext } from 'svelte';
  import type { RedirectStatus, RejectStatus } from '@web/edit';
  import { Disclosure, FormRow, FormSection, KeyValueEditor, Select, Switch, TextInput, type KvRow } from '#lib/ui';
  import { resourcePath } from '@web/resources';
  import { after } from '#lib/after';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import CreateForm from './CreateForm.svelte';
  import { KEY_HELP, filled, keyError, words } from './checks';

  type Action = 'proxy' | 'redirect' | 'reject';
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const listeners = $derived(desk.listeners.rows
    .filter((l) => l.mark !== 'leave' && (l.protocol === 'http' || l.protocol === 'https'))
    .map((l) => ({ value: l.key, hint: l.protocol })));
  const pools = $derived(desk.pools.rows.filter((p) => p.protocolClass === 'http').map((p) => ({ value: p.key })));
  const ACTIONS: { value: Action; label: string }[] = [
    { value: 'proxy', label: '풀로 보내기' }, { value: 'redirect', label: 'redirect' }, { value: 'reject', label: 'reject' },
  ];
  const REDIRECT = ['301', '302', '307', '308'].map((v) => ({ value: v }));
  const REJECT = ['403', '404', '444'].map((v) => ({ value: v, ...(v === '444' ? { hint: '응답 없이 끊어요' } : {}) }));

  let key = $state('');
  let listener = $state<string | undefined>();
  let hosts = $state('');
  let pathPrefix = $state('');
  let action = $state<Action>('proxy');
  let pool = $state<string | undefined>();
  let websocket = $state(false);
  let rewritePrefix = $state('');
  let headers = $state<KvRow[]>([]);
  let to = $state('');
  let redirectStatus = $state('302');
  let rejectStatus = $state('403');

  const pathBad = $derived(pathPrefix.includes('*') ? '▲ * 는 일반 글자로 저장돼요. 접두사에는 쓰지 않아요.' : undefined);
  const ready = $derived(
    filled(key, keyError) && listener !== undefined
    && (action !== 'proxy' || pool !== undefined)
    && (action !== 'redirect' || filled(to)),
  );
  const submit = (): void => {
    if (listener === undefined) return;
    const prefix = pathPrefix.trim();
    const base = { key: key.trim(), listener, hosts: words(hosts), ...(prefix === '' ? {} : { pathPrefix: prefix }) };
    if (action === 'proxy') {
      if (pool === undefined) return;
      const lines = headers.filter((h) => h.name.trim() !== '').map((h) => `${h.name.trim()}: ${h.value}`).join('\n');
      void desk.insertHttpRoute({
        ...base,
        pool,
        ...(websocket ? { websocket: true } : {}),
        ...(rewritePrefix.trim() === '' ? {} : { rewritePrefix: rewritePrefix.trim() }),
        ...(lines === '' ? {} : { requestHeaders: lines }),
      }).then(after(resourcePath('httpRoute', base.key)));
    } else if (action === 'redirect') {
      void desk.insertHttpRedirect({ ...base, to: to.trim(), status: Number(redirectStatus) as RedirectStatus }).then(after(resourcePath('httpRoute', base.key)));
    } else {
      void desk.insertHttpReject({ ...base, status: Number(rejectStatus) as RejectStatus }).then(after(resourcePath('httpRoute', base.key)));
    }
  };
</script>

<CreateForm {ready} onsubmit={submit} cancelHref="/traffic/route/http">
  <FormSection title="기본">
    <FormRow label="이름" for="hr-key" required error={keyError(key)} help={KEY_HELP}>
      <TextInput id="hr-key" bind:value={key} invalid={keyError(key) !== undefined} autocomplete="off" placeholder="app" />
    </FormRow>
    <FormRow label="리스너" required help={listeners.length === 0 ? 'HTTP · HTTPS 리스너가 없어요. 리스너를 먼저 만들어요.' : undefined}>
      <Select label="리스너" bind:value={listener} options={listeners} placeholder="리스너를 골라요" width="100%" disabled={listeners.length === 0} />
    </FormRow>
    <FormRow label="호스트" for="hr-hosts" help="정확한 이름이나 *.example.com 형태로 넣어요. 쉼표나 공백으로 여러 개를 넣어요.">
      <TextInput id="hr-hosts" bind:value={hosts} autocomplete="off" placeholder="app.example.com" />
    </FormRow>
    <FormRow label="경로 접두사" for="hr-path" help={pathBad ?? '이 접두사로 시작하는 요청과 맞아요. 비우면 모든 경로예요.'}>
      <TextInput id="hr-path" bind:value={pathPrefix} autocomplete="off" placeholder="/api/" />
    </FormRow>
  </FormSection>

  <FormSection title="동작">
    <FormRow label="동작" required>
      <Select label="동작" bind:value={action} options={ACTIONS} mono={false} />
    </FormRow>
    {#if action === 'proxy'}
      <FormRow label="풀" required help={pools.length === 0 ? 'HTTP 풀이 없어요. 풀을 먼저 만들어요.' : undefined}>
        <Select label="풀" bind:value={pool} options={pools} placeholder="풀을 골라요" width="100%" disabled={pools.length === 0} />
      </FormRow>
      <FormRow label="WebSocket" help="켜면 Upgrade 요청을 백엔드로 넘겨요."><Switch bind:checked={websocket}>켜요</Switch></FormRow>
    {:else if action === 'redirect'}
      <FormRow label="대상" for="hr-to" required help="이 주소로 보내요. 예: https://example.com/">
        <TextInput id="hr-to" bind:value={to} autocomplete="off" placeholder="https://example.com/" />
      </FormRow>
      <FormRow label="응답 코드" required><Select label="응답 코드" bind:value={redirectStatus} options={REDIRECT} width="120px" /></FormRow>
    {:else}
      <FormRow label="응답 코드" required><Select label="응답 코드" bind:value={rejectStatus} options={REJECT} width="200px" /></FormRow>
    {/if}
  </FormSection>

  {#if action === 'proxy'}
    <Disclosure title="프록시 옵션" hint="경로 바꾸기 · 이 라우트의 요청 헤더">
      <FormSection>
        <FormRow
          label="경로 바꾸기" for="hr-rw"
          help="맞은 경로 접두사를 이 값으로 바꿔 보내요. 예: 접두사 /api/ + /v1/ → /api/users 를 /v1/users 로 보내요. 끝의 / 는 접두사와 같아야 해요. 비우면 경로를 그대로 보내요."
        >
          <TextInput id="hr-rw" bind:value={rewritePrefix} autocomplete="off" placeholder="/v1/" />
        </FormRow>
        <FormRow label="요청 헤더" help="이 라우트에만 걸어요. 같은 이름이면 리스너의 헤더 대신 이 값을 보내요.">
          <KeyValueEditor bind:rows={headers} ops={[]} namePlaceholder="Host" addLabel="＋ 헤더를 더해요" />
        </FormRow>
      </FormSection>
    </Disclosure>
  {/if}
</CreateForm>
