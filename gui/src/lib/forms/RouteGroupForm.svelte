<script lang="ts">
  /**
   * **경로별 묶음으로 라우트 만들기** (2026-11-02). 한 호스트의 규칙을 줄로 적는다 — 경로 · 출발지 · 동작.
   *
   *   경로 /                  출발지 @cloudflare   동작 reject 444
   *   경로 /count.js, /count  출발지 @cloudflare   동작 풀로 보내기
   *
   * 저장하면 같은 뜻의 라우트 여럿으로 펼친다(`routeGroupPatch`) — 경로 목록이 같은 줄끼리 라우트 하나, 출발지가 있는 줄은
   * 그 라우트의 출발지 규칙, 출발지가 없는 줄은 그 라우트의 기본 동작이다. 기본 동작을 안 적은 경로는 **리스너의 기본
   * 동작**을 따른다(저장할 때의 값을 옮겨 적는다). 아래 「만들 라우트」 가 펼친 결과를 저장 전에 보인다.
   *
   * 줄 오류는 입력 즉시 그 줄 아래에 보인다(시안 `ruleErrs(lines, true)`) — 가려진 대역은 같은 라우트가 될 줄끼리만 비교하고
   * 「n번째 줄」 로 말한다(`sourceRuleErrors`). 경로가 다른 묶음과 섞이거나 기본 동작이 두 번이면 `routeGroupPatch` 가
   * 거절하는 것을 그 줄에서 먼저 말한다. 호스트 · 줄마다의 경로 모양과 「기본 동작을 정할 수 없는 묶음」 도 서버와 같은 판정으로
   * 먼저 본다(`route-edit.ts`) — `routeGroupPatch` 의 해라체 오류는 사람에게 보이지 않는다.
   *
   * 모양은 콘솔 시안 `fieldsFor('rgroup')` 그대로다(드로어 680px): 「기본」 · 「경로별 동작」(줄 카드 — `SourceRulesField withPath`) ·
   * 「만들 라우트」(풀어 쓴 결과 상자). 시안과 다른 곳: 리스너 칸 아래에 「리스너의 기본 동작을 따라요 — 지금: …」 를 둔다(이미 있는
   * 기능). 「만들 라우트」 상자가 비었을 때 시안의 「URL을 입력하면 …」 문구는 이 자리의 말이 아니라서 두지 않고 도움말만 보인다.
   */
  import { getContext } from 'svelte';
  import { parsePathList, type RedirectStatus, type RejectStatus } from '@web/edit';
  import { fallbackOfListener, routeGroupPatch, type GroupLine } from '@web/route-group';
  import { itemOf, itemsOf, resourcePath } from '@web/resources';
  import { FormRow, FormSection, Select, TextInput } from '#lib/ui';
  import { after } from '#lib/after';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import CreateForm from './CreateForm.svelte';
  import { filled, keyError, words } from './checks';
  import { fromTokens, groupKeyOf, setCidrsOf, sourceRuleErrors } from './source-rules';
  import { NAME_ERROR, routeHostsError, routePathsError } from './route-edit';
  import SourceRulesField, { emptyRule, type PathRuleRow } from './SourceRulesField.svelte';

  /** 줄 수 상한 — 시안과 같다. 라우트 하나의 규칙은 해독기가 20개로 막는다. */
  const MAX_LINES = 40;

  /** 줄 하나 — 규칙 줄에 경로가 붙는다(`SourceRulesField withPath`). */
  type Row = PathRuleRow;

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const listeners = $derived(desk.listeners.rows
    .filter((l) => (l.protocol === 'http' || l.protocol === 'https'))
    .map((l) => ({ value: l.key })));
  const pools = $derived(desk.pools.rows.filter((p) => p.protocolClass === 'http').map((p) => ({ value: p.key })));

  let key = $state('');
  let listener = $state<string | undefined>();
  let hosts = $state('');
  // 시안 `openGroup`: 줄 하나(풀로 보내기 · 첫 풀)로 연다.
  let rows = $state<Row[]>([{ ...emptyRule(), paths: '' }]);
  $effect(() => { const p = pools[0]?.value; if (p !== undefined && rows.length === 1 && rows[0]!.pool === undefined && rows[0]!.kind === 'proxy') rows[0]!.pool = p; });
  let hostTouched = $state(false);
  $effect(() => { if (hosts.trim() !== '') hostTouched = true; });
  // 호스트는 필수다. 처음 빈 칸은 「만들기」 만 잠그고, 적었다 지우면 그때 말한다.
  const hostErr = $derived(hosts.trim() === '' && !hostTouched ? undefined : routeHostsError(hosts));

  const fallback = $derived.by(() => {
    if (listener === undefined) return undefined;
    const l = itemOf(desk.model, 'listener', listener);
    const http = l?.['http'];
    return fallbackOfListener(http !== null && typeof http === 'object' ? (http as Record<string, unknown>)['defaultAction'] : undefined);
  });
  const fallbackText = $derived(fallback === undefined ? '정해지지 않음'
    : fallback.kind === 'proxy' ? `풀로 보내기 (${fallback.pool})`
      : fallback.kind === 'reject' ? `reject ${fallback.status}` : `redirect ${fallback.status}`);

  const lineOf = (r: Row): GroupLine => ({
    paths: parsePathList(r.paths),
    from: r.from.split(/[\s,]+/).map((x) => x.trim()).filter((x) => x !== ''),
    ...(r.address === 'connection' ? { address: 'connection' as const } : {}),
    action: r.kind === 'proxy' ? { kind: 'proxy', pool: r.pool ?? '', websocket: r.websocket }
      : r.kind === 'redirect' ? { kind: 'redirect', to: r.to.trim(), status: Number(r.redirectStatus) as RedirectStatus }
        : { kind: 'reject', status: Number(r.rejectStatus) as RejectStatus },
  });

  /** 펼친 결과 — 저장 전에 보인다. 못 펼치면 그 이유다. */
  const preview = $derived.by((): { routes: { key: string; paths: string; rules: number; action: string }[]; error?: string } => {
    if (key.trim() === '' || listener === undefined || routeHostsError(hosts) !== undefined) return { routes: [], error: '이름 · 리스너 · 호스트를 넣으면 만들 라우트가 보여요.' };
    try {
      const ops = routeGroupPatch({
        key: key.trim(), listener, hosts: words(hosts), lines: rows.map(lineOf),
        ...(fallback === undefined ? {} : { fallback }),
      });
      return {
        routes: ops.map((o) => {
          const b = o.body as { pathPrefix?: string; pathPrefixes?: string[]; sourceRules?: unknown[]; action: { kind: string; pool?: string; status?: number; websocket?: boolean; to?: string } };
          return {
            key: o.key,
            paths: (b.pathPrefixes ?? [b.pathPrefix ?? '/']).join(', '),
            rules: b.sourceRules?.length ?? 0,
            // 시안 `actLabel`.
            action: b.action.kind === 'proxy' ? `풀 ${b.action.pool ?? ''}${b.action.websocket === true ? ' · WebSocket' : ''}`
              : b.action.kind === 'redirect' ? `redirect ${b.action.status ?? ''} → ${b.action.to ?? ''}` : `reject ${b.action.status ?? ''}`,
          };
        }),
      };
    } catch {
      // 줄 오류가 먼저 잡는다. 그래도 빌더가 거절하면 그 해라체 문구 대신 해요체로 말한다.
      return { routes: [], error: '만들 라우트를 펼치지 못했어요. 표시된 칸을 고쳐요.' };
    }
  });

  const sets = $derived(setCidrsOf(itemsOf(desk.model, 'addressSet')));
  /** 줄마다 오류 — 위 줄의 오류를 먼저 말한다. 없으면 `undefined`. */
  const lineErrs = $derived.by((): (string | undefined)[] => {
    const shadow = sourceRuleErrors(rows.map((r) => ({ from: r.from, address: r.address, paths: r.paths })), sets, { lines: true });
    const owner = new Map<string, string>();
    const defaults = new Set<string>();
    // 기본 동작을 정할 수 없는 묶음 — 출발지 없는 줄이 없고 리스너의 기본 동작도 모른다. 그 묶음의 첫 줄에서 말한다.
    const noDefault = new Set(listener === undefined || fallback !== undefined ? [] : rows.map((r) => groupKeyOf(r.paths))
      .filter((gk) => !rows.some((r) => groupKeyOf(r.paths) === gk && fromTokens(r.from).length === 0)));
    const told = new Set<string>();
    return rows.map((r, i) => {
      const gk = groupKeyOf(r.paths);
      const ps = [...new Set(fromTokens(r.paths))];
      let err: string | undefined = routePathsError(r.paths);
      if (noDefault.has(gk) && !told.has(gk)) {
        told.add(gk);
        err ??= '이 경로의 기본 동작이 없어요. 출발지를 비운 줄을 하나 더하거나 리스너의 기본 동작을 정해요.';
      }
      for (const p of ps.length === 0 ? ['/'] : ps) {
        const o = owner.get(p);
        if (o !== undefined && o !== gk) err ??= `경로 ${p}가 다른 줄 묶음에도 있어요. 경로를 똑같이 적어요.`;
        if (o === undefined) owner.set(p, gk);
      }
      if (fromTokens(r.from).length === 0) {
        if (defaults.has(gk)) err ??= '이 경로의 기본 동작이 두 번 나왔어요. 한 줄만 비워요.';
        defaults.add(gk);
      }
      err ??= shadow[i];
      if (r.kind === 'proxy' && r.pool === undefined) err ??= '풀을 골라요.';
      if (r.kind === 'redirect' && r.to.trim() === '') err ??= '이동할 URL을 넣어요.';
      return err;
    });
  });
  const linesBad = $derived(rows.length > MAX_LINES || lineErrs.some((e) => e !== undefined));

  /** 「만들 라우트」 를 보일 수 있나 — 이름 · 리스너 · 호스트가 맞고 줄에 오류가 없다(시안 `ready && !e.lines`). */
  const planReady = $derived(filled(key, keyError) && listener !== undefined && routeHostsError(hosts) === undefined && !linesBad && preview.error === undefined);
  /** 다 넣었는데 펼치지 못했다 — 그 까닭(해요체). */
  const planErr = $derived(!linesBad && preview.error !== undefined && key.trim() !== '' && listener !== undefined && routeHostsError(hosts) === undefined ? preview.error : undefined);
  const ready = $derived(filled(key, keyError) && listener !== undefined && routeHostsError(hosts) === undefined && !linesBad && preview.error === undefined && preview.routes.length > 0);

  const submit = (): void => {
    if (listener === undefined) return;
    void desk.insertRouteGroup({
      key: key.trim(), listener, hosts: words(hosts), lines: rows.map(lineOf),
      ...(fallback === undefined ? {} : { fallback }),
    }).then(after(resourcePath('httpRoute', key.trim()), `라우트 ${preview.routes.length}개를 커밋했어요`));
  };
