<script lang="ts">
  /**
   * 패스스루 라우트 목록 — 콘솔 시안 `page === 'routes'`(rkind 패스스루). HTTP 와 같은 열(`colsOf('routes')`)이고 칸은
   * `cells('routes', r)` 그대로다(`route-cells.ts`). 복호화하지 않고 SNI 만 본다 — 경로 · 출발지 규칙 · 요청 헤더는 「—」 다.
   * 평가 순서는 우선순위 → 이름(`viewOfRoutes`)이다. 동작은 풀로 보내기 · 연결을 끊어요 둘이다(패스스루는 응답 코드가 없다).
   * 행을 누르면 아래에 분할 상세가 열린다(`ListSplit`) — 시안 `INL` 인라인 수정(SNI · 우선순위 · 풀).
   *
   * **전체 합산**(전역에서 지역을 안 골랐다, §2.5)이면 지역마다 행을 만들어 잇고 「지역」 열을 둔다(`withRegionColumn`).
   * 평가 순서 `#n` 은 **지역마다 따로** 센다 — 엔진은 지역마다 하나다. 줄도 지역 순서대로, 지역 안에서는 그 지역의 평가 순서대로다.
   * 행의 상세는 그 지역으로 좁혀 열고, 인라인 수정 · 삭제는 그 지역의 desk 로 쓴다. 만들기는 드로어에서 「쓸 지역」 을 고른다(`useAggregate`).
   */
  import { getContext } from 'svelte';
  import { goto } from '$app/navigation';
  import { itemOf, resourcePath } from '@web/resources';
  import { Button, DataTable, Menu, m, x, type Column, type MenuItem } from '#lib/ui';
  import { usePageActions } from '#lib/shell/page-actions.svelte.ts';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import WriteNote from '#lib/global/WriteNote.svelte';
  import InRegion from '#lib/global/InRegion.svelte';
  import RegionNotices from '#lib/global/RegionNotices.svelte';
  import { regionColumn, useAggregate } from '#lib/global/use-aggregate.svelte.ts';
  import { withRegionColumn, type RegionRow } from '#lib/global/aggregate.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import ListSplit from '#lib/detail/ListSplit.svelte';
  import DeleteConfirm from './DeleteConfirm.svelte';
  import PendingMark from './PendingMark.svelte';
  import RouteSegments from './RouteSegments.svelte';
  import PassthroughRouteInline from './PassthroughRouteInline.svelte';
  import { ROUTE_COLS, actCell, ordCell, pathCell, passRouteFacts, type RouteFacts } from './route-cells';

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
  let del = $state<{ kind: 'passthroughRoute'; key: string; region: string } | undefined>();
  let selected = $state<string[]>([]);

  /** 한 지역(desk)의 행 — 평가 순서는 그 desk 의 라우트끼리만 센다(지역을 넘어 세지 않는다). 풀은 모델에서 읽는다. */
  const rowsOf = (desk: Desk): Row[] => desk.routes.passthrough.map((r, i) => passRouteFacts(itemOf(desk.model, 'passthroughRoute', r.key)
    ?? { key: r.key, listener: r.listener, snis: r.snis, priority: r.priority, action: { kind: r.action.startsWith('reject') ? 'reject' : 'proxy' } }, i + 1));
  const rows = $derived<AggRow[]>(agg.on ? agg.rows(rowsOf, (r) => r.key) : rowsOf(desk).map((r) => ({ ...r, region: '', rid: r.key })));
  // 시안 `colsOf('routes')` · `cells('routes', r)`. 이름 칸만 스니펫이다 — 「◐ 적용 대기」(#198)를 이름 뒤에 단다.
  const columns: Column<AggRow>[] = [
    { key: 'key', label: ROUTE_COLS[0], mono: true, sort: (r) => r.key },
    { key: 'listener', label: ROUTE_COLS[1], value: (r) => m(r.listener), sort: true },
    { key: 'snis', label: ROUTE_COLS[2], value: (r) => m(r.hosts.join(', ')), sort: true },
    { key: 'paths', label: ROUTE_COLS[3], value: pathCell },
    { key: 'priority', label: ROUTE_COLS[4], value: (r) => m(r.priority), sort: (r) => r.priority },
    { key: 'action', label: ROUTE_COLS[5], value: actCell, sort: true },
    { key: 'rules', label: ROUTE_COLS[6], value: () => x('—') },
    { key: 'headers', label: ROUTE_COLS[7], value: () => x('—') },
    { key: 'ord', label: ROUTE_COLS[8], value: ordCell, sort: (r) => r.ord ?? Infinity },
  ];
  /** 합산이면 「지역」 열(시안 `lcols`). */
  const shownColumns = $derived(agg.on ? withRegionColumn(columns, regionColumn<AggRow>()) : columns);
  // 시안 행 메뉴(라우트): 「상세 페이지 열기」 · 「삭제…」. 수정은 분할 상세의 인라인 수정과 상세의 설정 탭이다.
  const menu = (r: AggRow): MenuItem[] => [
    { label: '상세 페이지 열기', href: at(r, resourcePath('passthroughRoute', r.key)) },
    ...(rowRo(r) ? [] : [{ label: '삭제…', danger: true, onselect: () => { del = { kind: 'passthroughRoute', key: r.key, region: r.region }; } }]),
  ];
  // 시안 「＋ 만들기」 메뉴는 라우트 화면 하나에 둘이다 — 패스스루에서도 같다.
  const createItems: MenuItem[] = [
    { label: '라우트 만들기', description: '호스트 하나, 경로 하나로 만들어요.', href: '/traffic/route/passthrough/new' },
    { label: '경로별 묶음으로 만들기', description: '규칙을 줄로 적어 라우트 여러 개를 만들어요.', href: '/traffic/route/http/new/group' },
  ];
  // 합산이면 만들기는 지역 모드와 같은 버튼이다 — 드로어 머리에서 「쓸 지역」 을 고른다(`FormDrawer`). 쓸 지역이 하나도 없으면 안 보인다.
  usePageActions(() => (agg.on ? (agg.entries.some((e) => e.writable) ? create : undefined) : ro ? undefined : create));
  const delEntry = $derived(del === undefined || !agg.on ? undefined : agg.entry(del.region));
