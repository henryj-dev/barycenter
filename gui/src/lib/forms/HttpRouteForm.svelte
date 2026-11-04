<script lang="ts">
  /**
   * HTTP 라우트 만들기 · 수정 (시안 `fieldsFor('routes')`: 기본 · 동작 · 출발지별 동작). 옛 폼 셋(풀로 보내기 · redirect ·
   * reject)을 「동작」 하나로 합쳤다. 만들기의 저장 경로는 그대로 셋이다(`insertHttpRoute` · `insertHttpRedirect` ·
   * `insertHttpReject`).
   * 경로 바꾸기 · 예시 요청 미리보기 · 이 라우트의 요청 헤더(#109)는 시안처럼 「동작」 안에 있다(풀로 보낼 때).
   * 경로 접두사 칸은 여럿을 받는다(2026-11-02) — 호스트 칸처럼 쉼표나 공백으로 나눈다.
   * 「출발지별 동작」(2026-11-02)에 규칙을 위에서부터 둔다 — `SourceRulesField`. 가려진 규칙은 입력 즉시 행 오류다.
   *
   * `edit` 이면 설정 탭의 수정 폼이다(시안: 「수정」 은 설정 탭) — head 값으로 한 번 채우고, 이름은 못 바꾸고, 같은 patch
   * 빌더로 몸통을 지어 `desk.putResource` 로 저장한다(`route-edit.ts`). 폼이 그리지 못하는 칸이 있으면 저장을 막고 JSON
   * 수정으로 보낸다.
   *
   * 호스트 · 경로 · 우선순위는 서버와 같은 판정으로 먼저 본다(`route-edit.ts`) — patch 빌더의 해라체 오류가 사람에게 가지 않게.
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { type RedirectStatus, type RejectStatus } from '@web/edit';
  import { Banner, Button, Form, FormRow, FormSection, KeyValueEditor, Select, Switch, TextInput } from '#lib/ui';
  import { itemOf, itemsOf, resourcePath } from '@web/resources';
  import { after } from '#lib/after';
  import Writable from '#lib/global/Writable.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import CreateForm from './CreateForm.svelte';
  import SourceRulesField, { rulesBlocked, toSourceRules } from './SourceRulesField.svelte';
  import { KEY_HELP, filled, keyError, words } from './checks';
  import { fromTokens, setCidrsOf } from './source-rules';
  import { exampleRequest, matchPrefix, rewriteError, rewritePath } from './rewrite';
  import {
    PRIORITY_HELP, httpRouteBody, httpRouteStateOf, poolShareCount, poolShareText, priorityError, routeHostsError, routePathsError,
    type HttpAction, type HttpRouteState,
  } from './route-edit';

  let { edit = false }: {
    /** 설정 탭의 수정 폼 — 키는 주소의 `[key]` 다. */
    edit?: boolean;
  } = $props();

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const listeners = $derived(desk.listeners.rows
    .filter((l) => (l.protocol === 'http' || l.protocol === 'https'))
    .map((l) => ({ value: l.key, hint: l.protocol })));
  const pools = $derived(desk.pools.rows.filter((p) => p.protocolClass === 'http').map((p) => ({ value: p.key })));
  const ACTIONS: { value: HttpAction; label: string }[] = [
    { value: 'proxy', label: '풀로 보내기' }, { value: 'redirect', label: 'redirect' }, { value: 'reject', label: 'reject' },
  ];
  const REDIRECT = ['301', '302', '307', '308'].map((v) => ({ value: v }));
  const REJECT = ['403', '404', '444'].map((v) => ({ value: v, ...(v === '444' ? { hint: '응답 없이 끊어요' } : {}) }));

  const blank = (): HttpRouteState => ({
    listener: undefined, hosts: '', pathPrefix: '', priority: '0', action: 'proxy', pool: undefined, websocket: false,
    rewritePrefix: '', headers: [], to: '', redirectStatus: '302', rejectStatus: '403', rules: [],
  });

  let name = $state('');
  let f = $state<HttpRouteState>(blank());
  let exPath = $state('');
  let hostTouched = $state(false);
  let problem = $state<string | undefined>();

  // ── 수정: head 값으로 한 번 채운다. 그 뒤 스트림이 모델을 바꿔도 입력 중인 값을 덮지 않는다.
  const editKey = $derived(edit ? page.params['key'] ?? '' : '');
  const item = $derived(edit ? itemOf(desk.model, 'httpRoute', editKey) : undefined);
  let loaded = $state<string | undefined>();
  let lossy = $state(false);
  $effect(() => {
    if (!edit || item === undefined || loaded === editKey) return;
    const s = httpRouteStateOf(item);
    f = s.state;
    lossy = s.lossy;
    exPath = '';
    problem = undefined;
    loaded = editKey;
  });
  const key = $derived(edit ? editKey : name.trim());

  $effect(() => { if (f.hosts.trim() !== '') hostTouched = true; });

  const sets = $derived(setCidrsOf(itemsOf(desk.model, 'addressSet')));
  const rulesBad = $derived(rulesBlocked(f.rules, sets));
  /** 경로 목록 — 비면 `/` 하나다(`routePaths`). 같은 경로는 한 번(`pathFieldsOf`). */
  const paths = $derived(((ps) => (ps.length === 0 ? ['/'] : ps))([...new Set(fromTokens(f.pathPrefix))]));
  const rw = $derived(f.rewritePrefix.trim());
  const rwErr = $derived(f.action === 'proxy' ? rewriteError(rw, paths) : undefined);
  // 예시 요청 → 백엔드로 가는 경로. 시안 「예시 요청」 미리보기.
  const req = $derived(exPath.trim() === '' ? exampleRequest(paths) : exPath.trim());
  const hit = $derived(matchPrefix(paths, req));
  const out = $derived(hit === undefined ? undefined : rewritePath(hit, rwErr === undefined ? rw : '', req));
  const outHelp = $derived(out === undefined ? '이 경로는 접두사와 맞지 않아요. 라우트에 걸리지 않아요.'
    : rw === '' || rwErr !== undefined ? '경로를 그대로 보내요.'
      : paths.length > 1 ? `경로마다 자기 접두사를 바꿔요. ${paths.map((p) => `${p} → ${rw}`).join(' · ')}`
        : `접두사 ${paths[0]}를 ${rw}로 바꿔 보내요.`);

  // 호스트는 필수다(서버 `putHttpRoutePatch`). 처음 빈 칸은 「만들기」 만 잠그고, 적었다 지우면 그때 말한다.
  const hostErr = $derived(f.hosts.trim() === '' && !hostTouched && !edit ? undefined : routeHostsError(f.hosts));
  const pathErr = $derived(routePathsError(f.pathPrefix));
  const pathWarn = $derived(f.pathPrefix.includes('*') ? '▲ * 는 일반 글자로 저장돼요. 접두사에는 쓰지 않아요.' : undefined);
  const prioErr = $derived(priorityError(f.priority));
  const shared = $derived(poolShareText(poolShareCount(
    [...itemsOf(desk.model, 'httpRoute'), ...itemsOf(desk.model, 'passthroughRoute')], f.action === 'proxy' ? f.pool : undefined, edit ? editKey : undefined,
  )));
  const ready = $derived(
    (edit ? item !== undefined && !lossy : filled(name, keyError)) && f.listener !== undefined
    && routeHostsError(f.hosts) === undefined && pathErr === undefined && prioErr === undefined
    && (f.action !== 'proxy' || f.pool !== undefined)
    && (f.action !== 'redirect' || filled(f.to))
    && rwErr === undefined && !rulesBad,
  );

  const submit = (): void => {
    if (f.listener === undefined) return;
    // 경로는 여럿일 수 있다 (2026-11-02). 하나면 `pathPrefix`, 여럿이면 `pathPrefixes` 로 싣는다(`pathFieldsOf`).
    const ps = fromTokens(f.pathPrefix);
    const sourceRules = toSourceRules(f.rules);
    const base = {
      key: key, listener: f.listener, hosts: words(f.hosts), priority: Number(f.priority.trim()),
      ...(ps.length === 0 ? {} : { pathPrefixes: ps }),
      ...(sourceRules.length === 0 ? {} : { sourceRules }),
    };
    if (f.action === 'proxy') {
      if (f.pool === undefined) return;
      const lines = f.headers.filter((h) => h.name.trim() !== '').map((h) => `${h.name.trim()}: ${h.value}`).join('\n');
      void desk.insertHttpRoute({
        ...base,
        pool: f.pool,
        ...(f.websocket ? { websocket: true } : {}),
        ...(f.rewritePrefix.trim() === '' ? {} : { rewritePrefix: f.rewritePrefix.trim() }),
        ...(lines === '' ? {} : { requestHeaders: lines }),
      }).then(after(resourcePath('httpRoute', base.key)));
    } else if (f.action === 'redirect') {
      void desk.insertHttpRedirect({ ...base, to: f.to.trim(), status: Number(f.redirectStatus) as RedirectStatus }).then(after(resourcePath('httpRoute', base.key)));
    } else {
      void desk.insertHttpReject({ ...base, status: Number(f.rejectStatus) as RejectStatus }).then(after(resourcePath('httpRoute', base.key)));
    }
  };

  /** 수정 저장 — 만들기와 같은 patch 빌더로 몸통을 짓고 통째로 갈아 끼운다(`put`). */
  const save = (): void => {
    if (!ready || desk.editing) return;
    let body: Record<string, unknown>;
    try {
      body = httpRouteBody(editKey, f);
    } catch {
      problem = '저장할 모양을 만들지 못했어요. 표시된 칸을 고치거나 아래 JSON으로 고쳐요.';
      return;
    }
    problem = undefined;
    void desk.putResource('httpRoute', editKey, body).then(after(resourcePath('httpRoute', editKey)));
  };
  const reset = (): void => { loaded = undefined; };
