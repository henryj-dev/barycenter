<script lang="ts">
  /**
   * 패스스루 라우트 만들기 · 수정 — 콘솔 시안 `fieldsFor('routes')` 의 패스스루: 「기본」(이름 · 리스너 · SNI · 우선순위) ·
   * 「동작」(동작 · 풀). SNI 로 TCP 풀을 고르거나 그 SNI 를 끊는다(`insertPassthroughRoute` · `insertPassthroughReject`).
   *
   * `edit` 이면 설정 탭의 수정 폼이다 — head 값으로 한 번 채우고, 이름은 잠그고, 같은 patch 빌더로 몸통을 지어
   * `desk.putResource` 로 저장한다(`route-edit.ts`). 콘솔 격자이고 아래 줄은 시안 `tSet` 의 안내 · 되돌리기 · 저장이다.
   *
   * 시안과 다른 곳(실제 동작이 다르다): 패스스루의 동작은 풀로 보내기 · 연결을 끊어요 둘이다 — 복호화하지 않으니
   * redirect 와 응답 코드가 없다(시안은 HTTP 와 같은 셋 · 응답 코드).
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { Banner, Form, FormRow, FormSection, Select, TextInput, setFormLayout, toast } from '#lib/ui';
  import { itemOf, itemsOf, resourcePath } from '@web/resources';
  import { after } from '#lib/after';
  import { isPendingResource } from '#lib/pending';
  import Writable from '#lib/global/Writable.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import CreateForm from './CreateForm.svelte';
  import RouteEditFoot from './RouteEditFoot.svelte';
  import { filled, keyError, words } from './checks';
  import {
    NAME_ERROR, PRIORITY_HELP, passthroughBody, passthroughStateOf, poolShareCount, poolShareText, priorityError, type PassthroughState,
  } from './route-edit';

  let { edit = false }: {
    /** 설정 탭의 수정 폼 — 키는 주소의 `[key]` 다. */
    edit?: boolean;
  } = $props();
  // svelte-ignore state_referenced_locally
  if (edit) setFormLayout('compact');

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const listeners = $derived(desk.listeners.rows
    .filter((l) => l.protocol === 'tls_passthrough').map((l) => ({ value: l.key })));
  const pools = $derived(desk.pools.rows.filter((p) => p.protocolClass === 'tcp').map((p) => ({ value: p.key })));
  const ACTIONS: { value: PassthroughState['action']; label: string }[] = [{ value: 'proxy', label: '풀로 보내기' }, { value: 'reject', label: '연결을 끊어요' }];

  let name = $state('');
  // 시안 `newDefaults('routes')`: 우선순위 100 · 풀로 보내기.
  let f = $state<PassthroughState>({ listener: undefined, snis: '', priority: '100', action: 'proxy', pool: undefined });
  let problem = $state<string | undefined>();
  let sniTouched = $state(false);
  $effect(() => { if (f.snis.trim() !== '') sniTouched = true; });

  // ── 수정: head 값으로 한 번 채운다. 그 뒤 스트림이 모델을 바꿔도 입력 중인 값을 덮지 않는다.
  const editKey = $derived(edit ? page.params['key'] ?? '' : '');
  const item = $derived(edit ? itemOf(desk.model, 'passthroughRoute', editKey) : undefined);
  let loaded = $state<string | undefined>();
  let orig = $state('');
  $effect(() => {
    if (!edit || item === undefined || loaded === editKey) return;
    f = passthroughStateOf(item);
    orig = JSON.stringify(f);
    problem = undefined;
    loaded = editKey;
  });

  const nameErr = $derived(keyError(name) === undefined ? undefined : NAME_ERROR);
  const sniErr = $derived(words(f.snis).length === 0 && (sniTouched || edit) ? '호스트를 입력해요.' : undefined);
  const prioErr = $derived(priorityError(f.priority));
  const shared = $derived(poolShareText(poolShareCount(
    [...itemsOf(desk.model, 'httpRoute'), ...itemsOf(desk.model, 'passthroughRoute')], f.action === 'proxy' ? f.pool : undefined, edit ? editKey : undefined,
  )));
  const ready = $derived((edit ? item !== undefined : filled(name, keyError)) && f.listener !== undefined && words(f.snis).length > 0
    && prioErr === undefined && (f.action === 'reject' || f.pool !== undefined));
  const dirty = $derived(edit && loaded !== undefined && JSON.stringify(f) !== orig);
  const pending = $derived(edit && isPendingResource(desk.pendingResources, 'passthroughRoute', editKey));

  const submit = (): void => {
    if (f.listener === undefined) return;
    const base = { key: name.trim(), listener: f.listener, snis: words(f.snis), priority: Number(f.priority.trim()) };
    if (f.action === 'reject') void desk.insertPassthroughReject(base).then(after(resourcePath('passthroughRoute', base.key)));
    else if (f.pool !== undefined) void desk.insertPassthroughRoute({ ...base, pool: f.pool }).then(after(resourcePath('passthroughRoute', base.key)));
  };

  /** 수정 저장 — 만들기와 같은 patch 빌더로 몸통을 짓고 통째로 갈아 끼운다(`put`). */
  const save = (): void => {
    if (!dirty || desk.editing) return;
    if (!ready) { toast.fail('입력을 확인해요', '오류가 있는 항목을 고쳐요.'); return; }
    let body: Record<string, unknown>;
    try {
      body = passthroughBody(editKey, f);
    } catch {
      problem = '저장할 모양을 만들지 못했어요. 표시된 칸을 고치거나 아래 JSON으로 고쳐요.';
      return;
    }
    problem = undefined;
    void desk.putResource('passthroughRoute', editKey, body).then(after(resourcePath('passthroughRoute', editKey)));
  };
  const reset = (): void => { loaded = undefined; };
