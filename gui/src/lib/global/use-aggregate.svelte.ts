/**
 * **목록이 전체 합산을 그리는 훅** (2026-11-04, docs/design-global-mode.md §2.5).
 *
 * 컴포넌트 초기화 때 부른다. 전역에서 지역을 안 골랐으면(`scope.aggregate`) 지역마다 desk 를 잡고(`acquire`),
 * 화면을 떠나거나 지역을 골라 좁히면 놓는다. 지역 인스턴스 · 좁혀 보기에서는 `on` 이 거짓이고 아무것도 안 붙는다 —
 * 그때 목록은 지금처럼 셸의 desk 하나로 그린다.
 *
 *   const agg = useAggregate();
 *   const rows = $derived(agg.on ? agg.rows((d) => rowsOf(d), (r) => r.key) : rowsOf(desk));
 *   const cols = $derived(agg.on ? withRegionColumn(columns, REGION_COLUMN) : columns);
 *
 * 쓰기는 **행의 지역**으로 간다(§1.1, 한 번에 한 지역): 그 자리에서 쓰는 것(켜고 끄기 · 드레인 · 삭제 확인)은 그 지역의 desk 로,
 * 주소가 있는 것(상세 · 수정 · 만들기)은 그 지역으로 좁혀 연다(`href` → `?region=`). 상세 화면은 셸의 desk 하나로 그리므로
 * 좁혀야 그 지역의 상세다.
 */
import { getContext } from 'svelte';
import type { createDesk } from '#lib/desk.svelte.ts';
import type { Column } from '#lib/ui';
import type { Scope } from './scope.svelte.ts';
import type { RegionDesks, RegionEntry } from './regions.svelte.ts';
import { aggregateListState, inRegion, mergeRegionRows, regionNotices, splitRowId, type RegionNotice, type RegionRow } from './aggregate.ts';

type Desk = ReturnType<typeof createDesk>;

export type Aggregate = {
  /** 지금 전체 합산으로 그린다. 거짓이면 셸의 desk 하나로 그린다(지역 인스턴스 · 좁혀 보기). */
  readonly on: boolean;
  /** 지역마다 한 줄(상태 포함). `on` 이 거짓이면 빈 배열. */
  readonly entries: readonly RegionEntry[];
  /**
   * 붙어 있는(`ok`) 지역마다 `build` 로 행을 만들어 잇는다 — 행마다 `region` 과 지역마다 다른 키 `rid` 가 붙는다.
   * `DataTable` 의 `rowKey` 는 `(r) => r.rid` 다. 빠진 지역의 행은 없다(`notices` 가 말한다). `$derived` 안에서 부른다.
   */
  rows<T>(build: (desk: Desk, scope: Scope) => readonly T[], key: (row: T) => string): RegionRow<T>[];
  /** 목록 위 알림 — 「○ <지역> 연락 없음 — 이 지역의 행은 빠졌어요」 등. `RegionNotices.svelte` 가 그린다. */
  readonly notices: readonly RegionNotice[];
  /** `DataTable` 의 `loading` · `error`. 한 지역이라도 행을 줬으면 목록을 그린다. */
  readonly listState: { loading: boolean; error?: string };
  /** 지역 이름 또는 합산 행 키(`rid`)로 그 지역을 찾는다. */
  entry(regionOrRid: string): RegionEntry | undefined;
  /** 그 지역에 지금 쓸 수 있다 — 행 메뉴의 수정 · 삭제 · 드레인을 이것으로 연다. */
  writable(region: string): boolean;
  /** 이 주소를 그 지역으로 좁혀 연다(`?region=<이름>`). 상세 · 수정 · 만들기 링크에 쓴다. */
  href(region: string, path: string): string;
  /** 합산 행 키를 지역과 원래 키로 가른다. */
  split: typeof splitRowId;
};

/** 「지역」 열 — `withRegionColumn(columns, regionColumn())` 으로 셋째 열 뒤에 넣는다. 칸은 목록의 `cell` 스니펫이 `r.region` 으로 그린다. */
export const regionColumn = <T extends { region: string }>(): Column<T> => ({ key: 'region', label: '지역', mono: true, sort: (r) => r.region });

export function useAggregate(): Aggregate {
  const scope = getContext<Scope | undefined>('scope');
  const regions = getContext<RegionDesks | undefined>('regions');
  const on = $derived(scope?.aggregate === true && regions !== undefined);
  $effect(() => { if (on) return regions!.acquire(); });
  const entries = $derived(on ? regions!.entries : []);
  const states = $derived(entries.map((e) => ({ name: e.name, state: e.state })));
  const find = (x: string): RegionEntry | undefined => regions?.get(x) ?? regions?.get(splitRowId(x)?.region ?? '');
  return {
    get on() { return on; },
    get entries() { return entries; },
    rows(build, key) {
      return mergeRegionRows(entries.filter((e) => e.state === 'ok').map((e) => ({ region: e.name, rows: build(e.desk, e.scope) })), key);
    },
    get notices() { return regionNotices(states); },
    get listState() { return aggregateListState(states); },
    entry: find,
    writable(region) { return find(region)?.writable === true; },
    href: (region, path) => inRegion(path, region),
    split: splitRowId,
  };
}
