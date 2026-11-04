<script lang="ts">
  /**
   * 풀 목록 — 시안 §5.3. 이름 · 프로토콜 계열 · 알고리즘 · 백엔드(정상 / 전체) · 헬스체크 · 업스트림 TLS.
   * 행을 누르면 아래에 분할 상세가 열린다 — 요약과 소속 백엔드(시안).
   *
   * **전체 합산**(전역에서 지역을 안 골랐다, §2.5)이면 지역마다 행을 만들어 잇고, 셋째 열 뒤에 「지역」 열을 둔다.
   * 행의 수정 · 상세 · 백엔드 넣기는 그 지역으로 좁혀 열고, 삭제는 그 지역의 desk 로 쓴다(`useAggregate`).
   * 분할 상세의 소속 백엔드는 그 행의 지역 desk 를 읽는다(`ListSplit` 이 `InRegion` 으로 감싼다).
   */
  import { getContext } from 'svelte';
  import { goto } from '$app/navigation';
  import { itemOf, resourcePath } from '@web/resources';
  import { Badge, Button, DataTable, type Column, type FilterChip, type MenuItem } from '#lib/ui';
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
  import { healthCheckText, poolMark, type Mark } from '#lib/detail/facts';
  import DeleteConfirm from './DeleteConfirm.svelte';
  import PendingMark from './PendingMark.svelte';
  import { listState } from './list-state';

  type Row = { key: string; cls: string; alg: string; total: number; healthy: number; unhealthy: number; mark: Mark; hc: string; tls: boolean };
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
  let del = $state<{ kind: 'pool'; key: string; region: string } | undefined>();
  let selected = $state<string[]>([]);

  const rowsOf = (desk: Desk): Row[] => desk.pools.rows.map((p) => {
    const m = itemOf(desk.model, 'pool', p.key);
    const tls = (m?.['upstreamTls'] as { enabled?: boolean } | undefined)?.enabled === true;
    return {
      key: p.key, cls: p.protocolClass.toUpperCase(), alg: p.algorithm, total: p.backends.length, healthy: p.healthy, unhealthy: p.unhealthy,
      mark: poolMark(desk, p.key), hc: healthCheckText(m), tls,
    };
  });
  const rows = $derived<AggRow[]>(agg.on ? agg.rows(rowsOf, (r) => r.key) : rowsOf(desk).map((r) => ({ ...r, region: '', rid: r.key })));
  const columns: Column<AggRow>[] = [
    { key: 'key', label: '이름', mono: true, sort: (r) => r.key },
    { key: 'cls', label: '프로토콜 계열', sort: (r) => r.cls },
    { key: 'alg', label: '알고리즘', mono: true, sort: (r) => r.alg },
    { key: 'total', label: '백엔드 (정상 / 전체)', sort: (r) => r.healthy / Math.max(1, r.total) },
    { key: 'hc', label: '헬스체크', mono: true, sort: (r) => r.hc },
    { key: 'tls', label: '업스트림 TLS', sort: (r) => (r.tls ? 1 : 0) },
  ];
  /** 합산이면 「지역」 열을 셋째 열 뒤에(시안). */
  const shownColumns = $derived(agg.on ? withRegionColumn(columns, regionColumn<AggRow>()) : columns);
  const chips: FilterChip<AggRow>[] = [
    { key: 'bad', label: '비정상 백엔드 있음', tone: 'danger', match: (r) => r.unhealthy > 0 },
    { key: 'empty', label: '백엔드 없음', tone: 'warn', match: (r) => r.total === 0 },
  ];
  const menu = (r: AggRow): MenuItem[] => [
    { label: '상세 페이지 열기', href: at(r, resourcePath('pool', r.key)) },
    ...(rowRo(r) ? [] : [
      { label: '백엔드 넣기', href: at(r, `/traffic/backend/new?pool=${encodeURIComponent(r.key)}`) },
      { label: '수정', href: at(r, resourcePath('pool', r.key, 'settings')) },
      { label: '삭제…', danger: true, onselect: () => { del = { kind: 'pool', key: r.key, region: r.region }; } },
    ]),
  ];
  // 합산이면 만들기는 지역을 먼저 고른다(RegionCreate). 쓸 지역이 하나도 없으면 안 보인다.
  usePageActions(() => (agg.on ? (agg.entries.some((e) => e.writable) ? createIn : undefined) : ro ? undefined : create));
  const delEntry = $derived(del === undefined || !agg.on ? undefined : agg.entry(del.region));
</script>

{#snippet create()}<Button variant="primary" href="/traffic/pool/new">＋ 만들기</Button>{/snippet}
{#snippet createIn()}<RegionCreate {agg} href="/traffic/pool/new" />{/snippet}

{#snippet table()}
{#if agg.on}<RegionNotices notices={agg.notices} />{:else}<WriteNote spaced />{/if}
<DataTable label="풀 목록" {rows} rowKey={(r) => r.rid} columns={shownColumns} {chips} {...(agg.on ? agg.listState : listState(desk))} bind:selected
  search={{ placeholder: '이름·알고리즘으로 찾기', match: (r, q) => `${r.key} ${r.alg} ${r.cls}${agg.on ? ` ${r.region}` : ''}`.toLowerCase().includes(q) }}
  emptyTitle="풀이 없어요" emptyBody="풀과 첫 백엔드를 같이 만들어요. 빈 풀은 저장되지 않아요."
  onopen={(r) => { void goto(at(r, resourcePath('pool', r.key))); }} rowMenu={menu}>
  {#snippet cell(r, c)}
    {#if c.key === 'key'}<a href={at(r, resourcePath('pool', r.key))}>{r.key}</a>{#if agg.on}{@const e = agg.entry(r.region)}{#if e !== undefined}<InRegion entry={e}><PendingMark kind="pool" key={r.key} /></InRegion>{/if}{:else}<PendingMark kind="pool" key={r.key} />{/if}
    {:else if c.key === 'region'}{r.region}
    {:else if c.key === 'total'}<Badge tone={r.mark.tone} icon={r.mark.icon}>{r.mark.text}</Badge>
    {:else if c.key === 'tls'}{#if r.tls}<span>켜짐</span>{:else}<span class="muted">꺼짐</span>{/if}
    {:else}{String(r[c.key as keyof AggRow])}{/if}
  {/snippet}
</DataTable>
{/snippet}

<ListSplit kind="pool" bind:selected {table} />
{#if delEntry !== undefined}
  <!-- 합산: 삭제 확인(쓰는 리소스)과 쓰기가 그 행의 지역을 본다. -->
  {#key delEntry.name}<InRegion entry={delEntry}><DeleteConfirm bind:target={del} /></InRegion>{/key}
{:else}
  <DeleteConfirm bind:target={del} />
{/if}

<style>.muted { color: var(--tx3); }</style>
