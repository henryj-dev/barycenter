<script lang="ts">
  /**
   * HTTP 라우트 목록 — 콘솔 시안 `page === 'routes'`(rkind HTTP). 열은 `colsOf('routes')`, 칸은 `cells('routes', r)` 그대로다
   * (`route-cells.ts`, 칸은 링크가 아니다). 도구 줄에 HTTP · 패스스루 분할 컨트롤(`rkTabs`)이 있다.
   * 라우트 하나가 한 줄이다. 경로가 여럿이면 「첫 경로 +N」 이고 마우스를 올리면 전부 보인다.
   *
   * 「평가 순서」 는 **엔진이 실제로 평가하는 순서**다(`desk.routes.order` — 매치 클래스 → 우선순위 → 경로 길이). 호스트 ·
   * 경로가 여럿인 라우트는 엔진이 여러 번 보므로 가장 먼저 보는 자리를 적는다. 줄도 그 순서로 늘어놓는다.
   * 더 높은 클래스의 라우트가 먼저 잡는 라우트(`priority_inversion`)는 「▲ #n · 가려짐」 이고, 마우스를 올리면 까닭이다.
   * 가림 · 오류는 위에 배너로도 먼저 말한다.
   *
   * 행을 누르면 아래에 분할 상세가 열린다(`ListSplit`) — 시안 `INL` 인라인 수정(호스트 · 경로 · 우선순위 · 풀 · 경로 바꾸기)이고,
   * 풀로 보내는 라우트는 머리에 「URL로 다시 만들기」 가 있다. Enter · 두 번 누르기 · 「상세 페이지 ↗」 로 상세를 연다.
   *
   * **전체 합산**(전역에서 지역을 안 골랐다, §2.5)이면 지역마다 행을 만들어 잇고 「지역」 열을 둔다(`withRegionColumn`).
   * 평가 순서 `#n` · 가려짐은 **지역마다 따로** 센다 — 엔진은 지역마다 하나이고, 다른 지역의 라우트는 서로 가리지 않는다.
   * 줄도 지역 순서대로, 지역 안에서는 그 지역의 평가 순서대로다. 배너는 지역 이름을 달고 지역마다 말한다.
   * 행의 상세 · 다시 만들기는 그 지역으로 좁혀 열고, 인라인 수정 · 삭제는 그 지역의 desk 로 쓴다. 만들기 · 경로별 묶음은 지역을 먼저 고른다.
   */
  import { getContext } from 'svelte';
  import { goto } from '$app/navigation';
  import { itemsOf, resourcePath } from '@web/resources';
  import { Banner, Button, DataTable, Menu, b, m, x, type Column, type MenuItem } from '#lib/ui';
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
  import HttpRouteInline from './HttpRouteInline.svelte';
  import { routeOrder } from './route-order';
  import { ROUTE_COLS, actCell, httpRouteFacts, ordCell, pathCell, type RouteFacts } from './route-cells';

  type Row = RouteFacts;
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
    return itemsOf(desk.model, 'httpRoute').map((r) => httpRouteFacts(r, meta))
      .sort((a, b) => (a.ord ?? Infinity) - (b.ord ?? Infinity) || a.key.localeCompare(b.key));
  };
  const rows = $derived<AggRow[]>(agg.on ? agg.rows(rowsOf, (r) => r.key) : rowsOf(desk).map((r) => ({ ...r, region: '', rid: r.key })));
  /** 배너를 말할 지역 — 합산이면 붙어 있는 지역마다(이름을 단다), 아니면 셸의 desk 하나(이름 없음). */
  const bannerDesks = $derived<{ name: string; desk: Desk }[]>(agg.on
    ? agg.entries.filter((e) => e.state === 'ok').map((e) => ({ name: e.name, desk: e.desk }))
    : [{ name: '', desk }]);

  /** 분할 상세가 연 행 — 표의 행 키(`rid`)로 찾는다. 합산이면 같은 이름이 지역마다 있다. */
  const openRow = (key: string): AggRow | undefined => rows.find((r) => r.rid === selected[0] && r.key === key);
  const isProxy = (key: string): boolean => openRow(key)?.act.kind === 'proxy';

  // 시안 `colsOf('routes')` · `cells('routes', r)`. 이름 칸만 스니펫이다 — 「◐ 적용 대기」(#198)를 이름 뒤에 단다.
  const columns: Column<AggRow>[] = [
    { key: 'key', label: ROUTE_COLS[0], mono: true, sort: (r) => r.key },
    { key: 'listener', label: ROUTE_COLS[1], value: (r) => m(r.listener), sort: true },
    { key: 'hosts', label: ROUTE_COLS[2], value: (r) => m(r.hosts.join(', ')), sort: true },
    { key: 'paths', label: ROUTE_COLS[3], value: pathCell, sort: (r) => r.paths.join(' ') },
    { key: 'priority', label: ROUTE_COLS[4], value: (r) => m(r.priority), sort: (r) => r.priority },
    { key: 'action', label: ROUTE_COLS[5], value: actCell, sort: true },
    { key: 'rules', label: ROUTE_COLS[6], value: (r) => (r.rules > 0 ? b('info', '↳', `출발지 규칙 ${r.rules}`) : x('—')), sort: (r) => r.rules },
    { key: 'headers', label: ROUTE_COLS[7], value: (r) => (r.headers > 0 ? b('info', '＋', `헤더 ${r.headers}`) : x('—')), sort: (r) => r.headers },
    { key: 'ord', label: ROUTE_COLS[8], value: ordCell, sort: (r) => r.ord ?? Infinity },
  ];
  /** 합산이면 「지역」 열(시안 `lcols`). */
  const shownColumns = $derived(agg.on ? withRegionColumn(columns, regionColumn<AggRow>()) : columns);
  // 시안 행 메뉴(라우트): 「상세 페이지 열기」 · 「삭제…」. 수정은 분할 상세의 인라인 수정과 상세의 설정 탭이다.
  const menu = (r: AggRow): MenuItem[] => [
    { label: '상세 페이지 열기', href: at(r, resourcePath('httpRoute', r.key)) },
    ...(rowRo(r) ? [] : [{ label: '삭제…', danger: true, onselect: () => { del = { kind: 'httpRoute', key: r.key, region: r.region }; } }]),
  ];
  // 시안 「＋ 만들기」 메뉴 — 라우트 만들기 · 경로별 묶음으로 만들기.
  const createItems: MenuItem[] = [
    { label: '라우트 만들기', description: '호스트 하나, 경로 하나로 만들어요.', href: '/traffic/route/http/new' },
    { label: '경로별 묶음으로 만들기', description: '규칙을 줄로 적어 라우트 여러 개를 만들어요.', href: '/traffic/route/http/new/group' },
  ];
  // 합산이면 만들기 · 경로별 묶음은 지역을 먼저 고른다(RegionCreate). 쓸 지역이 하나도 없으면 안 보인다.
  usePageActions(() => (agg.on ? (agg.entries.some((e) => e.writable) ? createIn : undefined) : ro ? undefined : create));
  const delEntry = $derived(del === undefined || !agg.on ? undefined : agg.entry(del.region));