</script>

{#snippet fields()}
  <FormSection title="기본">
    {#if edit}
      <FormRow label="이름" help="이름은 바꿀 수 없어요."><TextInput value={editKey} disabled /></FormRow>
    {:else}
      <FormRow label="이름" for="hr-key" required error={keyError(name)} help={KEY_HELP}>
        <TextInput id="hr-key" bind:value={name} invalid={keyError(name) !== undefined} autocomplete="off" placeholder="app" />
      </FormRow>
    {/if}
    <FormRow label="리스너" required help={listeners.length === 0 ? 'HTTP · HTTPS 리스너가 없어요. 리스너를 먼저 만들어요.' : undefined}>
      <Select label="리스너" bind:value={f.listener} options={listeners} placeholder="리스너를 골라요" width="100%" disabled={listeners.length === 0} />
    </FormRow>
    <FormRow label="호스트" for="hr-hosts" required error={hostErr} help="정확한 이름이나 *.example.com 형태로 넣어요. 쉼표나 공백으로 여러 개를 넣어요.">
      <TextInput id="hr-hosts" bind:value={f.hosts} invalid={hostErr !== undefined} autocomplete="off" placeholder="app.example.com" />
    </FormRow>
    <FormRow label="경로 접두사" for="hr-path" error={pathErr} help={pathWarn ?? '이 접두사로 시작하는 요청과 맞아요. 쉼표나 공백으로 여러 개를 넣으면 같은 동작을 함께 써요. 비우면 모든 경로예요.'}>
      <TextInput id="hr-path" bind:value={f.pathPrefix} invalid={pathErr !== undefined} autocomplete="off" placeholder="/api/, /v2/" />
    </FormRow>
    <FormRow label="우선순위" for="hr-prio" required error={prioErr} help={PRIORITY_HELP}>
      <TextInput id="hr-prio" bind:value={f.priority} invalid={prioErr !== undefined} inputmode="numeric" width="120px" autocomplete="off" />
    </FormRow>
  </FormSection>

  <FormSection title="동작">
    <FormRow label="동작" required>
      <Select label="동작" bind:value={f.action} options={ACTIONS} mono={false} />
    </FormRow>
    {#if f.action === 'proxy'}
      <FormRow label="풀" required help={pools.length === 0 ? 'HTTP 풀이 없어요. 풀을 먼저 만들어요.' : shared === undefined ? undefined : `▲ ${shared}`}>
        <Select label="풀" bind:value={f.pool} options={pools} placeholder="풀을 골라요" width="100%" disabled={pools.length === 0} />
      </FormRow>
      <FormRow label="WebSocket" help="켜면 Upgrade 요청을 백엔드로 넘겨요."><Switch bind:checked={f.websocket}>켜요</Switch></FormRow>
      <FormRow label="경로 바꾸기" for="hr-rw" error={rwErr} help={rw === '' ? '비우면 경로를 그대로 보내요. 끝의 /는 접두사와 같아야 해요.' : '맞은 접두사를 이 값으로 바꿔요.'}>
        <TextInput id="hr-rw" bind:value={f.rewritePrefix} invalid={rwErr !== undefined} autocomplete="off" placeholder="/v1/" />
      </FormRow>
      <FormRow label="예시 요청" for="hr-ex" help={outHelp}>
        <div class="pv">
          <TextInput id="hr-ex" bind:value={exPath} autocomplete="off" placeholder={exampleRequest(paths)} />
          <span class="arrow" aria-hidden="true">→</span>
          <code class="out" class:miss={out === undefined} aria-label="백엔드로 가는 경로">{out ?? '—'}</code>
        </div>
      </FormRow>
      <FormRow label="이 라우트의 요청 헤더" help="같은 이름이면 리스너의 요청 헤더 대신 이 값을 보내요.">
        <KeyValueEditor bind:rows={f.headers} ops={[]} namePlaceholder="Host" addLabel="＋ 헤더를 더해요" />
      </FormRow>
    {:else if f.action === 'redirect'}
      <FormRow label="대상" for="hr-to" required help="이 주소로 보내요. 예: https://example.com/">
        <TextInput id="hr-to" bind:value={f.to} autocomplete="off" placeholder="https://example.com/" />
      </FormRow>
      <FormRow label="응답 코드" required><Select label="응답 코드" bind:value={f.redirectStatus} options={REDIRECT} width="120px" /></FormRow>
    {:else}
      <FormRow label="응답 코드" required><Select label="응답 코드" bind:value={f.rejectStatus} options={REJECT} width="200px" /></FormRow>
    {/if}
  </FormSection>

  <FormSection title="출발지별 동작" hint={f.rules.length === 0 ? '선택' : `규칙 ${f.rules.length}개`} stack>
    <p class="note">
      위에서부터 보고 처음 맞는 규칙의 동작을 해요. 맞는 규칙이 없으면 위의 기본 동작을 해요.
      리스너의 출발지 제한은 누가 붙을 수 있나를 정하고, 이 규칙은 출발지마다 어디로 보내나를 정해요.
    </p>
    <SourceRulesField bind:rules={f.rules} {pools} />
  </FormSection>
{/snippet}

{#if edit}
  {#if item !== undefined}
    <Writable>
      <Form note="저장하면 커밋해요. 트래픽은 적용 대기에서 적용해야 바뀌어요." onsubmit={save}>
        {#if lossy}
          <Banner tone="warn">출발지 규칙의 동작에 이 폼에 없는 칸(요청 헤더 · 경로 바꾸기)이 있어요. 폼으로 저장하면 그 칸이 사라져요. 아래 JSON으로 고쳐요.</Banner>
        {/if}
        {@render fields()}
        {#if problem !== undefined}<Banner tone="danger">{problem}</Banner>{/if}
        {#snippet actions()}
          <Button variant="primary" type="submit" loading={desk.editing} disabled={!ready}>{desk.editing ? '저장 중' : '저장'}</Button>
          <Button onclick={reset} disabled={desk.editing}>되돌리기</Button>
        {/snippet}
      </Form>
    </Writable>
  {/if}
{:else}
  <CreateForm {ready} onsubmit={submit} cancelHref="/traffic/route/http">
    {@render fields()}
  </CreateForm>
{/if}

<style>
  .note { margin: 0 0 8px; font: var(--t-small); color: var(--tx2); }
  .pv { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .pv :global(input) { flex: 1 1 200px; min-width: 0; }
  .arrow { color: var(--tx3); }
  .out { font-family: var(--mono); font-size: 13px; color: var(--tx); overflow-wrap: anywhere; }
  .out.miss { color: var(--warn); }
</style>
