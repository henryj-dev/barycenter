<script lang="ts">
  /**
   * HTTP 라우트 목록 — 시안 `page === 'routes'`. 라우트 하나가 한 줄이다. 경로가 여럿이면 첫 경로 + 「+N」 배지이고,
   * 마우스를 올리면 전체가 보인다. 출발지 규칙 · 이 라우트의 요청 헤더는 수 배지다.
   *
   * 「평가 순서」 는 **엔진이 실제로 평가하는 순서**다(`desk.routes.order` — 매치 클래스 → 우선순위 → 경로 길이). 호스트 ·
   * 경로가 여럿인 라우트는 엔진이 여러 번 보므로 가장 먼저 보는 자리를 적는다. 줄도 그 순서로 늘어놓는다.
   * 더 높은 클래스의 라우트가 먼저 잡는 라우트(`priority_inversion`)는 「#n · 가려짐」 경고 배지이고, 마우스를 올리면 이유다.
   * 가림 · 오류는 위에 배너로도 먼저 말한다.
   * 행을 누르면 아래에 분할 상세가 열린다(`ListSplit`) — 풀로 보내는 라우트는 「URL로 다시 만들기」 도 있다(시안).
   *
   * **전체 합산**(전역에서 지역을 안 골랐다, §2.5)이면 지역마다 행을 만들어 잇고, 셋째 열 뒤에 「지역」 열을 둔다.
   * 평가 순서 `#n` · 가려짐은 **지역마다 따로** 센다 — 엔진은 지역마다 하나이고, 다른 지역의 라우트는 서로 가리지 않는다.
   * 줄도 지역 순서대로, 지역 안에서는 그 지역의 평가 순서대로다. 배너는 지역 이름을 달고 지역마다 말한다.
   * 행의 수정 · 상세 · 다시 만들기는 그 지역으로 좁혀 열고, 삭제는 그 지역의 desk 로 쓴다. 만들기 · 경로별 묶음은 지역을 먼저 고른다.
   */
  import { getContext } from 'svelte';
  import { goto } from '$app/navigation';
  import { itemsOf, resourcePath } from '@web/resources';
  import { Badge, Banner, Button, DataTable, type Column, type MenuItem } from '#lib/ui';
  import { usePageActions } from '#lib/shell/page-actions.svelte.ts';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import WriteNote from '#lib/global/WriteNote.svelte';
  import InRegion from '#lib/global/InRegion.svelte';
  import RegionCreate from '#lib/global/RegionCreate.svelte';
  import RegionNotices from '#lib/global/RegionNotices.svelte';
  import { regionColumn, useAggregate } from '#lib/global/use-aggregate.svelte.ts';
  import { withRegionColumn, type RegionRow } from '#lib/global/aggregate.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import ListSplit from '#lib/detail/ListSplit.svelte';
  import DeleteConfirm from './DeleteConfirm.svelte';
  import PendingMark from './PendingMark.svelte';
  import RouteSegments from './RouteSegments.svelte';
  import { routeOrder } from './route-order';

  type Act = { kind: string; pool?: string; websocket?: boolean; to?: string; status?: number; rewritePrefix?: string; requestHeaders?: unknown[] };
  type Row = {
    key: string; listener: string; hosts: string; paths: string[]; priority: number; act: Act;
    rules: number; headers: number; ord: number | undefined; shadow: string | undefined;
  };
  type Desk = ReturnType<typeof createDesk>;
  /** 합산이면 행에 지역이 붙는다(`region` · `rid`). 지역 인스턴스 · 좁혀 보기면 `region` 은 '' 이고 `rid` 는 키다. */
  type AggRow = RegionRow<Row>;
  const desk = getContext<Desk>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const agg = useAggregate();
  // 쓸 수 없으면(지역을 안 골랐다 · 팔로워 · 고른 지역과 연락 없음) 만들기 · 수정 · 삭제를 안 보인다.
  const ro = $derived(scope?.blocked === true);
  /** 이 행에 쓸 수 있나 — 합산이면 그 행의 지역에, 아니면 셸의 판정(`ro`) 그대로. */
  const rowRo = (r: AggRow): boolean => (agg.on ? !agg.writable(r.region) : ro);
  /** 이 행의 주소 — 합산이면 그 행의 지역으로 좁혀 연다. */
  const at = (r: AggRow, path: string): string => (agg.on ? agg.href(r.region, path) : path);
  let del = $state<{ kind: 'httpRoute'; key: string; region: string } | undefined>();
  let selected = $state<string[]>([]);

  /** 한 지역(desk)의 행 — 평가 순서 · 가려짐은 그 desk 의 라우트끼리만 센다(지역을 넘어 세지 않는다). */
  const rowsOf = (desk: Desk): Row[] => {
    const meta = routeOrder(desk.routes);
    return itemsOf(desk.model, 'httpRoute').map((r) => {
      const key = String(r['key']);
      const act = (typeof r['action'] === 'object' && r['action'] !== null ? r['action'] : { kind: '' }) as Act;
      const paths = Array.isArray(r['pathPrefixes']) && r['pathPrefixes'].length > 0 ? (r['pathPrefixes'] as unknown[]).map(String)
        : [typeof r['pathPrefix'] === 'string' ? r['pathPrefix'] : '/'];
      return {
        key, listener: String(r['listener'] ?? ''), act, paths,
        hosts: Array.isArray(r['hosts']) ? (r['hosts'] as unknown[]).map(String).join(', ') : '',
        priority: Number(r['priority'] ?? 0),
        rules: Array.isArray(r['sourceRules']) ? r['sourceRules'].length : 0,
        headers: Array.isArray(act.requestHeaders) ? act.requestHeaders.length : 0,
        ord: meta.ord.get(key), shadow: meta.shadow.get(key),
      };
    }).sort((a, b) => (a.ord ?? Infinity) - (b.ord ?? Infinity) || a.key.localeCompare(b.key));
  };
  const rows = $derived<AggRow[]>(agg.on ? agg.rows(rowsOf, (r) => r.key) : rowsOf(desk).map((r) => ({ ...r, region: '', rid: r.key })));
  /** 배너를 말할 지역 — 합산이면 붙어 있는 지역마다(이름을 단다), 아니면 셸의 desk 하나(이름 없음). */
  const bannerDesks = $derived<{ name: string; desk: Desk }[]>(agg.on
    ? agg.entries.filter((e) => e.state === 'ok').map((e) => ({ name: e.name, desk: e.desk }))
    : [{ name: '', desk }]);

  // 시안: 프록시 · redirect 는 글자, reject 만 ✕ 배지다.
  const actText = (a: Act): string => (a.kind === 'proxy' ? `프록시 → ${a.pool ?? ''}${a.websocket === true ? ' · WebSocket' : ''}`
    : a.kind === 'redirect' ? `redirect → ${a.to ?? ''} · ${a.status ?? ''}` : `reject ${a.status ?? ''}`.trim());
  /** 분할 상세가 연 행 — 표의 행 키(`rid`)로 찾는다. 합산이면 같은 이름이 지역마다 있다. */
  const openRow = (key: string): AggRow | undefined => rows.find((r) => r.rid === selected[0] && r.key === key);
  const isProxy = (key: string): boolean => openRow(key)?.act.kind === 'proxy';

  const columns: Column<AggRow>[] = [
    { key: 'key', label: '이름', mono: true, sort: (r) => r.key },
    { key: 'listener', label: '리스너', mono: true, sort: (r) => r.listener },
    { key: 'hosts', label: '호스트', mono: true, sort: (r) => r.hosts },
    { key: 'paths', label: '경로 접두사', mono: true, sort: (r) => r.paths.join(' ') },
    { key: 'priority', label: '우선순위', mono: true, align: 'right', sort: (r) => r.priority },
    { key: 'action', label: '동작', mono: true, sort: (r) => actText(r.act) },
    { key: 'rules', label: '출발지 규칙', sort: (r) => r.rules },
    { key: 'headers', label: '요청 헤더', sort: (r) => r.headers },
    { key: 'ord', label: '평가 순서', mono: true, align: 'right', sort: (r) => r.ord ?? Infinity },
  ];
  /** 합산이면 「지역」 열을 셋째 열 뒤에(시안). */
  const shownColumns = $derived(agg.on ? withRegionColumn(columns, regionColumn<AggRow>()) : columns);
  const menu = (r: AggRow): MenuItem[] => [
    { label: '상세 페이지 열기', href: at(r, resourcePath('httpRoute', r.key)) },
    ...(rowRo(r) ? [] : [
      { label: '수정', href: at(r, resourcePath('httpRoute', r.key, 'settings')) },
      ...(r.act.kind === 'proxy' ? [{ label: 'URL로 다시 만들기', href: at(r, resourcePath('httpRoute', r.key, 'rebuild')) }] : []),
      { label: '삭제…', danger: true, onselect: () => { del = { kind: 'httpRoute', key: r.key, region: r.region }; } },
    ]),
  ];
  // 합산이면 만들기 · 경로별 묶음은 지역을 먼저 고른다(RegionCreate). 쓸 지역이 하나도 없으면 안 보인다.
  usePageActions(() => (agg.on ? (agg.entries.some((e) => e.writable) ? createIn : undefined) : ro ? undefined : create));
  const delEntry = $derived(del === undefined || !agg.on ? undefined : agg.entry(del.region));
