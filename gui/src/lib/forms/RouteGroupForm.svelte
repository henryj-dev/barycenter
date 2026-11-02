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
   */
  import { getContext } from 'svelte';
  import { parsePathList, type RedirectStatus, type RejectStatus } from '@web/edit';
  import { fallbackOfListener, routeGroupPatch, type GroupLine } from '@web/route-group';
  import { itemOf, resourcePath } from '@web/resources';
  import { Banner, Button, FormRow, FormSection, Select, Switch, TextInput } from '#lib/ui';
  import { after } from '#lib/after';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import CreateForm from './CreateForm.svelte';
  import { KEY_HELP, filled, keyError, words } from './checks';

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
    if (key.trim() === '' || listener === undefined || words(hosts).length === 0) return { routes: [], error: '이름 · 리스너 · 호스트를 넣으면 만들 라우트가 보여요.' };
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
    } catch (e) {
      return { routes: [], error: e instanceof Error ? e.message : String(e) };
    }
  });

  const ready = $derived(filled(key, keyError) && listener !== undefined && preview.error === undefined && preview.routes.length > 0);

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
    <FormRow label="호스트" for="rg-hosts" help="쉼표나 공백으로 여러 개를 넣어요.">
      <TextInput id="rg-hosts" bind:value={hosts} autocomplete="off" placeholder="counter.example.com" />
    </FormRow>
  </FormSection>

  <FormSection title="경로별 동작">
    <p class="note">
      줄마다 경로 · 출발지 · 동작을 적어요. 경로를 똑같이 적은 줄끼리 한 라우트가 돼요. 출발지를 비우면 그 경로의 기본 동작이에요.
      같은 경로 안에서는 위 줄부터 보고 처음 맞는 것을 써요.
    </p>
    {#each rows as row, i (i)}
      <fieldset class="line">
        <legend>줄 {i + 1}</legend>
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
        <div class="act">
          <Button variant="text" size="sm" disabled={i === 0} onclick={() => move(i, -1)}>위로</Button>
          <Button variant="text" size="sm" disabled={i === rows.length - 1} onclick={() => move(i, 1)}>아래로</Button>
          <Button variant="text" size="sm" disabled={rows.length === 1} onclick={() => { rows = rows.filter((_, j) => j !== i); }}>지워요</Button>
        </div>
      </fieldset>
    {/each}
    <div class="add"><Button variant="text" size="sm" onclick={() => { rows = [...rows, blank()]; }}>＋ 줄을 더해요</Button></div>
  </FormSection>

  <FormSection title="만들 라우트">
    {#if preview.error !== undefined}
      <Banner tone={preview.routes.length === 0 && key.trim() !== '' && listener !== undefined && words(hosts).length > 0 ? 'danger' : 'info'}>{preview.error}</Banner>
    {:else}
      <ul class="plan">
        {#each preview.routes as r (r.key)}
          <li><code>{r.key}</code> — 경로 <code>{r.paths}</code> · 기본 {r.action}{r.rules > 0 ? ` · 출발지 규칙 ${r.rules}개` : ''}</li>
        {/each}
      </ul>
    {/if}
  </FormSection>
</CreateForm>

<style>
  .note { margin: 0 0 8px; font-size: 13px; color: var(--tx2); }
  .line { border: 1px solid var(--bd); border-radius: 8px; padding: 8px 12px 4px; margin: 0 0 12px; min-width: 0; }
  legend { font-size: 12px; color: var(--tx2); padding: 0 4px; }
  .act { display: flex; gap: 4px; justify-content: flex-end; padding-bottom: 4px; }
  .plan { margin: 0; padding-left: 18px; font-size: 13px; }
  .plan li { margin: 2px 0; overflow-wrap: anywhere; }
</style>
