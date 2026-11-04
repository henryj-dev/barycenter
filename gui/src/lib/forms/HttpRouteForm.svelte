<script lang="ts">
  /**
   * HTTP 라우트 만들기 · 수정 — 콘솔 시안 `fieldsFor('routes', v, creating)` 그대로: 「기본」(이름 · 리스너 · 호스트 · 경로 접두사 ·
   * 우선순위) · 「동작」(동작 · 풀 · 대상 · 응답 코드 · 경로 바꾸기 · 예시 요청 · 이 라우트의 요청 헤더) · 「출발지별 동작」(규칙).
   * 만들기의 저장 경로는 셋이다(`insertHttpRoute` · `insertHttpRedirect` · `insertHttpReject`). 경로 접두사 칸은 여럿을 받는다
   * (2026-11-02) — 쉼표나 공백으로 나눈다. 규칙은 `SourceRulesField` 이고, 가려진 규칙은 입력 즉시 그 카드의 오류다.
   *
   * `edit` 이면 설정 탭의 수정 폼이다(시안 `dpEdit` → 설정 탭, `fieldsFor(…, false, 'form')`) — head 값으로 한 번 채우고,
   * 이름은 잠그고, 같은 patch 빌더로 몸통을 지어 `desk.putResource` 로 저장한다(`route-edit.ts`). 콘솔 격자(150px · 480px)이고
   * 아래 줄은 시안 `tSet` 의 안내 · 되돌리기 · 저장이다(`RouteEditFoot`). 폼이 그리지 못하는 칸이 있으면 저장을 막고 JSON 수정으로 보낸다.
   *
   * 호스트 · 경로 · 우선순위는 서버와 같은 판정으로 먼저 본다(`route-edit.ts`) — patch 빌더의 해라체 오류가 사람에게 가지 않게.
   *
   * 시안과 다른 곳(실제 동작이 다르다 · 이미 있는 기능):
   *   · reject 응답 코드는 403 · 404 · 444 다(렌더가 받는 값). 시안의 410 · 503 은 없다.
   *   · 「WebSocket」 토글은 시안 폼에 없지만 이미 있는 기능이라 「동작」 의 풀 아래에 둔다.
   *   · 풀이 외부 주소인지(시안 「외부 주소 풀이에요: …」)는 모델에 없어서 말하지 않는다.
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { type RedirectStatus, type RejectStatus } from '@web/edit';
  import { Banner, Form, FormRow, FormSection, KeyValueEditor, Select, Switch, TextInput, setFormLayout, toast } from '#lib/ui';
  import { itemOf, itemsOf, resourcePath } from '@web/resources';
  import { after } from '#lib/after';
  import { isPendingResource } from '#lib/pending';
  import Writable from '#lib/global/Writable.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import CreateForm from './CreateForm.svelte';
  import RouteEditFoot from './RouteEditFoot.svelte';
  import SourceRulesField, { rulesBlocked, toSourceRules } from './SourceRulesField.svelte';
  import { filled, keyError, words } from './checks';
  import { fromTokens, setCidrsOf } from './source-rules';
  import { exampleRequest, matchPrefix, rewriteError, rewritePath } from './rewrite';
  import {
    NAME_ERROR, PLAIN_HEADER_WARN, PRIORITY_HELP, RULES_HELP, httpRouteBody, httpRouteStateOf, plainHeader, poolShareCount, poolShareText,
    priorityError, routeHostsError, routePathsError, type HttpAction, type HttpRouteState,
  } from './route-edit';

  let { edit = false }: {
    /** 설정 탭의 수정 폼 — 키는 주소의 `[key]` 다. */
    edit?: boolean;
  } = $props();
  // 설정 탭도 콘솔 격자다(드로어는 Drawer 가 정한다).
  // svelte-ignore state_referenced_locally
  if (edit) setFormLayout('compact');

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const listeners = $derived(desk.listeners.rows
    .filter((l) => (l.protocol === 'http' || l.protocol === 'https'))
    .map((l) => ({ value: l.key })));
  const pools = $derived(desk.pools.rows.filter((p) => p.protocolClass === 'http').map((p) => ({ value: p.key })));
  const ACTIONS: { value: HttpAction; label: string }[] = [
    { value: 'proxy', label: '풀로 보내기' }, { value: 'redirect', label: 'redirect' }, { value: 'reject', label: 'reject' },
  ];
  const REDIRECT = ['301', '302', '307', '308'].map((v) => ({ value: v }));
  const REJECT = ['403', '404', '444'].map((v) => ({ value: v }));

  // 시안 `newDefaults('routes')`: 경로 / · 우선순위 100 · 풀로 보내기 · redirect 301.
  const blank = (): HttpRouteState => ({
    listener: undefined, hosts: '', pathPrefix: '/', priority: '100', action: 'proxy', pool: undefined, websocket: false,
    rewritePrefix: '', headers: [], to: '', redirectStatus: '301', rejectStatus: '403', rules: [],
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
  let orig = $state('');
  $effect(() => {
    if (!edit || item === undefined || loaded === editKey) return;
    const s = httpRouteStateOf(item);
    f = s.state;
    orig = JSON.stringify(s.state);
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

  const nameErr = $derived(keyError(name) === undefined ? undefined : NAME_ERROR);
  // 호스트는 필수다(서버 `putHttpRoutePatch`). 처음 빈 칸은 「만들기」 만 잠그고, 적었다 지우면 그때 말한다.
  const hostErr = $derived(f.hosts.trim() === '' && !hostTouched && !edit ? undefined : routeHostsError(f.hosts));
  const pathErr = $derived(routePathsError(f.pathPrefix));
  const pathWarn = $derived(f.pathPrefix.includes('*') && pathErr === undefined);
  const prioErr = $derived(priorityError(f.priority));
  const shared = $derived(poolShareText(poolShareCount(
    [...itemsOf(desk.model, 'httpRoute'), ...itemsOf(desk.model, 'passthroughRoute')], f.action === 'proxy' ? f.pool : undefined, edit ? editKey : undefined,
  )));
  const headerWarn = $derived(f.headers.some((h) => plainHeader(h.name)));
  const ready = $derived(
    (edit ? item !== undefined && !lossy : filled(name, keyError)) && f.listener !== undefined
    && routeHostsError(f.hosts) === undefined && pathErr === undefined && prioErr === undefined
    && (f.action !== 'proxy' || f.pool !== undefined)
    && (f.action !== 'redirect' || filled(f.to))
    && rwErr === undefined && !rulesBad,
  );
  // 설정 탭의 아래 줄(시안 `hintTxt`).
  const dirty = $derived(edit && loaded !== undefined && JSON.stringify(f) !== orig);
  const pending = $derived(edit && isPendingResource(desk.pendingResources, 'httpRoute', editKey));

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
    if (!dirty || desk.editing) return;
    if (!ready) { toast.fail('입력을 확인해요', '오류가 있는 항목을 고쳐요.'); return; }
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
      <FormRow label="이름"><TextInput value={editKey} disabled /></FormRow>
    {:else}
      <FormRow label="이름" for="hr-key" error={nameErr}>
        <TextInput id="hr-key" bind:value={name} invalid={nameErr !== undefined} autocomplete="off" />
      </FormRow>
    {/if}
    <FormRow label="리스너" help={listeners.length === 0 ? 'HTTP · HTTPS 리스너가 없어요. 리스너를 먼저 만들어요.' : undefined}>
      <Select label="리스너" bind:value={f.listener} options={listeners} placeholder="리스너를 골라요" width="100%" disabled={listeners.length === 0} />
    </FormRow>
    <FormRow label="호스트" for="hr-hosts" error={hostErr} help="정확한 이름이나 *.example.com 형태로 입력해요.">
      <TextInput id="hr-hosts" bind:value={f.hosts} invalid={hostErr !== undefined} autocomplete="off" />
    </FormRow>
    <FormRow label="경로 접두사" for="hr-path" error={pathErr} help={pathWarn ? undefined : '쉼표나 공백으로 여러 개. 비우면 / 예요. *는 쓰지 않아요.'}>
      <TextInput id="hr-path" bind:value={f.pathPrefix} invalid={pathErr !== undefined} autocomplete="off"
        oninput={(e) => { f.pathPrefix = e.currentTarget.value.replace(/\/{2,}/g, '/'); }} />
      {#if pathWarn}<div class="wn">▲ *는 일반 글자로 저장돼요. 접두사에는 쓰지 않아요.</div>{/if}
    </FormRow>
    <FormRow label="우선순위" for="hr-prio" error={prioErr} help={PRIORITY_HELP}>
      <TextInput id="hr-prio" bind:value={f.priority} invalid={prioErr !== undefined} inputmode="numeric" autocomplete="off" />
    </FormRow>
  </FormSection>

  <FormSection title="동작">
    <FormRow label="동작">
      <Select label="동작" bind:value={f.action} options={ACTIONS} mono={false} width="100%" />
    </FormRow>
    {#if f.action === 'proxy'}
      <FormRow label="풀" help={pools.length === 0 ? 'HTTP 풀이 없어요. 풀을 먼저 만들어요.' : undefined}>
        <Select label="풀" bind:value={f.pool} options={pools} placeholder="풀을 골라요" width="100%" disabled={pools.length === 0} />
        {#if shared !== undefined}<div class="wn">{shared}</div>{/if}
      </FormRow>
      <FormRow label="WebSocket" help="켜면 Upgrade 요청을 백엔드로 넘겨요."><Switch bind:checked={f.websocket}>{f.websocket ? '켜짐' : '꺼짐'}</Switch></FormRow>
    {:else if f.action === 'redirect'}
      <FormRow label="대상" for="hr-to" error={f.to.trim() === '' ? '대상 URL을 입력해요.' : undefined}>
        <TextInput id="hr-to" bind:value={f.to} autocomplete="off" />
      </FormRow>
    {/if}
    {#if f.action === 'redirect'}
      <FormRow label="응답 코드"><Select label="응답 코드" bind:value={f.redirectStatus} options={REDIRECT} width="100%" /></FormRow>
    {:else if f.action === 'reject'}
      <FormRow label="응답 코드"><Select label="응답 코드" bind:value={f.rejectStatus} options={REJECT} width="100%" /></FormRow>
    {/if}
    {#if f.action === 'proxy'}
      <FormRow label="경로 바꾸기" for="hr-rw" error={rwErr} help={rw === '' ? '비우면 경로를 그대로 보내요.' : '맞은 접두사를 이 값으로 바꿔요.'}>
        <TextInput id="hr-rw" bind:value={f.rewritePrefix} invalid={rwErr !== undefined} autocomplete="off"
          oninput={(e) => { const v = e.currentTarget.value.replace(/\/{2,}/g, '/'); f.rewritePrefix = v !== '' && !v.startsWith('/') ? `/${v}` : v; }} />
      </FormRow>
      <FormRow label="예시 요청" for="hr-ex">
        <div class="pv">
          <div class="pvq"><span class="get">GET</span><TextInput id="hr-ex" aria-label="예시 요청 경로" value={req} autocomplete="off" oninput={(e) => { exPath = e.currentTarget.value; }} /></div>
          <div class="out" class:miss={out === undefined} aria-label="백엔드로 가는 경로">→ {out ?? '—'}</div>
        </div>
        <div class="ph" class:warn={out === undefined}>{outHelp}</div>
      </FormRow>
      <FormRow label="이 라우트의 요청 헤더" help={headerWarn ? undefined : '같은 이름이면 리스너의 요청 헤더 대신 이 값을 보내요.'}>
        <KeyValueEditor bind:rows={f.headers} ops={[]} namePlaceholder="Header-Name" addLabel="＋ 행 추가" />
        {#if headerWarn}<div class="wn">같은 이름이면 리스너의 요청 헤더 대신 이 값을 보내요. {PLAIN_HEADER_WARN}</div>{/if}
      </FormRow>
    {/if}
  </FormSection>

  <FormSection title="출발지별 동작">
    <FormRow label="규칙" error={f.rules.length > 20 ? '규칙은 20개까지예요.' : rulesBad ? '잘못된 규칙이 있어요. 표시된 행을 고쳐요.' : undefined} help={RULES_HELP}>
      <SourceRulesField bind:rules={f.rules} {pools} />
    </FormRow>
  </FormSection>
{/snippet}

{#if edit}
  {#if item !== undefined}
    <div class="edit">
      <Writable>
        <Form onsubmit={save}>
          {#if lossy}
            <Banner tone="warn">출발지 규칙의 동작에 이 폼에 없는 칸(요청 헤더 · 경로 바꾸기)이 있어요. 폼으로 저장하면 그 칸이 사라져요. 아래 JSON으로 고쳐요.</Banner>
          {/if}
          {@render fields()}
          {#if problem !== undefined}<Banner tone="danger">{problem}</Banner>{/if}
          <RouteEditFoot {dirty} invalid={dirty && !ready} {pending} saving={desk.editing} onrevert={reset} />
        </Form>
      </Writable>
    </div>
  {/if}
{:else}
  <CreateForm {ready} onsubmit={submit} cancelHref="/traffic/route/http">
    {@render fields()}
  </CreateForm>
{/if}

<style>
  .edit { max-width: 760px; }
  .wn { margin-top: 4px; font-size: 12px; color: var(--warn); }
  .pv { display: flex; flex-direction: column; gap: 6px; }
  .pvq { display: flex; align-items: center; gap: 6px; }
  .pvq :global(input) { flex: 1; min-width: 0; }
  .get { font-family: var(--mono); font-size: 12px; color: var(--tx3); }
  .out { font-family: var(--mono); font-size: 13px; color: var(--tx); word-break: break-all; }
  .out.miss { color: var(--warn); }
  .ph { margin-top: 4px; font-size: 12px; color: var(--tx3); }
  .ph.warn { color: var(--warn); }
</style>
