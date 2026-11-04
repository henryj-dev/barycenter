<script lang="ts">
  /**
   * 주소 집합 목록 — 콘솔 시안 `colsOf('sets')` · `cells('sets', r)` 그대로(`traffic-cells.ts`).
   * 이름 · 대역 수 · 출처 · 마지막 갱신 · 사용하는 리스너. 칸은 평문이다(링크 없음). 리스너의 출발지 제한 · 신뢰 대역과
   * 라우트 출발지 규칙이 `@이름` 으로 참조한다(#114). 마지막 갱신 시각은 모델에 없어서 「—」 다.
   * 행을 누르면 아래에 분할 상세가 열리고 그 자리에서 대역 목록을 고친다(시안 `INL.sets`). 공개 목록에서 받은 집합은 잠긴다.
   * 행 메뉴는 시안 `actsOf`: 상세 페이지 열기 · 삭제…. 이름 칸 뒤의 「◐ 적용 대기」 는 시안에 없지만 있던 것이다(#198).
   *
   * **전체 합산**(전역에서 지역을 안 골랐다, §2.5)이면 지역마다 행을 만들어 잇고, 맨 끝에 「지역」 열을 둔다(시안 `lcols`).
   * 사용처는 그 지역 안에서 센다. 행의 상세는 그 지역으로 좁혀 열고, 삭제 · 인라인 수정은 그 지역의 desk 로 쓴다(`useAggregate`).
   */
  import { getContext } from 'svelte';
  import { goto } from '$app/navigation';
  import { resourcePath } from '@web/resources';
  import { Button, DataTable, type MenuItem } from '#lib/ui';
  import { usePageActions } from '#lib/shell/page-actions.svelte.ts';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import WriteNote from '#lib/global/WriteNote.svelte';
  import InRegion from '#lib/global/InRegion.svelte';
  import RegionNotices from '#lib/global/RegionNotices.svelte';
  import { regionColumn, useAggregate } from '#lib/global/use-aggregate.svelte.ts';
  import { withRegionColumn, type RegionRow } from '#lib/global/aggregate.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import ListSplit from '#lib/detail/ListSplit.svelte';
  import AddressSetInline from '#lib/detail/AddressSetInline.svelte';
  import DeleteConfirm from './DeleteConfirm.svelte';
  import PendingMark from './PendingMark.svelte';
  import { listState } from './list-state';
  import { addressSetColumns, addressSetRowsOf, type AddressSetRow } from './traffic-cells';

  type Desk = ReturnType<typeof createDesk>;
  /** 합산이면 행에 지역이 붙는다(`region` · `rid`). 지역 인스턴스 · 좁혀 보기면 `region` 은 '' 이고 `rid` 는 키다. */
  type AggRow = RegionRow<AddressSetRow>;
  const desk = getContext<Desk>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const agg = useAggregate();
  // 쓸 수 없으면(지역을 안 골랐다 · 팔로워 · 고른 지역과 연락 없음) 만들기 · 수정 · 삭제를 안 보인다.
  const ro = $derived(scope?.blocked === true);
  /** 이 행에 쓸 수 있나 — 합산이면 그 행의 지역에, 아니면 셸의 판정(`ro`) 그대로. */
  const rowRo = (r: AggRow): boolean => (agg.on ? !agg.writable(r.region) : ro);
  /** 이 행의 주소 — 합산이면 그 행의 지역으로 좁혀 연다. */
  const at = (r: AggRow, path: string): string => (agg.on ? agg.href(r.region, path) : path);
  let del = $state<{ kind: 'addressSet'; key: string; region: string } | undefined>();
  let selected = $state<string[]>([]);

  const rowsOf = (desk: Desk): AddressSetRow[] => addressSetRowsOf(desk);
  const rows = $derived<AggRow[]>(agg.on ? agg.rows(rowsOf, (r) => r.key) : rowsOf(desk).map((r) => ({ ...r, region: '', rid: r.key })));
  const columns = addressSetColumns<AggRow>();
  /** 합산이면 「지역」 열을 맨 끝에(시안 `lcols`). */
  const shownColumns = $derived(agg.on ? withRegionColumn(columns, regionColumn<AggRow>()) : columns);
  /** 시안 `actsOf` — 상세 페이지 열기 · 삭제…. */
  const menu = (r: AggRow): MenuItem[] => [
    { label: '상세 페이지 열기', href: at(r, resourcePath('addressSet', r.key)) },
    ...(rowRo(r) ? [] : [
      { label: '삭제…', danger: true, onselect: () => { del = { kind: 'addressSet', key: r.key, region: r.region }; } },
    ]),
  ];
  // 합산이면 만들기는 지역 모드와 같은 버튼이다 — 드로어 머리에서 「쓸 지역」 을 고른다(`FormDrawer`). 쓸 지역이 하나도 없으면 안 보인다.
  usePageActions(() => (agg.on ? (agg.entries.some((e) => e.writable) ? create : undefined) : ro ? undefined : create));
  const delEntry = $derived(del === undefined || !agg.on ? undefined : agg.entry(del.region));
</script>

{#snippet create()}<Button variant="primary" href="/traffic/address-set/new">＋ 만들기</Button>{/snippet}

{#snippet table()}
{#if agg.on}<RegionNotices notices={agg.notices} />{:else}<WriteNote spaced />{/if}
<DataTable label="주소 집합 목록" {rows} rowKey={(r) => r.rid} columns={shownColumns} {...(agg.on ? agg.listState : listState(desk))} bind:selected fill
  search={{ placeholder: '이름·주소로 찾기' }}
  emptyTitle="주소 집합이 없어요" emptyBody="리스너의 출발지 제한에서 @이름 으로 써요. CLI 의 bary address-set create --cloudflare 로도 만들어요."
  onopen={(r) => { void goto(at(r, resourcePath('addressSet', r.key))); }} rowMenu={menu}>
  {#snippet cell(r, c)}
    {#if c.key === 'key'}{r.key}{#if agg.on}{@const e = agg.entry(r.region)}{#if e !== undefined}<InRegion entry={e}><PendingMark kind="addressSet" key={r.key} /></InRegion>{/if}{:else}<PendingMark kind="addressSet" key={r.key} />{/if}{/if}
  {/snippet}
</DataTable>
{/snippet}

<ListSplit kind="addressSet" bind:selected {table}>
  {#snippet inline({ key, detailHref, pending })}<AddressSetInline {key} {detailHref} {pending} />{/snippet}
</ListSplit>
{#if delEntry !== undefined}
  <!-- 합산: 삭제 확인(쓰는 리소스)과 쓰기가 그 행의 지역을 본다. -->
  {#key delEntry.name}<InRegion entry={delEntry}><DeleteConfirm bind:target={del} /></InRegion>{/key}
{:else}
  <DeleteConfirm bind:target={del} />
{/if}
