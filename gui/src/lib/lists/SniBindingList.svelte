<script lang="ts">
  /**
   * SNI 바인딩 목록 — 콘솔 시안 `colsOf('sni')` · `cells('sni', r)` 그대로: 이름 · 리스너 · 호스트 수 · 호스트(첫 이름 「외 N」) · 인증서.
   * 칸은 평문이다(링크 없음). 행을 누르면 아래에 분할 상세가 열리고(인라인 수정 — 시안 `INL.sni`: 호스트 목록 · 인증서),
   * Enter · 두 번 누르기 · 「상세 페이지 열기」 로 상세를 연다. 없는 인증서를 가리키면 그 칸이 위험 배지다(기존 표시).
   *
   * **전체 합산**(전역에서 지역을 안 골랐다, §2.5)이면 지역마다 행을 만들어 잇고, 「지역」 열을 단다(`withRegionColumn`).
   * 「없는 인증서」 는 그 행의 지역 안에서 본다. 상세 · 수정은 그 지역으로 좁혀 열고, 삭제는 그 지역의 desk 로 쓴다(`useAggregate`).
   */
  import ListSplit from '#lib/detail/ListSplit.svelte';
  import { getContext } from 'svelte';
  import { goto } from '$app/navigation';
  import { itemsOf, resourcePath } from '@web/resources';
  import { Button, DataTable, type Cell, type Column, type MenuItem } from '#lib/ui';
  import { usePageActions } from '#lib/shell/page-actions.svelte.ts';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import WriteNote from '#lib/global/WriteNote.svelte';
  import InRegion from '#lib/global/InRegion.svelte';
  import RegionNotices from '#lib/global/RegionNotices.svelte';
  import { regionColumn, useAggregate } from '#lib/global/use-aggregate.svelte.ts';
  import { withRegionColumn, type RegionRow } from '#lib/global/aggregate.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { sniCells } from '#lib/tls/tls-view.ts';
  import SniBindingInline from '#lib/tls/SniBindingInline.svelte';
  import DeleteConfirm from './DeleteConfirm.svelte';
  import PendingMark from './PendingMark.svelte';

  type Row = { key: string; count: number; cells: Cell[] };
  type Desk = ReturnType<typeof createDesk>;
  /** 합산이면 행에 지역이 붙는다(`region` · `rid`). 지역 인스턴스 · 좁혀 보기면 `region` 은 '' 이고 `rid` 는 키다. */
  type AggRow = RegionRow<Row>;
  const desk = getContext<Desk>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const agg = useAggregate();
  let selected = $state<string[]>([]);
  // 쓸 수 없으면(지역을 안 골랐다 · 팔로워 · 고른 지역과 연락 없음) 만들기 · 수정 · 삭제를 안 보인다.
  const ro = $derived(scope?.blocked === true);
  /** 이 행에 쓸 수 있나 — 합산이면 그 행의 지역에, 아니면 셸의 판정(`ro`) 그대로. */
  const rowRo = (r: AggRow): boolean => (agg.on ? !agg.writable(r.region) : ro);
  /** 이 행의 주소 — 합산이면 그 행의 지역으로 좁혀 연다. */
  const at = (r: AggRow, path: string): string => (agg.on ? agg.href(r.region, path) : path);
  let del = $state<{ kind: 'sniBinding'; key: string; region: string } | undefined>();

  // 칸은 그 행의 지역 desk 로 만든다(「없는 인증서」 는 그 지역 안에서 본다).
  const rowsOf = (desk: Desk): Row[] => itemsOf(desk.model, 'sniBinding').map((s) => ({
    key: String(s['key']), count: Array.isArray(s['hosts']) ? s['hosts'].length : 0, cells: sniCells(desk, s),
  }));
  const rows = $derived<AggRow[]>(agg.on ? agg.rows(rowsOf, (r) => r.key) : rowsOf(desk).map((r) => ({ ...r, region: '', rid: r.key })));
  const columns: Column<AggRow>[] = [
    { key: 'key', label: '이름', mono: true, text: (r) => r.key, sort: (r) => r.key },
    { key: 'listener', label: '리스너', value: (r) => r.cells[1]!, sort: true },
    { key: 'count', label: '호스트 수', value: (r) => r.cells[2]!, sort: (r) => r.count },
    { key: 'hosts', label: '호스트', value: (r) => r.cells[3]!, sort: true },
    { key: 'cert', label: '인증서', value: (r) => r.cells[4]!, sort: true },
  ];
  const menu = (r: AggRow): MenuItem[] => [
    { label: '상세 페이지 열기', href: at(r, resourcePath('sniBinding', r.key)) },
    ...(rowRo(r) ? [] : [
      { label: '수정해요', href: at(r, resourcePath('sniBinding', r.key, 'settings')) },
      { label: '삭제…', danger: true, onselect: () => { del = { kind: 'sniBinding', key: r.key, region: r.region }; } },
    ]),
  ];
  // 합산이면 만들기는 지역 모드와 같은 버튼이다 — 드로어 머리에서 「쓸 지역」 을 고른다(`FormDrawer`). 쓸 지역이 하나도 없으면 안 보인다.
  usePageActions(() => (agg.on ? (agg.entries.some((e) => e.writable) ? create : undefined) : ro ? undefined : create));
  const delEntry = $derived(del === undefined || !agg.on ? undefined : agg.entry(del.region));
</script>

{#snippet create()}<Button variant="primary" href="/tls/sni/new">＋ 만들기</Button>{/snippet}

{#if agg.on}<RegionNotices notices={agg.notices} />{:else}<WriteNote spaced />{/if}
{#snippet table()}
<DataTable label="SNI 바인딩 목록" {rows} rowKey={(r) => r.rid} columns={agg.on ? withRegionColumn(columns, regionColumn<AggRow>()) : columns}
  {...(agg.on ? agg.listState : { loading: !desk.live })} bind:selected search={{}} fill
  emptyTitle="SNI 바인딩이 없어요" emptyBody="HTTPS 호스트는 바인딩이 있어야 plan 이 돼요."
  onopen={(r) => { void goto(at(r, resourcePath('sniBinding', r.key))); }} rowMenu={menu}>
  {#snippet cell(r, c)}
    <!-- 이름 칸 — 시안 m(name). 뒤의 「◐ 적용 대기」 는 시안에 없던 기존 표시다(이름 칸 뒤, 배지 모양). -->
    {#if c.key === 'key'}{r.key}{#if agg.on}{@const e = agg.entry(r.region)}{#if e !== undefined}<InRegion entry={e}><PendingMark kind="sniBinding" key={r.key} /></InRegion>{/if}{:else}<PendingMark kind="sniBinding" key={r.key} />{/if}
    {:else}{c.text?.(r) ?? ''}{/if}
  {/snippet}
</DataTable>
{/snippet}

<ListSplit kind="sniBinding" bind:selected {table}>
  {#snippet inline({ key, detailHref, pending })}<SniBindingInline {key} {detailHref} {pending} />{/snippet}
</ListSplit>
{#if delEntry !== undefined}
  <!-- 합산: 삭제 확인과 쓰기가 그 행의 지역을 본다. -->
  {#key delEntry.name}<InRegion entry={delEntry}><DeleteConfirm bind:target={del} /></InRegion>{/key}
{:else}
  <DeleteConfirm bind:target={del} />
{/if}
