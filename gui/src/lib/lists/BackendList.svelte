<script lang="ts">
  /**
   * 백엔드 목록 — 시안 §4 · §5.3. 이름 · 풀 · 호스트:포트 · 가중치 · 헬스 · 트래픽 수신 · 드레인 · 마지막 관측.
   * 여러 개를 골라 드레인 · 드레인 해제를 한 번에 한다. 드레인은 설정(commit)이 아니다 — 바로 걸린다.
   * 하나를 고르면 아래에 분할 상세가 열린다 — 「트래픽을 받지 않는 이유」 가 거기 있다(시안).
   *
   * **전체 합산**(전역에서 지역을 안 골랐다, §2.5)이면 지역마다 행을 만들어 잇고, 셋째 열 뒤에 「지역」 열을 둔다.
   * 드레인 · 풀에서 빼기는 그 행의 지역 desk 로, 수정 · 상세는 그 지역으로 좁혀 연다(`useAggregate`).
   * 여러 지역의 행을 골라 드레인하면 지역마다 따로 보낸다 — 한 요청이 두 지역에 걸치지 않는다(§1.1).
   */
  import { getContext } from 'svelte';
  import { goto } from '$app/navigation';
  import { itemsOf, resourcePath } from '@web/resources';
  import { trafficMarkOf } from '@web/pools-view';
  import { Badge, Button, DataTable, toast, type Column, type FilterChip, type MenuItem } from '#lib/ui';
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
  import { HEALTH_MARK, ago, backendHealth, type HealthKind } from '#lib/detail/facts';
  import DeleteConfirm from './DeleteConfirm.svelte';
  import PendingMark from './PendingMark.svelte';
  import { listState } from './list-state';

  type Row = { key: string; pool: string; addr: string; weight: number; health: HealthKind; receiving: boolean | undefined; draining: boolean; why: string[]; seen?: string };
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
  let del = $state<{ kind: 'backend'; key: string; region: string } | undefined>();
  let selected = $state<string[]>([]);

  const rowsOf = (desk: Desk): Row[] => itemsOf(desk.model, 'backend').map((b) => {
    const key = String(b['key']);
    const t = desk.traffic.get(key);
    const seen = ago(t?.observedAt);
    return {
      key, pool: String(b['pool']), addr: `${String(b['host'])}:${String(b['port'])}`,
      weight: typeof b['weight'] === 'number' ? b['weight'] : 1,
      health: backendHealth(desk, key),
      receiving: t?.receivingTraffic, draining: t?.reasons.includes('draining') === true,
      // 이유 코드는 사람 말로 바꾼다(제안 #9) — 드레인은 배지가 따로 말하므로 뺀다.
      why: trafficMarkOf(t === undefined ? undefined : { ...t, reasons: t.reasons.filter((x) => x !== 'draining') })?.reasons ?? [],
      ...(seen === undefined ? {} : { seen }),
    };
  });
  const rows = $derived<AggRow[]>(agg.on ? agg.rows(rowsOf, (r) => r.key) : rowsOf(desk).map((r) => ({ ...r, region: '', rid: r.key })));
  const columns: Column<AggRow>[] = [
    { key: 'key', label: '이름', mono: true, sort: (r) => r.key },
    { key: 'pool', label: '풀', mono: true, sort: (r) => r.pool },
    { key: 'addr', label: '호스트:포트', mono: true, sort: (r) => r.addr },
    { key: 'weight', label: '가중치', mono: true, align: 'right', sort: (r) => r.weight },
    { key: 'health', label: '헬스', sort: (r) => r.health },
    { key: 'receiving', label: '트래픽 수신', sort: (r) => (r.receiving === true ? 1 : 0) },
    { key: 'draining', label: '드레인', sort: (r) => (r.draining ? 1 : 0) },
    { key: 'seen', label: '마지막 관측', muted: true, sort: (r) => r.seen ?? '' },
  ];
  /** 합산이면 「지역」 열을 셋째 열 뒤에(시안). */
  const shownColumns = $derived(agg.on ? withRegionColumn(columns, regionColumn<AggRow>()) : columns);
  const chips: FilterChip<AggRow>[] = [
    { key: 'ok', label: '정상', tone: 'ok', match: (r) => r.health === 'healthy' },
    { key: 'bad', label: '비정상', tone: 'danger', match: (r) => r.health === 'unhealthy' },
    { key: 'checking', label: '확인 중', tone: 'info', match: (r) => r.health === 'checking' },
    { key: 'drain', label: '드레인 중', tone: 'drain', match: (r) => r.draining },
    { key: 'none', label: '관측 없음', tone: 'neutral', match: (r) => r.health === 'none' },
  ];
  /**
   * 드레인 · 해제 — 키는 표의 행 키(`rid`)다. 합산이면 그 행의 지역 desk 로 하나씩 보낸다(쓸 수 없는 지역의 행은 건너뛴다).
   * 지역 인스턴스 · 좁혀 보기면 `rid` 가 곧 키이고 셸의 desk 로 보낸다.
   */
  const drainAll = async (keys: string[], on: boolean): Promise<void> => {
    let n = 0;
    for (const id of keys) {
      const t = agg.on ? agg.split(id) : { region: '', key: id };
      const d = agg.on ? (t !== undefined && agg.writable(t.region) ? agg.entry(t.region)?.desk : undefined) : desk;
      if (t === undefined || d === undefined) continue;
      if (await (on ? d.drain(t.key) : d.undrain(t.key))) n++;
    }
    if (n > 0) toast.ok(on ? '드레인했어요' : '드레인을 풀었어요', `${n}개 — 설정이 아니라 바로 걸려요.`);
    selected = [];
  };
  const menu = (r: AggRow): MenuItem[] => [
    ...(rowRo(r) ? [] : [
      { label: r.draining ? '드레인 해제' : '드레인', onselect: () => { void drainAll([r.rid], !r.draining); } },
    ]),
    { label: '상세 페이지 열기', href: at(r, resourcePath('backend', r.key)) },
    ...(rowRo(r) ? [] : [
      { label: '수정', href: at(r, resourcePath('backend', r.key, 'settings')) },
      { label: '풀에서 빼기…', danger: true, onselect: () => { del = { kind: 'backend', key: r.key, region: r.region }; } },
    ]),
  ];
  // 합산이면 만들기는 지역을 먼저 고른다(RegionCreate). 쓸 지역이 하나도 없으면 안 보인다.
  usePageActions(() => (agg.on ? (agg.entries.some((e) => e.writable) ? createIn : undefined) : ro ? undefined : create));
  /** 합산에서 고를 수 있나 — 쓸 수 있는 지역이 하나라도 있으면. 아니면 셸의 판정 그대로. */
  const selectable = $derived(agg.on ? agg.entries.some((e) => e.writable) : !ro);
  const delEntry = $derived(del === undefined || !agg.on ? undefined : agg.entry(del.region));
