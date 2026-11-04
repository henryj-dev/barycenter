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
   */
  import { getContext } from 'svelte';
  import { parsePathList, type RedirectStatus, type RejectStatus } from '@web/edit';
  import { fallbackOfListener, routeGroupPatch, type GroupLine } from '@web/route-group';
  import { itemOf, itemsOf, resourcePath } from '@web/resources';
  import { Banner, Button, FieldMessage, FormRow, FormSection, Select, Switch, TextInput } from '#lib/ui';
  import { after } from '#lib/after';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import CreateForm from './CreateForm.svelte';
  import { KEY_HELP, filled, keyError, words } from './checks';
  import { fromTokens, groupKeyOf, setCidrsOf, sourceRuleErrors } from './source-rules';
  import { routeHostsError, routePathsError } from './route-edit';

  /** 줄 수 상한 — 시안과 같다. 라우트 하나의 규칙은 해독기가 20개로 막는다. */
  const MAX_LINES = 40;

  type Row = {
    paths: string; from: string; address: 'visitor' | 'connection';
    kind: 'proxy' | 'redirect' | 'reject'; pool: string | undefined; websocket: boolean;
    to: string; redirectStatus: string; rejectStatus: string;
  };
  const blank = (): Row => ({
    paths: '', from: '', address: 'visitor', kind: 'proxy', pool: undefined, websocket: false,
    to: '', redirectStatus: '302', rejectStatus: '444',
  });

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const listeners = $derived(desk.listeners.rows
    .filter((l) => (l.protocol === 'http' || l.protocol === 'https'))
    .map((l) => ({ value: l.key, hint: l.protocol })));
  const pools = $derived(desk.pools.rows.filter((p) => p.protocolClass === 'http').map((p) => ({ value: p.key })));
  const KINDS = [{ value: 'proxy', label: '풀로 보내기' }, { value: 'redirect', label: 'redirect' }, { value: 'reject', label: 'reject' }];
  const ADDRESS = [{ value: 'visitor', label: '방문자 주소' }, { value: 'connection', label: '연결 주소' }];
  const REDIRECT = ['301', '302', '307', '308'].map((v) => ({ value: v }));
  const REJECT = ['403', '404', '444'].map((v) => ({ value: v, ...(v === '444' ? { hint: '응답 없이 끊어요' } : {}) }));

  let key = $state('');
  let listener = $state<string | undefined>();
  let hosts = $state('');
  let rows = $state<Row[]>([blank()]);
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
          const b = o.body as { pathPrefix?: string; pathPrefixes?: string[]; sourceRules?: unknown[]; action: { kind: string; pool?: string; status?: number } };
          return {
            key: o.key,
            paths: (b.pathPrefixes ?? [b.pathPrefix ?? '/']).join(', '),
            rules: b.sourceRules?.length ?? 0,
            action: b.action.kind === 'proxy' ? `풀 ${b.action.pool ?? ''}` : `${b.action.kind} ${b.action.status ?? ''}`,
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

  const ready = $derived(filled(key, keyError) && listener !== undefined && routeHostsError(hosts) === undefined && !linesBad && preview.error === undefined && preview.routes.length > 0);

  const move = (i: number, d: -1 | 1): void => {
    const j = i + d;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j]!, next[i]!];
    rows = next;
  };

  const submit = (): void => {
    if (listener === undefined) return;
    void desk.insertRouteGroup({
      key: key.trim(), listener, hosts: words(hosts), lines: rows.map(lineOf),
      ...(fallback === undefined ? {} : { fallback }),
    }).then(after(resourcePath('httpRoute', key.trim()), `라우트 ${preview.routes.length}개를 커밋했어요`));
  };
</script>

