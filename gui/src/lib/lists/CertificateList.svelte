<script lang="ts">
  /**
   * 인증서 목록 — 시안 §5.3. 이름 · 도메인 · 발급(ACME / 업로드) · 만료(임박 강조) · 사용처.
   *
   * **전체 합산**(전역에서 지역을 안 골랐다, §2.5)이면 지역마다 행을 만들어 잇고, 셋째 열 뒤에 「지역」 열을 둔다.
   * 만료 · 사용처는 그 행의 지역 것이다. 상세 · 「자료를 교체해요」 는 그 지역으로 좁혀 열고, 삭제는 그 지역의 desk 로 쓴다(`useAggregate`).
   */
  import { getContext } from 'svelte';
  import { goto } from '$app/navigation';
  import { relationsOf, resourcePath } from '@web/resources';
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
  import DeleteConfirm from './DeleteConfirm.svelte';
  import PendingMark from './PendingMark.svelte';

  type Row = { key: string; domains: string; acme: boolean; order?: string; days?: number; notAfter?: string; mark: 'missing' | 'expired' | 'ok'; used: number; usedText: string };
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
  let del = $state<{ kind: 'certificate'; key: string; region: string } | undefined>();
  /** 만료 임박 — 시안의 「만료 12일 전」 경고 기준. ACME 자동 갱신(30일 전)과 같다. */
  const SOON = 30;

  /** 사용처 — 시안 「리스너 2 · SNI 3」 · 「사용처 없음」. 풀(업스트림 CA)도 센다. 합산이면 그 행의 지역 안에서 센다. */
  const usage = (desk: Desk, key: string): { used: number; usedText: string } => {
    const by = relationsOf(desk.model, { kind: 'certificate', key }).usedBy;
    const n = (kind: string): number => by.filter((e) => e.from.kind === kind).length;
    const parts = [['리스너', n('listener')], ['SNI', n('sniBinding')], ['풀', n('pool')]] as const;
    const known = parts.reduce((a, [, k]) => a + k, 0);
    const text = [...parts.filter(([, k]) => k > 0).map(([l, k]) => `${l} ${k}`), ...(by.length > known ? [`기타 ${by.length - known}`] : [])].join(' · ');
    return { used: by.length, usedText: by.length === 0 ? '사용처 없음' : text };
  };
  const rowsOf = (desk: Desk): Row[] => desk.certs.rows.map((c) => ({
    key: c.key, domains: c.domains.join(', '), acme: c.acme, mark: c.mark,
    ...(c.orderState === undefined ? {} : { order: c.orderState }),
    ...(c.expiresInDays === undefined ? {} : { days: c.expiresInDays }),
    ...(c.notAfter === undefined ? {} : { notAfter: c.notAfter }),
    ...usage(desk, c.key),
  }));
  const rows = $derived<AggRow[]>(agg.on ? agg.rows(rowsOf, (r) => r.key) : rowsOf(desk).map((r) => ({ ...r, region: '', rid: r.key })));
  const columns: Column<AggRow>[] = [
    { key: 'key', label: '이름', mono: true, sort: (r) => r.key },
    { key: 'domains', label: '도메인', mono: true, sort: (r) => r.domains },
    { key: 'acme', label: '발급자', sort: (r) => (r.acme ? 1 : 0) },
    { key: 'days', label: '만료일', sort: (r) => r.days ?? -1 },
    { key: 'used', label: '사용처', sort: (r) => r.used },
  ];
  /** 합산이면 「지역」 열을 셋째 열 뒤에(시안). */
  const shownColumns = $derived(agg.on ? withRegionColumn(columns, regionColumn<AggRow>()) : columns);
  const chips: FilterChip<AggRow>[] = [
    { key: 'soon', label: '만료 임박', tone: 'warn', match: (r) => r.mark === 'ok' && r.days !== undefined && r.days < SOON },
    { key: 'expired', label: '만료됨', tone: 'danger', match: (r) => r.mark === 'expired' },
    { key: 'missing', label: '자료 없음', tone: 'neutral', match: (r) => r.mark === 'missing' },
  ];
  const menu = (r: AggRow): MenuItem[] => [
    { label: '상세를 봐요', href: at(r, resourcePath('certificate', r.key)) },
    ...(rowRo(r) ? [] : [
      // 업로드 인증서만 — ACME 는 스케줄러가 갱신한다. 같은 이름 · 업로드로 채운 폼을 연다(합산이면 그 행의 지역으로 좁혀).
      ...(r.acme ? [] : [{ label: '자료를 교체해요', href: at(r, `/tls/certificate/new?key=${encodeURIComponent(r.key)}&issuer=upload`) }]),
      { label: '삭제…', danger: true, onselect: () => { del = { kind: 'certificate', key: r.key, region: r.region }; } },
    ]),
  ];
  // 합산이면 만들기는 지역을 먼저 고른다(RegionCreate). 쓸 지역이 하나도 없으면 안 보인다.
  usePageActions(() => (agg.on ? (agg.entries.some((e) => e.writable) ? createIn : undefined) : ro ? undefined : create));
  const delEntry = $derived(del === undefined || !agg.on ? undefined : agg.entry(del.region));
