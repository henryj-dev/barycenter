<script lang="ts">
  /**
   * 주소 집합 목록 — 이름(@) · 대역 수 · 출처 · 사용처. 리스너의 출발지 제한 · 신뢰 대역과 라우트 출발지 규칙이
   * `@이름` 으로 참조한다(#114). 행을 누르면 아래에 분할 상세가 열린다(시안).
   *
   * **전체 합산**(전역에서 지역을 안 골랐다, §2.5)이면 지역마다 행을 만들어 잇고, 셋째 열 뒤에 「지역」 열을 둔다.
   * 사용처는 그 지역 안에서 센다. 행의 수정 · 상세는 그 지역으로 좁혀 열고, 삭제는 그 지역의 desk 로 쓴다(`useAggregate`).
   */
  import { getContext } from 'svelte';
  import { goto } from '$app/navigation';
  import { itemsOf, relationsOf, resourcePath } from '@web/resources';
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
  import { listState } from './list-state';

  type Row = { key: string; count: number; source: string; used: number };
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
  let del = $state<{ kind: 'addressSet'; key: string; region: string } | undefined>();
  let selected = $state<string[]>([]);

  const rowsOf = (desk: Desk): Row[] => itemsOf(desk.model, 'addressSet').map((s) => {
    const key = String(s['key']);
    return {
      key, count: Array.isArray(s['cidrs']) ? s['cidrs'].length : 0,
      source: typeof s['source'] === 'string' ? s['source'] : '직접 입력',
      used: relationsOf(desk.model, { kind: 'addressSet', key }).usedBy.length,
    };
  });
  const rows = $derived<AggRow[]>(agg.on ? agg.rows(rowsOf, (r) => r.key) : rowsOf(desk).map((r) => ({ ...r, region: '', rid: r.key })));
  const columns: Column<AggRow>[] = [
    { key: 'key', label: '이름', mono: true, sort: (r) => r.key },
    { key: 'count', label: '대역 수', mono: true, align: 'right', sort: (r) => r.count },
    { key: 'source', label: '출처', sort: (r) => r.source },
    { key: 'used', label: '사용처', mono: true, align: 'right', sort: (r) => r.used },
  ];
  /** 합산이면 「지역」 열을 셋째 열 뒤에(시안). */
  const shownColumns = $derived(agg.on ? withRegionColumn(columns, regionColumn<AggRow>()) : columns);
  const menu = (r: AggRow): MenuItem[] => [
    { label: '상세 페이지 열기', href: at(r, resourcePath('addressSet', r.key)) },
    ...(rowRo(r) ? [] : [
      { label: '수정', href: at(r, resourcePath('addressSet', r.key, 'settings')) },
      { label: '삭제…', danger: true, onselect: () => { del = { kind: 'addressSet', key: r.key, region: r.region }; } },
    ]),
  ];
  // 합산이면 만들기는 지역을 먼저 고른다(RegionCreate). 쓸 지역이 하나도 없으면 안 보인다.
  usePageActions(() => (agg.on ? (agg.entries.some((e) => e.writable) ? createIn : undefined) : ro ? undefined : create));
  const delEntry = $derived(del === undefined || !agg.on ? undefined : agg.entry(del.region));
</script>

{#snippet create()}<Button variant="primary" href="/traffic/address-set/new">＋ 만들기</Button>{/snippet}
{#snippet createIn()}<RegionCreate {agg} href="/traffic/address-set/new" />{/snippet}

{#snippet table()}
{#if agg.on}<RegionNotices notices={agg.notices} />{:else}<WriteNote spaced />{/if}
<DataTable label="주소 집합 목록" {rows} rowKey={(r) => r.rid} columns={shownColumns} {...(agg.on ? agg.listState : listState(desk))} bind:selected
  search={{ placeholder: '이름으로 찾기', match: (r, q) => `${r.key}${agg.on ? ` ${r.region}` : ''}`.toLowerCase().includes(q) }}
  emptyTitle="주소 집합이 없어요" emptyBody="리스너의 출발지 제한에서 @이름 으로 써요. CLI 의 bary address-set create --cloudflare 로도 만들어요."
  onopen={(r) => { void goto(at(r, resourcePath('addressSet', r.key))); }} rowMenu={menu}>
  {#snippet cell(r, c)}
    {#if c.key === 'key'}<a href={at(r, resourcePath('addressSet', r.key))}>@{r.key}</a>{#if agg.on}{@const e = agg.entry(r.region)}{#if e !== undefined}<InRegion entry={e}><PendingMark kind="addressSet" key={r.key} /></InRegion>{/if}{:else}<PendingMark kind="addressSet" key={r.key} />{/if}
    {:else if c.key === 'region'}{r.region}
    {:else if c.key === 'source'}{#if r.source === '직접 입력'}<span class="sub">직접 입력</span>{:else}<Badge tone="info" icon="↻">{r.source}</Badge>{/if}
    {:else if c.key === 'count'}{r.count}개
    {:else if c.key === 'used'}{#if r.used === 0}<span class="sub">없음</span>{:else}{r.used}개{/if}
    {:else}{String(r[c.key as keyof AggRow])}{/if}
  {/snippet}
</DataTable>
{/snippet}

<ListSplit kind="addressSet" bind:selected {table} />
{#if delEntry !== undefined}
  <!-- 합산: 삭제 확인(쓰는 리소스)과 쓰기가 그 행의 지역을 본다. -->
  {#key delEntry.name}<InRegion entry={delEntry}><DeleteConfirm bind:target={del} /></InRegion>{/key}
{:else}
  <DeleteConfirm bind:target={del} />
{/if}

<style>.sub { color: var(--tx3); }</style>
