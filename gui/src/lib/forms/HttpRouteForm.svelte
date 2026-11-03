<script lang="ts">
  /**
   * HTTP 라우트 만들기 (시안 구획: 기본 · 동작). 옛 폼 셋(풀로 보내기 · redirect · reject)을 「동작」 하나로
   * 합쳤다. 저장 경로는 그대로 셋이다(`insertHttpRoute` · `insertHttpRedirect` · `insertHttpReject`).
   * 경로 바꾸기 · 예시 요청 미리보기 · 이 라우트의 요청 헤더(#109)는 시안처럼 「동작」 안에 있다(풀로 보낼 때).
   * 경로 접두사 칸은 여럿을 받는다(2026-11-02) — 호스트 칸처럼 쉼표나 공백으로 나눈다.
   * 「출발지별 동작」(2026-11-02)에 규칙을 위에서부터 둔다 — `SourceRulesField`. 가려진 규칙은 입력 즉시 행 오류다.
   */
  import { getContext } from 'svelte';
  import { parsePathList, type RedirectStatus, type RejectStatus } from '@web/edit';
  import { FormRow, FormSection, KeyValueEditor, Select, Switch, TextInput, type KvRow } from '#lib/ui';
  import { itemsOf, resourcePath } from '@web/resources';
  import { after } from '#lib/after';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import CreateForm from './CreateForm.svelte';
  import SourceRulesField, { rulesBlocked, toSourceRules, type SourceRuleRow } from './SourceRulesField.svelte';
  import { KEY_HELP, filled, keyError, words } from './checks';
  import { setCidrsOf } from './source-rules';
  import { exampleRequest, matchPrefix, rewriteError, rewritePath } from './rewrite';

  type Action = 'proxy' | 'redirect' | 'reject';
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const listeners = $derived(desk.listeners.rows
    .filter((l) => (l.protocol === 'http' || l.protocol === 'https'))
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
  let rules = $state<SourceRuleRow[]>([]);
  let exPath = $state('');

  const sets = $derived(setCidrsOf(itemsOf(desk.model, 'addressSet')));
  const rulesBad = $derived(rulesBlocked(rules, sets));
  /** 경로 목록 — 비면 `/` 하나다(`routePaths`). */
  const paths = $derived(((ps) => (ps.length === 0 ? ['/'] : ps))(parsePathList(pathPrefix)));
  const rw = $derived(rewritePrefix.trim());
  const rwErr = $derived(action === 'proxy' ? rewriteError(rw, paths) : undefined);
  // 예시 요청 → 백엔드로 가는 경로. 시안 「예시 요청」 미리보기.
  const req = $derived(exPath.trim() === '' ? exampleRequest(paths) : exPath.trim());
  const hit = $derived(matchPrefix(paths, req));
  const out = $derived(hit === undefined ? undefined : rewritePath(hit, rwErr === undefined ? rw : '', req));
  const outHelp = $derived(out === undefined ? '이 경로는 접두사와 맞지 않아요. 라우트에 걸리지 않아요.'
    : rw === '' || rwErr !== undefined ? '경로를 그대로 보내요.'
      : paths.length > 1 ? `경로마다 자기 접두사를 바꿔요. ${paths.map((p) => `${p} → ${rw}`).join(' · ')}`
        : `접두사 ${paths[0]}를 ${rw}로 바꿔 보내요.`);

  const pathBad = $derived(pathPrefix.includes('*') ? '▲ * 는 일반 글자로 저장돼요. 접두사에는 쓰지 않아요.' : undefined);
  const ready = $derived(
    filled(key, keyError) && listener !== undefined
    && (action !== 'proxy' || pool !== undefined)
    && (action !== 'redirect' || filled(to))
    && rwErr === undefined && !rulesBad,
  );
  const submit = (): void => {
    if (listener === undefined) return;
    // 경로는 여럿일 수 있다 (2026-11-02). 하나면 `pathPrefix`, 여럿이면 `pathPrefixes` 로 싣는다(`pathFieldsOf`).
    const paths = parsePathList(pathPrefix);
    const sourceRules = toSourceRules(rules);
    const base = {
      key: key.trim(), listener, hosts: words(hosts),
      ...(paths.length === 0 ? {} : { pathPrefixes: paths }),
      ...(sourceRules.length === 0 ? {} : { sourceRules }),
    };
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
    <FormRow label="경로 접두사" for="hr-path" help={pathBad ?? '이 접두사로 시작하는 요청과 맞아요. 쉼표나 공백으로 여러 개를 넣으면 같은 동작을 함께 써요. 비우면 모든 경로예요.'}>
      <TextInput id="hr-path" bind:value={pathPrefix} autocomplete="off" placeholder="/api/, /v2/" />
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
      <FormRow label="경로 바꾸기" for="hr-rw" error={rwErr} help={rw === '' ? '비우면 경로를 그대로 보내요. 끝의 /는 접두사와 같아야 해요.' : '맞은 접두사를 이 값으로 바꿔요.'}>
        <TextInput id="hr-rw" bind:value={rewritePrefix} invalid={rwErr !== undefined} autocomplete="off" placeholder="/v1/" />
      </FormRow>
      <FormRow label="예시 요청" for="hr-ex" help={outHelp}>
        <div class="pv">
          <TextInput id="hr-ex" bind:value={exPath} autocomplete="off" placeholder={exampleRequest(paths)} />
          <span class="arrow" aria-hidden="true">→</span>
          <code class="out" class:miss={out === undefined} aria-label="백엔드로 가는 경로">{out ?? '—'}</code>
        </div>
      </FormRow>
      <FormRow label="이 라우트의 요청 헤더" help="같은 이름이면 리스너의 요청 헤더 대신 이 값을 보내요.">
        <KeyValueEditor bind:rows={headers} ops={[]} namePlaceholder="Host" addLabel="＋ 헤더를 더해요" />
      </FormRow>
    {:else if action === 'redirect'}
      <FormRow label="대상" for="hr-to" required help="이 주소로 보내요. 예: https://example.com/">
        <TextInput id="hr-to" bind:value={to} autocomplete="off" placeholder="https://example.com/" />
      </FormRow>
      <FormRow label="응답 코드" required><Select label="응답 코드" bind:value={redirectStatus} options={REDIRECT} width="120px" /></FormRow>
    {:else}
      <FormRow label="응답 코드" required><Select label="응답 코드" bind:value={rejectStatus} options={REJECT} width="200px" /></FormRow>
    {/if}
  </FormSection>

  <FormSection title="출발지별 동작" hint={rules.length === 0 ? '선택' : `규칙 ${rules.length}개`} stack>
    <p class="note">
      위에서부터 보고 처음 맞는 규칙의 동작을 해요. 맞는 규칙이 없으면 위의 기본 동작을 해요.
      리스너의 출발지 제한은 누가 붙을 수 있나를 정하고, 이 규칙은 출발지마다 어디로 보내나를 정해요.
    </p>
    <SourceRulesField bind:rules {pools} />
  </FormSection>
</CreateForm>

<style>
  .note { margin: 0 0 8px; font: var(--t-small); color: var(--tx2); }
  .pv { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .pv :global(input) { flex: 1 1 200px; min-width: 0; }
  .arrow { color: var(--tx3); }
  .out { font-family: var(--mono); font-size: 13px; color: var(--tx); overflow-wrap: anywhere; }
  .out.miss { color: var(--warn); }
</style>