</script>

{#snippet create()}<Button variant="primary" href="/tls/certificate/new">＋ 만들기</Button>{/snippet}
{#snippet createIn()}<RegionCreate {agg} href="/tls/certificate/new" />{/snippet}

{#if agg.on}<RegionNotices notices={agg.notices} />{:else}<WriteNote spaced />{/if}
<DataTable label="인증서 목록" {rows} rowKey={(r) => r.rid} columns={shownColumns} {chips} {...(agg.on ? agg.listState : { loading: !desk.live })}
  search={{ placeholder: '이름·도메인으로 찾기', match: (r, q) => `${r.key} ${r.domains}${agg.on ? ` ${r.region}` : ''}`.toLowerCase().includes(q) }}
  emptyTitle="인증서가 없어요" emptyBody="자료를 올리거나 ACME 로 발급해요. HTTPS 리스너에 필요해요."
  onopen={(r) => { void goto(at(r, resourcePath('certificate', r.key))); }} rowMenu={menu}>
  {#snippet cell(r, c)}
    {#if c.key === 'key'}<a href={at(r, resourcePath('certificate', r.key))}>{r.key}</a>{#if agg.on}{@const e = agg.entry(r.region)}{#if e !== undefined}<InRegion entry={e}><PendingMark kind="certificate" key={r.key} /></InRegion>{/if}{:else}<PendingMark kind="certificate" key={r.key} />{/if}
    {:else if c.key === 'region'}{r.region}
    {:else if c.key === 'domains'}{r.domains || '—'}
    {:else if c.key === 'acme'}{#if r.acme}<Badge tone="info" icon="↻">ACME{r.order ? ` · ${r.order}` : ''}</Badge>{:else}<span class="sub">업로드</span>{/if}
    {:else if c.key === 'days'}
      {#if r.mark === 'missing' && r.acme}<Badge tone="pending">발급 대기</Badge>{:else if r.mark === 'missing'}<Badge tone="neutral">자료 없음</Badge>
      {:else if r.mark === 'expired'}<Badge tone="danger">{r.notAfter !== undefined ? `${r.notAfter.slice(0, 10)} (만료됨)` : '만료됨'}</Badge>
      {:else if r.days !== undefined && r.days < SOON}<Badge tone="warn">{r.notAfter !== undefined ? `${r.notAfter.slice(0, 10)} (${r.days}일 남음)` : `${r.days}일 남음`}</Badge>
      {:else}<span class="mono">{r.notAfter?.slice(0, 10) ?? '—'}</span>{#if r.days !== undefined}<span class="sub"> · {r.days}일</span>{/if}{/if}
    {:else if c.key === 'used'}<span class:sub={r.used === 0}>{r.usedText}</span>
    {/if}
  {/snippet}
</DataTable>
{#if delEntry !== undefined}
  <!-- 합산: 삭제 확인(사용처)과 쓰기가 그 행의 지역을 본다. -->
  {#key delEntry.name}<InRegion entry={delEntry}><DeleteConfirm bind:target={del} /></InRegion>{/key}
{:else}
  <DeleteConfirm bind:target={del} />
{/if}

<style>
  .sub { color: var(--tx2); }
  .mono { font-family: var(--mono); }
</style>
