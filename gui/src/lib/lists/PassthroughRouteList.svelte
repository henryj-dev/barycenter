<script lang="ts">
  /**
   * 패스스루 라우트 목록 — 시안 `page === 'routes'` 의 패스스루 세그먼트. 이름 · 리스너 · SNI · 우선순위 · 동작 · 평가 순서.
   * 복호화하지 않고 SNI 만 본다 — 경로 · 출발지 규칙 · 요청 헤더가 없다. 평가 순서는 우선순위 → 이름(`viewOfRoutes`)이다.
   * 행을 누르면 아래에 분할 상세가 열린다(`ListSplit`).
   *
   * **전체 합산**(전역에서 지역을 안 골랐다, §2.5)이면 지역마다 행을 만들어 잇고, 셋째 열 뒤에 「지역」 열을 둔다.
   * 평가 순서 `#n` 은 **지역마다 따로** 센다 — 엔진은 지역마다 하나다. 줄도 지역 순서대로, 지역 안에서는 그 지역의 평가 순서대로다.
   * 행의 수정 · 상세는 그 지역으로 좁혀 열고, 삭제는 그 지역의 desk 로 쓴다. 만들기는 지역을 먼저 고른다(`useAggregate`).
   */
  import { getContext } from 'svelte';
  import { goto } from '$app/navigation';
  import { itemOf, resourcePath } from '@web/resources';
  import { Badge, Button, DataTable, type Column, type MenuItem } from '#lib/ui';
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

  /** `via` 는 풀로 보내는 라우트의 「프록시 → 풀」 — 그 행의 지역 모델에서 읽는다. */
  type Row = { key: string; listener: string; snis: string[]; priority: number; action: string; ord: number; via: string };
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

  /** 풀로 보내는 라우트의 풀 — 표의 사실(`viewOfRoutes`)에는 동작 종류만 있어서 모델에서 읽는다. */
  const poolText = (desk: Desk, key: string): string => {
    const a = itemOf(desk.model, 'passthroughRoute', key)?.['action'] as { pool?: unknown } | undefined;
    return typeof a?.pool === 'string' ? `프록시 → ${a.pool}` : 'proxy';
  };
  /** 한 지역(desk)의 행 — 평가 순서는 그 desk 의 라우트끼리만 센다(지역을 넘어 세지 않는다). */
  const rowsOf = (desk: Desk): Row[] => desk.routes.passthrough.map((r, i) => ({
    key: r.key, listener: r.listener, snis: r.snis, priority: r.priority, action: r.action, ord: i + 1, via: poolText(desk, r.key),
  }));
  const rows = $derived<AggRow[]>(agg.on ? agg.rows(rowsOf, (r) => r.key) : rowsOf(desk).map((r) => ({ ...r, region: '', rid: r.key })));
  const columns: Column<AggRow>[] = [
    { key: 'key', label: '이름', mono: true, sort: (r) => r.key },
    { key: 'listener', label: '리스너', mono: true, sort: (r) => r.listener },
    { key: 'snis', label: 'SNI', mono: true, sort: (r) => r.snis.join(' ') },
    { key: 'priority', label: '우선순위', mono: true, align: 'right', sort: (r) => r.priority },
    { key: 'action', label: '동작', mono: true, sort: (r) => r.action },
    { key: 'ord', label: '평가 순서', mono: true, align: 'right', sort: (r) => r.ord },
  ];
  /** 합산이면 「지역」 열을 셋째 열 뒤에(시안). */
  const shownColumns = $derived(agg.on ? withRegionColumn(columns, regionColumn<AggRow>()) : columns);
  const menu = (r: AggRow): MenuItem[] => [
    { label: '상세 페이지 열기', href: at(r, resourcePath('passthroughRoute', r.key)) },
    ...(rowRo(r) ? [] : [
      { label: '수정', href: at(r, resourcePath('passthroughRoute', r.key, 'settings')) },
      { label: '삭제…', danger: true, onselect: () => { del = { kind: 'passthroughRoute', key: r.key, region: r.region }; } },
    ]),
  ];
  // 합산이면 만들기는 지역을 먼저 고른다(RegionCreate). 쓸 지역이 하나도 없으면 안 보인다.
  usePageActions(() => (agg.on ? (agg.entries.some((e) => e.writable) ? createIn : undefined) : ro ? undefined : create));
  const delEntry = $derived(del === undefined || !agg.on ? undefined : agg.entry(del.region));
</script>

{#snippet create()}<Button variant="primary" href="/traffic/route/passthrough/new">＋ 만들기</Button>{/snippet}
{#snippet createIn()}<RegionCreate {agg} href="/traffic/route/passthrough/new" />{/snippet}

<RouteSegments current="passthrough" />
{#snippet table()}
{#if agg.on}<RegionNotices notices={agg.notices} />{:else}<WriteNote spaced />{/if}
<DataTable label="패스스루 라우트" {rows} rowKey={(r) => r.rid} columns={shownColumns} {...(agg.on ? agg.listState : { loading: !desk.live })} bind:selected
  search={{ placeholder: '이름·SNI·리스너로 찾기', match: (r, q) => `${r.key} ${r.snis.join(' ')} ${r.listener}${agg.on ? ` ${r.region}` : ''}`.toLowerCase().includes(q) }}
  emptyTitle="패스스루 라우트가 없어요" emptyBody="SNI 로 TLS 연결을 복호화 없이 풀에 보내요."
  onopen={(r) => { void goto(at(r, resourcePath('passthroughRoute', r.key))); }} rowMenu={menu}>
  {#snippet cell(r, c)}
    {#if c.key === 'key'}<a href={at(r, resourcePath('passthroughRoute', r.key))}>{r.key}</a>{#if agg.on}{@const e = agg.entry(r.region)}{#if e !== undefined}<InRegion entry={e}><PendingMark kind="passthroughRoute" key={r.key} /></InRegion>{/if}{:else}<PendingMark kind="passthroughRoute" key={r.key} />{/if}
    {:else if c.key === 'region'}{r.region}
    {:else if c.key === 'listener'}<a class="sub" href={at(r, resourcePath('listener', r.listener))}>{r.listener}</a>
    {:else if c.key === 'snis'}
      <span title={r.snis.length > 1 ? r.snis.join('\n') : undefined}>{r.snis[0] ?? '—'}{#if r.snis.length > 1}<span class="more"><Badge tone="neutral" icon={null}>+{r.snis.length - 1}</Badge></span>{/if}</span>
    {:else if c.key === 'action'}{#if r.action.startsWith('reject')}<Badge tone="danger" icon="✕">연결을 끊어요</Badge>{:else}{r.via}{/if}
    {:else if c.key === 'ord'}#{r.ord}
    {:else}{String(r[c.key as keyof AggRow])}{/if}
  {/snippet}
</DataTable>
{/snippet}

<ListSplit kind="passthroughRoute" bind:selected {table} />
{#if delEntry !== undefined}
  <!-- 합산: 삭제 확인과 쓰기가 그 행의 지역을 본다. -->
  {#key delEntry.name}<InRegion entry={delEntry}><DeleteConfirm bind:target={del} /></InRegion>{/key}
{:else}
  <DeleteConfirm bind:target={del} />
{/if}

<style>
  .sub { color: var(--tx2); }
  .more { margin-left: 6px; }
</style>