</script>

{#snippet fields()}
  <FormSection title="기본">
    {#if edit}
      <FormRow label="이름"><TextInput value={editKey} disabled /></FormRow>
    {:else}
      <FormRow label="이름" for="pr-key" error={nameErr}>
        <TextInput id="pr-key" bind:value={name} invalid={nameErr !== undefined} autocomplete="off" />
      </FormRow>
    {/if}
    <FormRow label="리스너" help={listeners.length === 0 ? 'TLS 패스스루 리스너가 없어요. 리스너를 먼저 만들어요.' : undefined}>
      <Select label="리스너" bind:value={f.listener} options={listeners} placeholder="리스너를 골라요" width="100%" disabled={listeners.length === 0} />
    </FormRow>
    <FormRow label="SNI" for="pr-sni" error={sniErr}>
      <TextInput id="pr-sni" bind:value={f.snis} invalid={sniErr !== undefined} autocomplete="off" />
    </FormRow>
    <FormRow label="우선순위" for="pr-prio" error={prioErr} help={PRIORITY_HELP}>
      <TextInput id="pr-prio" bind:value={f.priority} invalid={prioErr !== undefined} inputmode="numeric" autocomplete="off" />
    </FormRow>
  </FormSection>
  <FormSection title="동작">
    <FormRow label="동작"><Select label="동작" bind:value={f.action} options={ACTIONS} mono={false} width="100%" /></FormRow>
    {#if f.action === 'proxy'}
      <FormRow label="풀" help={pools.length === 0 ? 'TCP 풀이 없어요. 풀을 먼저 만들어요.' : undefined}>
        <Select label="풀" bind:value={f.pool} options={pools} placeholder="풀을 골라요" width="100%" disabled={pools.length === 0} />
        {#if shared !== undefined}<div class="wn">{shared}</div>{/if}
      </FormRow>
    {/if}
  </FormSection>
{/snippet}

{#if edit}
  {#if item !== undefined}
    <div class="edit">
      <Writable>
        <Form onsubmit={save}>
          {@render fields()}
          {#if problem !== undefined}<Banner tone="danger">{problem}</Banner>{/if}
          <RouteEditFoot {dirty} invalid={dirty && !ready} {pending} saving={desk.editing} onrevert={reset} />
        </Form>
      </Writable>
    </div>
  {/if}
{:else}
  <CreateForm {ready} onsubmit={submit} cancelHref="/traffic/route/passthrough">
    {@render fields()}
  </CreateForm>
{/if}

<style>
  .edit { max-width: 760px; }
  .wn { margin-top: 4px; font-size: 12px; color: var(--warn); }
</style>