</script>

{#snippet create()}
  <Menu items={createItems} label="만들기">
    {#snippet trigger({ open, toggle })}<Button variant="primary" aria-haspopup="menu" aria-expanded={open} onclick={toggle}>＋ 만들기 ▾</Button>{/snippet}
  </Menu>
{/snippet}

{#snippet segments()}<RouteSegments current="passthrough" />{/snippet}

{#snippet table()}
{#if agg.on}<RegionNotices notices={agg.notices} />{:else}<WriteNote spaced />{/if}
<DataTable label="패스스루 라우트" {rows} rowKey={(r) => r.rid} columns={shownColumns} {...(agg.on ? agg.listState : { loading: !desk.live })} bind:selected fill
  search={{ placeholder: '이름·주소로 찾기', match: (r, q) => `${r.key} ${r.hosts.join(' ')} ${r.listener}${agg.on ? ` ${r.region}` : ''}`.toLowerCase().includes(q) }}
  toolbar={segments}
  emptyTitle="패스스루 라우트가 없어요" emptyBody="SNI 로 TLS 연결을 복호화 없이 풀에 보내요."
  onopen={(r) => { void goto(at(r, resourcePath('passthroughRoute', r.key))); }} rowMenu={menu}>
  {#snippet cell(r, c)}
    {#if c.key === 'key'}{r.key}{#if agg.on}{@const e = agg.entry(r.region)}{#if e !== undefined}<InRegion entry={e}><PendingMark kind="passthroughRoute" key={r.key} /></InRegion>{/if}{:else}<PendingMark kind="passthroughRoute" key={r.key} />{/if}
    {:else}{c.text?.(r) ?? ''}{/if}
  {/snippet}
</DataTable>
{/snippet}

<ListSplit kind="passthroughRoute" bind:selected {table}>
  {#snippet inline({ key, detailHref, pending })}<PassthroughRouteInline routeKey={key} {detailHref} {pending} />{/snippet}
</ListSplit>
{#if delEntry !== undefined}
  <!-- 합산: 삭제 확인과 쓰기가 그 행의 지역을 본다. -->
  {#key delEntry.name}<InRegion entry={delEntry}><DeleteConfirm bind:target={del} /></InRegion>{/key}
{:else}
  <DeleteConfirm bind:target={del} />
{/if}