</script>

{#snippet create()}
  <Menu items={createItems} label="만들기">
    {#snippet trigger({ open, toggle })}<Button variant="primary" aria-haspopup="menu" aria-expanded={open} onclick={toggle}>＋ 만들기 ▾</Button>{/snippet}
  </Menu>
{/snippet}

{#snippet createIn()}
  <RegionCreate {agg} href="/traffic/route/http/new/group" label="＋ 경로별 묶음" variant="secondary" />
  <RegionCreate {agg} href="/traffic/route/http/new" />
{/snippet}

{#each bannerDesks as bd (bd.name)}
  {@const who = bd.name === '' ? '' : `${bd.name} · `}
  {#each bd.desk.routes.errors as e (e.kind + e.message)}<Banner tone="danger">{who}{e.message}</Banner>{/each}
  {#each bd.desk.routes.warnings as w (w.kind + w.message)}<Banner tone="warn">{who}{w.message}</Banner>{/each}
{/each}

{#snippet rebuild(key: string)}
  {@const r = openRow(key)}
  {#if r !== undefined && !rowRo(r) && isProxy(key)}<Button size="xs" href={at(r, resourcePath('httpRoute', key, 'rebuild'))}>URL로 다시 만들기</Button>{/if}
{/snippet}

{#snippet segments()}<RouteSegments current="http" />{/snippet}

{#snippet table()}
{#if agg.on}<RegionNotices notices={agg.notices} />{:else}<WriteNote spaced />{/if}
<DataTable label="HTTP 라우트 — 엔진이 보는 순서" {rows} rowKey={(r) => r.rid} columns={shownColumns} {...(agg.on ? agg.listState : { loading: !desk.live })} bind:selected fill
  search={{ placeholder: '이름·주소로 찾기', match: (r, q) => `${r.key} ${r.hosts.join(' ')} ${r.paths.join(' ')} ${r.listener}${agg.on ? ` ${r.region}` : ''}`.toLowerCase().includes(q) }}
  toolbar={segments}
  emptyTitle="HTTP 라우트가 없어요" emptyBody="호스트와 경로로 요청을 풀이나 동작에 보내요."
  onopen={(r) => { void goto(at(r, resourcePath('httpRoute', r.key))); }} rowMenu={menu}>
  {#snippet cell(r, c)}
    {#if c.key === 'key'}{r.key}{#if agg.on}{@const e = agg.entry(r.region)}{#if e !== undefined}<InRegion entry={e}><PendingMark kind="httpRoute" key={r.key} /></InRegion>{/if}{:else}<PendingMark kind="httpRoute" key={r.key} />{/if}
    {:else}{c.text?.(r) ?? ''}{/if}
  {/snippet}
</DataTable>
{/snippet}

<ListSplit kind="httpRoute" bind:selected {table} actions={rebuild}>
  {#snippet inline({ key, detailHref, pending })}<HttpRouteInline routeKey={key} {detailHref} {pending} />{/snippet}
</ListSplit>
{#if delEntry !== undefined}
  <!-- 합산: 삭제 확인과 쓰기가 그 행의 지역을 본다. -->
  {#key delEntry.name}<InRegion entry={delEntry}><DeleteConfirm bind:target={del} /></InRegion>{/key}
{:else}
  <DeleteConfirm bind:target={del} />
{/if}
