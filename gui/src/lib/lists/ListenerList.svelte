<script lang="ts">
  /**
   * 리스너 목록 — 콘솔 시안 `colsOf('listeners')` · `cells('listeners', r)` 그대로(`traffic-cells.ts`).
   * 이름 · 프로토콜 · 바인드:포트 · 기본 풀 / 동작 · 라우트 · 출발지 제한 · 상태 · 활성화. 칸은 평문이다(링크 없음).
   * 상태는 적용 대기를 반영한다 — 커밋했지만 소켓을 아직 안 연 리스너는 「◐ 반영대기」, 바꾼 리스너는 「◐ 적용 대기」.
   * 행을 누르면 아래에 분할 상세가 열리고 그 자리에서 고친다(시안 `INL.listeners`: 바인드 주소 · 포트 · 활성화 · 기본 풀 · 출발지 제한).
   * Enter · 두 번 누르기 · 「상세 페이지 ↗」 로 상세를 연다. 행 메뉴는 시안 `actsOf`: 상세 페이지 열기 · 활성화/비활성화 · 삭제….
   *
   * **전체 합산**(전역에서 지역을 안 골랐다, §2.5)이면 지역마다 행을 만들어 잇고, 맨 끝에 「지역」 열을 둔다(시안 `lcols`).
   * 행의 상세는 그 지역으로 좁혀 열고, 켜고 끄기 · 삭제 · 인라인 수정은 그 지역의 desk 로 쓴다(`useAggregate`).
   */
  import { getContext } from 'svelte';
  import { goto } from '$app/navigation';
  import { itemOf, resourcePath } from '@web/resources';
  import { after } from '#lib/after';
  import { Button, DataTable, Menu, type MenuItem } from '#lib/ui';
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
  import ListenerInline from '#lib/listener/ListenerInline.svelte';
  import DeleteConfirm from './DeleteConfirm.svelte';
  import { listState } from './list-state';
  import { listenerColumns, listenerRowsOf, type ListenerRow } from './traffic-cells';

  type Desk = ReturnType<typeof createDesk>;
  /** 합산이면 행에 지역이 붙는다(`region` · `rid`). 지역 인스턴스 · 좁혀 보기면 `region` 은 '' 이고 `rid` 는 키다. */
  type AggRow = RegionRow<ListenerRow>;
  const desk = getContext<Desk>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const agg = useAggregate();
  // 쓸 수 없으면(지역을 안 골랐다 · 팔로워 · 고른 지역과 연락 없음) 만들기 · 수정 · 삭제를 안 보인다.
  const ro = $derived(scope?.blocked === true);
  /** 이 행에 쓸 수 있나 — 합산이면 그 행의 지역에, 아니면 셸의 판정(`ro`) 그대로. */
  const rowRo = (r: AggRow): boolean => (agg.on ? !agg.writable(r.region) : ro);
  /** 이 행의 주소 — 합산이면 그 행의 지역으로 좁혀 연다. */
  const at = (r: AggRow, path: string): string => (agg.on ? agg.href(r.region, path) : path);
  let del = $state<{ kind: 'listener'; key: string; region: string } | undefined>();
  let selected = $state<string[]>([]);

  const rowsOf = (desk: Desk): ListenerRow[] => listenerRowsOf(desk);
  const rows = $derived<AggRow[]>(agg.on ? agg.rows(rowsOf, (r) => r.key) : rowsOf(desk).map((r) => ({ ...r, region: '', rid: r.key })));
  const columns = listenerColumns<AggRow>();
  /** 합산이면 「지역」 열을 맨 끝에(시안 `lcols`). */
  const shownColumns = $derived(agg.on ? withRegionColumn(columns, regionColumn<AggRow>()) : columns);
  /** 켜고 끄기 — 그 행의 지역 desk 로 쓴다(합산). 아니면 셸의 desk. */
  const toggle = (r: AggRow): void => {
    const d = agg.on ? agg.entry(r.region)?.desk : desk;
    const m = d === undefined ? undefined : itemOf(d.model, 'listener', r.key);
    if (d === undefined || m === undefined) return;
    const { key: _k, ...body } = m;
    void d.putResource('listener', r.key, { ...body, enabled: m['enabled'] === false }).then(after());
  };
  /** 시안 `actsOf('listeners')` — 상세 페이지 열기 · 비활성화/활성화 · 삭제…. 쓸 수 없는 행은 상세만. */
  const menu = (r: AggRow): MenuItem[] => [
    { label: '상세 페이지 열기', href: at(r, resourcePath('listener', r.key)) },
    ...(rowRo(r) ? [] : [
      { label: r.enabled ? '비활성화' : '활성화', onselect: () => toggle(r) },
      { label: '삭제…', danger: true, onselect: () => { del = { kind: 'listener', key: r.key, region: r.region }; } },
    ]),
  ];
  // 합산이면 만들기는 지역을 먼저 고른다(RegionCreate). 쓸 지역이 하나도 없으면 안 보인다.
  usePageActions(() => (agg.on ? (agg.entries.some((e) => e.writable) ? createIn : undefined) : ro ? undefined : create));
  const delEntry = $derived(del === undefined || !agg.on ? undefined : agg.entry(del.region));
  /** 시안 `createItems`(리스너 화면) — 빠른 프록시 만들기 · 리스너 만들기. */
  const createItems: MenuItem[] = [
    { label: '빠른 프록시 만들기', description: '리스너, 풀, 백엔드를 한 번에 만들어요.', href: '/traffic/listener/new/quick' },
    { label: '리스너 만들기', description: '프로토콜을 먼저 선택해요.', href: '/traffic/listener/new' },
  ];
</script>

{#snippet create()}
  <Menu items={createItems} label="만들기">
    {#snippet trigger({ open, toggle: t })}<Button variant="primary" aria-haspopup="menu" aria-expanded={open} onclick={t}>＋ 만들기 ▾</Button>{/snippet}
  </Menu>
{/snippet}

{#snippet createIn()}
  <RegionCreate {agg} href="/traffic/listener/new/quick" label="빠른 프록시 만들기" variant="secondary" />
  <RegionCreate {agg} href="/traffic/listener/new" />
{/snippet}

{#snippet table()}
{#if agg.on}<RegionNotices notices={agg.notices} />{:else}<WriteNote spaced />{/if}
<DataTable label="리스너 목록" {rows} rowKey={(r) => r.rid} columns={shownColumns} {...(agg.on ? agg.listState : listState(desk))} bind:selected fill
  search={{ placeholder: '이름·주소로 찾기' }}
  emptyTitle="리스너가 없어요" emptyBody="포트를 열면 트래픽을 받아요. 패스스루는 인증서를 제시하지 않아요."
  onopen={(r) => { void goto(at(r, resourcePath('listener', r.key))); }} rowMenu={menu}>
  {#snippet cell(r, c)}{#if c.key === 'key'}{r.key}{/if}{/snippet}
</DataTable>
{/snippet}

<ListSplit kind="listener" bind:selected {table}>
  {#snippet inline({ key, detailHref, pending })}<ListenerInline {key} {detailHref} {pending} />{/snippet}
</ListSplit>
{#if delEntry !== undefined}
  <!-- 합산: 삭제 확인과 쓰기가 그 행의 지역을 본다(관계 · 커밋 모두 그 지역). -->
  {#key delEntry.name}<InRegion entry={delEntry}><DeleteConfirm bind:target={del} /></InRegion>{/key}
{:else}
  <DeleteConfirm bind:target={del} />
{/if}