</script>

{#snippet create()}
  <Button href="/traffic/route/http/new/group">＋ 경로별 묶음</Button>
  <Button variant="primary" href="/traffic/route/http/new">＋ 만들기</Button>
{/snippet}

{#snippet createIn()}
  <RegionCreate {agg} href="/traffic/route/http/new/group" label="＋ 경로별 묶음" variant="secondary" />
  <RegionCreate {agg} href="/traffic/route/http/new" />
{/snippet}

<RouteSegments current="http" />
{#each bannerDesks as b (b.name)}
  {@const who = b.name === '' ? '' : `${b.name} · `}
  {#each b.desk.routes.errors as e (e.kind + e.message)}<Banner tone="danger">{who}{e.message}</Banner>{/each}
  {#each b.desk.routes.warnings as w (w.kind + w.message)}<Banner tone="warn">{who}{w.message}</Banner>{/each}
{/each}
{#snippet rebuild(key: string)}
  {@const r = openRow(key)}
  {#if r !== undefined && !rowRo(r) && isProxy(key)}<Button size="sm" href={at(r, resourcePath('httpRoute', key, 'rebuild'))}>URL로 다시 만들기</Button>{/if}
{/snippet}

{#snippet table()}
{#if agg.on}<RegionNotices notices={agg.notices} />{:else}<WriteNote spaced />{/if}
<DataTable label="HTTP 라우트 — 엔진이 보는 순서" {rows} rowKey={(r) => r.rid} columns={shownColumns} {...(agg.on ? agg.listState : { loading: !desk.live })} bind:selected
  search={{ placeholder: '이름·호스트·경로·리스너로 찾기', match: (r, q) => `${r.key} ${r.hosts} ${r.paths.join(' ')} ${r.listener}${agg.on ? ` ${r.region}` : ''}`.toLowerCase().includes(q) }}
  emptyTitle="HTTP 라우트가 없어요" emptyBody="호스트와 경로로 요청을 풀이나 동작에 보내요."
  onopen={(r) => { void goto(at(r, resourcePath('httpRoute', r.key))); }} rowMenu={menu}>
  {#snippet cell(r, c)}
    {#if c.key === 'key'}<a href={at(r, resourcePath('httpRoute', r.key))}>{r.key}</a>{#if agg.on}{@const e = agg.entry(r.region)}{#if e !== undefined}<InRegion entry={e}><PendingMark kind="httpRoute" key={r.key} /></InRegion>{/if}{:else}<PendingMark kind="httpRoute" key={r.key} />{/if}
    {:else if c.key === 'region'}{r.region}
    {:else if c.key === 'listener'}<a class="sub" href={at(r, resourcePath('listener', r.listener))}>{r.listener}</a>
    {:else if c.key === 'paths'}
      <span title={r.paths.length > 1 ? r.paths.join('\n') : undefined}>{r.paths[0]}{#if r.paths.length > 1}<span class="more"><Badge tone="neutral" icon={null}>+{r.paths.length - 1}</Badge></span>{/if}</span>
    {:else if c.key === 'action'}
      {#if r.act.kind === 'reject'}<Badge tone="danger" icon="✕">{actText(r.act)}</Badge>
      {:else if r.act.kind === 'redirect'}{actText(r.act)}
      {:else}{actText(r.act)}{#if r.act.rewritePrefix !== undefined}<span class="sub"> · 경로 → {r.act.rewritePrefix}</span>{/if}{/if}
    {:else if c.key === 'rules'}
      {#if r.rules > 0}<Badge tone="info" icon="↳">출발지 규칙 {r.rules}</Badge>{:else}<span class="none">—</span>{/if}
    {:else if c.key === 'headers'}
      {#if r.headers > 0}<Badge tone="info" icon="＋">헤더 {r.headers}</Badge>{:else}<span class="none">—</span>{/if}
    {:else if c.key === 'ord'}
      {#if r.shadow !== undefined}<Badge tone="warn" title={r.shadow}>#{r.ord ?? '—'} · 가려짐</Badge>
      {:else}#{r.ord ?? '—'}{/if}
    {:else}{String(r[c.key as keyof AggRow])}{/if}
  {/snippet}
</DataTable>
{/snippet}

<ListSplit kind="httpRoute" bind:selected {table} actions={rebuild} />
<p class="note">평가 순서는 엔진이 맞춰 보는 순서예요. 정확 일치 → 와일드카드 → 정규식 순서이고, 같은 클래스 안에서만 우선순위가 뜻이 있어요.</p>
{#if delEntry !== undefined}
  <!-- 합산: 삭제 확인과 쓰기가 그 행의 지역을 본다. -->
  {#key delEntry.name}<InRegion entry={delEntry}><DeleteConfirm bind:target={del} /></InRegion>{/key}
{:else}
  <DeleteConfirm bind:target={del} />
{/if}

<style>
  .sub { color: var(--tx2); }
  .none { color: var(--tx3); }
  .more { margin-left: 6px; }
  .note { margin: 0; color: var(--tx3); font: var(--t-cap); }
</style>