</script>

{#snippet create()}<Button variant="primary" href="/traffic/backend/new">＋ 만들기</Button>{/snippet}
{#snippet createIn()}<RegionCreate {agg} href="/traffic/backend/new" />{/snippet}

{#snippet table()}
{#if agg.on}<RegionNotices notices={agg.notices} />{:else}<WriteNote spaced />{/if}
<DataTable label="백엔드 목록" {rows} rowKey={(r) => r.rid} columns={shownColumns} {chips} {selectable} bind:selected pageSize={50}
  {...(agg.on ? agg.listState : listState(desk))} search={{ placeholder: '이름·풀·주소로 찾기', match: (r, q) => `${r.key} ${r.pool} ${r.addr}${agg.on ? ` ${r.region}` : ''}`.toLowerCase().includes(q) }}
  emptyTitle="등록된 백엔드가 없어요" emptyBody="백엔드를 더하면 풀이 트래픽을 받아요."
  onopen={(r) => { void goto(at(r, resourcePath('backend', r.key))); }} rowMenu={menu}>
  {#snippet cell(r, c)}
    {#if c.key === 'key'}<a href={at(r, resourcePath('backend', r.key))}>{r.key}</a>{#if agg.on}{@const e = agg.entry(r.region)}{#if e !== undefined}<InRegion entry={e}><PendingMark kind="backend" key={r.key} /></InRegion>{/if}{:else}<PendingMark kind="backend" key={r.key} />{/if}
    {:else if c.key === 'region'}{r.region}
    {:else if c.key === 'pool'}<a class="sub" href={at(r, resourcePath('pool', r.pool))}>{r.pool}</a>
    {:else if c.key === 'health'}
      {@const m = HEALTH_MARK[r.health]}<Badge tone={m.tone} icon={m.icon}>{m.text}</Badge>
    {:else if c.key === 'receiving'}
      {#if r.receiving === undefined}<span class="muted">모름</span>
      {:else if r.receiving}<Badge tone="ok" icon="●">수신 중</Badge>
      {:else}<span title={r.why.join(' · ')}><Badge tone="neutral" icon="○">수신 안 함</Badge>{#if r.why.length > 0}<span class="warn"> {r.why.join(' · ')}</span>{/if}</span>{/if}
    {:else if c.key === 'draining'}{#if r.draining}<Badge tone="drain" icon="⇣">드레인 중</Badge>{:else}<span class="muted">—</span>{/if}
    {:else if c.key === 'seen'}{r.seen ?? '—'}
    {:else if c.key === 'weight'}{r.weight}
    {:else}{String(r[c.key as keyof AggRow])}{/if}
  {/snippet}
  {#snippet bulk(keys)}
    <Button size="sm" onclick={() => { void drainAll(keys, true); }}>드레인</Button>
    <Button size="sm" onclick={() => { void drainAll(keys, false); }}>드레인 해제</Button>
  {/snippet}
</DataTable>
{/snippet}

<ListSplit kind="backend" bind:selected {table} />
{#if delEntry !== undefined}
  <!-- 합산: 확인 문구(풀 · 쓰는 리소스)와 삭제가 그 행의 지역을 본다. -->
  {#key delEntry.name}<InRegion entry={delEntry}><DeleteConfirm bind:target={del} remove /></InRegion>{/key}
{:else}
  <DeleteConfirm bind:target={del} remove />
{/if}

<style>
  .sub { color: var(--tx2); }
  .muted { color: var(--tx3); }
  .warn { color: var(--warn); }
</style>
