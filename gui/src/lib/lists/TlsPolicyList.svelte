<script lang="ts">
  /**
   * TLS 정책 목록 — 콘솔 시안 `colsOf('tlspol')` · `cells('tlspol', r)` 그대로: 이름 · 최소 버전 · 최대 버전 · 암호군 · HSTS ·
   * SNI-Host 불일치. 칸은 평문이다(링크 없음). 행을 누르면 아래에 분할 상세가 열리고(인라인 수정 — 시안 `INL.tlspol`:
   * 최소 · 최대 버전 · 암호군), Enter · 두 번 누르기 · 「상세 페이지 열기」 로 상세를 연다.
   * 「사용처」 는 시안에 없는 기존 열이다 — 「컬럼 ▾」 에서 켠다.
   *
   * **전체 합산**(전역에서 지역을 안 골랐다, §2.5)이면 지역마다 행을 만들어 잇고, 「지역」 열을 단다(`withRegionColumn`).
   * 사용처는 그 행의 지역 안에서 센다. 상세 · 수정은 그 지역으로 좁혀 열고, 삭제는 그 지역의 desk 로 쓴다(`useAggregate`).
   */
  import ListSplit from '#lib/detail/ListSplit.svelte';
  import { getContext } from 'svelte';
  import { goto } from '$app/navigation';
  import { itemsOf, relationsOf, resourcePath, type Item } from '@web/resources';
  import { Button, DataTable, m, type Column, type MenuItem } from '#lib/ui';
  import { usePageActions } from '#lib/shell/page-actions.svelte.ts';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import WriteNote from '#lib/global/WriteNote.svelte';
  import InRegion from '#lib/global/InRegion.svelte';
  import RegionCreate from '#lib/global/RegionCreate.svelte';
  import RegionNotices from '#lib/global/RegionNotices.svelte';
  import { regionColumn, useAggregate } from '#lib/global/use-aggregate.svelte.ts';
  import { withRegionColumn, type RegionRow } from '#lib/global/aggregate.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { tlsPolicyCells } from '#lib/tls/tls-view.ts';
  import TlsPolicyInline from '#lib/tls/TlsPolicyInline.svelte';
  import DeleteConfirm from './DeleteConfirm.svelte';
  import PendingMark from './PendingMark.svelte';

  type Row = { key: string; item: Item; used: number };
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
  let del = $state<{ kind: 'tlsPolicy'; key: string; region: string } | undefined>();

  const rowsOf = (desk: Desk): Row[] => itemsOf(desk.model, 'tlsPolicy').map((p) => {
    const key = String(p['key']);
    return { key, item: p, used: relationsOf(desk.model, { kind: 'tlsPolicy', key }).usedBy.length };
  });
  const rows = $derived<AggRow[]>(agg.on ? agg.rows(rowsOf, (r) => r.key) : rowsOf(desk).map((r) => ({ ...r, region: '', rid: r.key })));
  /** 시안 칸 i 번째. */
  const c = (i: number) => (r: AggRow) => tlsPolicyCells(r.item)[i]!;
  const columns: Column<AggRow>[] = [
    { key: 'key', label: '이름', mono: true, text: (r) => r.key, sort: (r) => r.key },
    { key: 'min', label: '최소 버전', value: c(1), sort: true },
    { key: 'max', label: '최대 버전', value: c(2), sort: true },
    { key: 'cipher', label: '암호군', value: c(3), sort: true },
    { key: 'hsts', label: 'HSTS', value: c(4), sort: true },
    { key: 'mismatch', label: 'SNI-Host 불일치', value: c(5), sort: true },
    { key: 'used', label: '사용처', value: (r) => m(String(r.used)), sort: (r) => r.used, hidden: true },
  ];
  const menu = (r: AggRow): MenuItem[] => [
    { label: '상세 페이지 열기', href: at(r, resourcePath('tlsPolicy', r.key)) },
    ...(rowRo(r) ? [] : [
      { label: '수정해요', href: at(r, resourcePath('tlsPolicy', r.key, 'settings')) },
      { label: '삭제…', danger: true, onselect: () => { del = { kind: 'tlsPolicy', key: r.key, region: r.region }; } },
    ]),
  ];
  // 합산이면 만들기는 지역을 먼저 고른다(RegionCreate). 쓸 지역이 하나도 없으면 안 보인다.
  usePageActions(() => (agg.on ? (agg.entries.some((e) => e.writable) ? createIn : undefined) : ro ? undefined : create));
  const delEntry = $derived(del === undefined || !agg.on ? undefined : agg.entry(del.region));
</script>

{#snippet create()}<Button variant="primary" href="/tls/policy/new">＋ 만들기</Button>{/snippet}
{#snippet createIn()}<RegionCreate {agg} href="/tls/policy/new" />{/snippet}

{#if agg.on}<RegionNotices notices={agg.notices} />{:else}<WriteNote spaced />{/if}
{#snippet table()}
<DataTable label="TLS 정책 목록" {rows} rowKey={(r) => r.rid} columns={agg.on ? withRegionColumn(columns, regionColumn<AggRow>()) : columns}
  {...(agg.on ? agg.listState : { loading: !desk.live })} bind:selected search={{}} fill
  emptyTitle="TLS 정책이 없어요" emptyBody="HTTPS 리스너를 열려면 하나가 필요해요."
  onopen={(r) => { void goto(at(r, resourcePath('tlsPolicy', r.key))); }} rowMenu={menu}>
  {#snippet cell(r, col)}
    <!-- 이름 칸 — 시안 m(name). 뒤의 「◐ 적용 대기」 는 시안에 없던 기존 표시다(이름 칸 뒤, 배지 모양). -->
    {#if col.key === 'key'}{r.key}{#if agg.on}{@const e = agg.entry(r.region)}{#if e !== undefined}<InRegion entry={e}><PendingMark kind="tlsPolicy" key={r.key} /></InRegion>{/if}{:else}<PendingMark kind="tlsPolicy" key={r.key} />{/if}
    {:else}{col.text?.(r) ?? ''}{/if}
  {/snippet}
</DataTable>
{/snippet}

<ListSplit kind="tlsPolicy" bind:selected {table}>
  {#snippet inline({ key, detailHref, pending })}<TlsPolicyInline {key} {detailHref} {pending} />{/snippet}
</ListSplit>
{#if delEntry !== undefined}
  <!-- 합산: 삭제 확인(사용처)과 쓰기가 그 행의 지역을 본다. -->
  {#key delEntry.name}<InRegion entry={delEntry}><DeleteConfirm bind:target={del} /></InRegion>{/key}
{:else}
  <DeleteConfirm bind:target={del} />
{/if}