<CreateForm {ready} onsubmit={submit} cancelHref="/traffic/route/http" note="만들면 라우트를 한 번에 커밋하고 적용 대기로 보내요.">
  <FormSection title="기본">
    <FormRow label="이름" for="rg-key" required error={keyError(key)} help={`${KEY_HELP} 묶음이 여럿이면 둘째부터 이름-p2 · 이름-p3 … 이 돼요.`}>
      <TextInput id="rg-key" bind:value={key} invalid={keyError(key) !== undefined} autocomplete="off" placeholder="counter.tinyuniver.se" />
    </FormRow>
    <FormRow label="리스너" required help={listener === undefined ? undefined : `기본 동작을 안 적은 경로는 리스너의 기본 동작을 따라요 — 지금: ${fallbackText}.`}>
      <Select label="리스너" bind:value={listener} options={listeners} placeholder="리스너를 골라요" width="100%" disabled={listeners.length === 0} />
    </FormRow>
    <FormRow label="호스트" for="rg-hosts" required error={hostErr} help="정확한 이름이나 *.example.com 형태로 넣어요. 쉼표나 공백으로 여러 개를 넣어요.">
      <TextInput id="rg-hosts" bind:value={hosts} invalid={hostErr !== undefined} autocomplete="off" placeholder="counter.example.com" />
    </FormRow>
  </FormSection>

  <FormSection title="경로별 동작" stack>
    <p class="note">
      줄마다 경로 · 출발지 · 동작을 적어요. 경로를 똑같이 적은 줄끼리 한 라우트가 돼요. 출발지를 비우면 그 경로의 기본 동작이에요.
      같은 경로 안에서는 위 줄부터 보고 처음 맞는 것을 써요.
    </p>
    {#each rows as row, i (i)}
      <fieldset class="line" aria-invalid={lineErrs[i] !== undefined || undefined}>
        <legend>{i + 1}번째 줄</legend>
        <FormRow label="경로" for="rg-paths-{i}" help="쉼표나 공백으로 여러 개. 비우면 / 예요.">
          <TextInput id="rg-paths-{i}" bind:value={row.paths} autocomplete="off" placeholder="/count.js, /count" />
        </FormRow>
        <FormRow label="출발지" for="rg-from-{i}" help="CIDR · IP · @주소집합. 비우면 그 밖의 모든 출발지예요.">
          <TextInput id="rg-from-{i}" bind:value={row.from} autocomplete="off" placeholder="@cloudflare-ips-v4, @cloudflare-ips-v6" />
        </FormRow>
        {#if row.from.trim() !== ''}
          <FormRow label="보는 주소" help={row.address === 'connection' ? '연결 주소 — 우리에게 직접 붙은 주소예요.' : '방문자 주소 — 원본 IP 헤더 · PROXY 수신 뒤의 주소예요.'}>
            <Select label="보는 주소" bind:value={row.address} options={ADDRESS} mono={false} />
          </FormRow>
        {/if}
        <FormRow label="동작"><Select label="동작" bind:value={row.kind} options={KINDS} mono={false} /></FormRow>
        {#if row.kind === 'proxy'}
          <FormRow label="풀"><Select label="풀" bind:value={row.pool} options={pools} placeholder="풀을 골라요" width="100%" /></FormRow>
          <FormRow label="WebSocket"><Switch bind:checked={row.websocket}>켜요</Switch></FormRow>
        {:else if row.kind === 'redirect'}
          <FormRow label="대상" for="rg-to-{i}"><TextInput id="rg-to-{i}" bind:value={row.to} autocomplete="off" placeholder="https://example.com/" /></FormRow>
          <FormRow label="응답 코드"><Select label="응답 코드" bind:value={row.redirectStatus} options={REDIRECT} width="120px" /></FormRow>
        {:else}
          <FormRow label="응답 코드"><Select label="응답 코드" bind:value={row.rejectStatus} options={REJECT} width="200px" /></FormRow>
        {/if}
        {#if lineErrs[i] !== undefined}<div class="err"><FieldMessage tone="error">{lineErrs[i]}</FieldMessage></div>{/if}
        <div class="act">
          <Button variant="text" size="sm" disabled={i === 0} aria-label="{i + 1}번째 줄을 위로" onclick={() => move(i, -1)}>↑ 위로</Button>
          <Button variant="text" size="sm" disabled={i === rows.length - 1} aria-label="{i + 1}번째 줄을 아래로" onclick={() => move(i, 1)}>↓ 아래로</Button>
          <Button variant="text" size="sm" disabled={rows.length === 1} aria-label="{i + 1}번째 줄을 지워요" onclick={() => { rows = rows.filter((_, j) => j !== i); }}>지워요</Button>
        </div>
      </fieldset>
    {/each}
    <div class="add">
      <Button variant="text" size="sm" disabled={rows.length >= MAX_LINES} onclick={() => { rows = [...rows, blank()]; }}>＋ 줄을 더해요</Button>
      {#if rows.length >= MAX_LINES}<FieldMessage tone={rows.length > MAX_LINES ? 'error' : 'help'}>줄은 {MAX_LINES}개까지예요.</FieldMessage>{/if}
    </div>
  </FormSection>

  <FormSection title="만들 라우트" hint={preview.error === undefined && !linesBad ? `라우트 ${preview.routes.length}개` : undefined} stack>
    {#if linesBad}
      <Banner tone="danger">잘못된 줄이 있어요. 표시된 줄을 고쳐요.</Banner>
    {:else if preview.error !== undefined}
      <Banner tone={preview.routes.length === 0 && key.trim() !== '' && listener !== undefined && routeHostsError(hosts) === undefined ? 'danger' : 'info'}>{preview.error}</Banner>
    {:else}
      <ul class="plan">
        {#each preview.routes as r (r.key)}
          <li>
            <code class="name">{r.key}</code>
            <span class="desc"><code>{r.paths}</code> · 출발지 규칙 {r.rules}개 · 기본 동작 {r.action}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </FormSection>
</CreateForm>

<style>
  .note { margin: 0 0 8px; font: var(--t-small); color: var(--tx2); }
  .line {
    grid-column: 1 / -1;
    border: 1px solid var(--bd); border-radius: var(--r-md); padding: 8px 12px 4px; margin: 0; min-width: 0;
    display: grid; grid-template-columns: 140px minmax(0, 1fr); gap: 8px 16px; align-items: start;
  }
  .line[aria-invalid='true'] { border-color: var(--danger); }
  legend { font: var(--t-cap); color: var(--tx2); padding: 0 4px; }
  .err, .act { grid-column: 1 / -1; }
  .act { display: flex; gap: 4px; justify-content: flex-end; padding-bottom: 4px; }
  .add { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
  .plan { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; font: var(--t-small); }
  .plan li { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; overflow-wrap: anywhere; }
  .name { font-family: var(--mono); color: var(--tx); }
  .desc { color: var(--tx2); }
  .desc code { font-family: var(--mono); }
  @media (max-width: 720px) { .line { grid-template-columns: minmax(0, 1fr); gap: 6px; } }
</style>