</script>

<CreateForm {ready} onsubmit={submit} cancelHref="/traffic/route/http">
  <FormSection title="기본">
    <FormRow label="이름" for="rg-key" error={keyError(key) === undefined ? undefined : NAME_ERROR} help="첫 라우트는 이 이름이에요. 다음은 이름-p2, 이름-p3 순서예요.">
      <TextInput id="rg-key" bind:value={key} invalid={keyError(key) !== undefined} autocomplete="off" />
    </FormRow>
    <FormRow label="리스너" help={listener === undefined ? undefined : `기본 동작을 안 적은 경로는 리스너의 기본 동작을 따라요 — 지금: ${fallbackText}.`}>
      <Select label="리스너" bind:value={listener} options={listeners} placeholder="리스너를 골라요" width="100%" disabled={listeners.length === 0} />
    </FormRow>
    <FormRow label="호스트" for="rg-hosts" error={hostErr} help="정확한 이름이나 *.example.com 형태예요. 쉼표나 공백으로 여러 개를 입력해요.">
      <TextInput id="rg-hosts" bind:value={hosts} invalid={hostErr !== undefined} autocomplete="off" />
    </FormRow>
  </FormSection>

  <FormSection title="경로별 동작">
    <FormRow label="경로별 동작" error={rows.length === 0 ? '줄을 하나 이상 입력해요.' : linesBad ? '잘못된 줄이 있어요. 표시된 행을 고쳐요.' : undefined}
      help="줄마다 경로 · 출발지 · 동작을 적어요. 경로를 똑같이 적은 줄끼리 한 라우트가 돼요. 출발지를 비우면 그 경로의 기본 동작이에요.">
      <SourceRulesField bind:rules={rows} {pools} withPath errors={lineErrs} make={(pool) => ({ ...emptyRule(pool), paths: '' })} />
    </FormRow>
  </FormSection>

  <FormSection title="만들 라우트">
    <FormRow label="라우트" error={planErr} help={planReady ? undefined : '이름 · 리스너 · 호스트를 넣으면 만들 라우트가 보여요.'}>
      <div class="res">
        {#each planReady ? preview.routes : [] as r (r.key)}
          <div class="ri"><span class="k">{r.key}</span><span class="v">{r.paths} · 출발지 규칙 {r.rules}개 · 기본 동작 {r.action}</span></div>
        {/each}
      </div>
    </FormRow>
  </FormSection>
</CreateForm>

<style>
  /* 시안 `resolved` 상자 — 84px · 나머지, 12px, 값은 고정폭. */
  .res { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; min-height: 34px; background: var(--bg-page); border: 1px solid var(--bd); border-radius: var(--r-md); }
  .ri { display: grid; grid-template-columns: 84px minmax(0, 1fr); gap: 8px; font-size: 12px; }
  .k { color: var(--tx3); overflow-wrap: anywhere; }
  .v { font-family: var(--mono); word-break: break-all; }
</style>
