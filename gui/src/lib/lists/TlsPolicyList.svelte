<script lang="ts">
  /**
   * TLS 정책 목록 — 이름 · 최소 · 최대 버전 · 암호군 · HSTS · SNI-Host 불일치 · 사용처.
   *
   * **전체 합산**(전역에서 지역을 안 골랐다, §2.5)이면 지역마다 행을 만들어 잇고, 셋째 열 뒤에 「지역」 열을 둔다.
   * 사용처는 그 행의 지역 안에서 센다. 상세 · 수정은 그 지역으로 좁혀 열고, 삭제는 그 지역의 desk 로 쓴다(`useAggregate`).
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
  import DeleteConfirm from './DeleteConfirm.svelte';
  import PendingMark from './PendingMark.svelte';

  type Row = { key: string; min: string; max: string; cipher: string; hsts?: number; mismatch: string; used: number };
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
  let del = $state<{ kind: 'tlsPolicy'; key: string; region: string } | undefined>();

  const rowsOf = (desk: Desk): Row[] => itemsOf(desk.model, 'tlsPolicy').map((p) => {
    const key = String(p['key']);
    const cp = p['cipherPolicy'];
    const hsts = p['hsts'] as Record<string, unknown> | undefined;
    return {
      key, min: String(p['minVersion'] ?? ''), max: typeof p['maxVersion'] === 'string' ? p['maxVersion'] : '—',
      cipher: typeof cp === 'string' ? cp : cp === undefined ? 'intermediate-2026 (기본)' : JSON.stringify(cp),
      ...(typeof hsts?.['maxAgeSeconds'] === 'number' ? { hsts: hsts['maxAgeSeconds'] } : {}),
      mismatch: p['sniHostMismatch'] === 'reject_421' ? '거절 (421)' : '허용',
      used: relationsOf(desk.model, { kind: 'tlsPolicy', key }).usedBy.length,
    };
  });
  const rows = $derived<AggRow[]>(agg.on ? agg.rows(rowsOf, (r) => r.key) : rowsOf(desk).map((r) => ({ ...r, region: '', rid: r.key })));
  const columns: Column<AggRow>[] = [
    { key: 'key', label: '이름', mono: true, sort: (r) => r.key },
    { key: 'min', label: '최소 버전', mono: true, sort: (r) => r.min },
    { key: 'max', label: '최대 버전', mono: true, muted: true, sort: (r) => r.max },
    { key: 'cipher', label: '암호군', mono: true, muted: true, sort: (r) => r.cipher },
    { key: 'hsts', label: 'HSTS', sort: (r) => r.hsts ?? -1 },
    { key: 'mismatch', label: 'SNI-Host 불일치', sort: (r) => r.mismatch },
    { key: 'used', label: '사용처', align: 'right', mono: true, sort: (r) => r.used },
  ];
  /** 합산이면 「지역」 열을 셋째 열 뒤에(시안). */
  const shownColumns = $derived(agg.on ? withRegionColumn(columns, regionColumn<AggRow>()) : columns);
  const menu = (r: AggRow): MenuItem[] => [
    { label: '상세를 봐요', href: at(r, resourcePath('tlsPolicy', r.key)) },
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
<DataTable label="TLS 정책 목록" {rows} rowKey={(r) => r.rid} columns={shownColumns} {...(agg.on ? agg.listState : { loading: !desk.live })}
  search={{ placeholder: '이름으로 찾기', match: (r, q) => `${r.key}${agg.on ? ` ${r.region}` : ''}`.toLowerCase().includes(q) }}
  emptyTitle="TLS 정책이 없어요" emptyBody="HTTPS 리스너를 열려면 하나가 필요해요."
  onopen={(r) => { void goto(at(r, resourcePath('tlsPolicy', r.key))); }} rowMenu={menu}>
  {#snippet cell(r, c)}
    {#if c.key === 'key'}<a href={at(r, resourcePath('tlsPolicy', r.key))}>{r.key}</a>{#if agg.on}{@const e = agg.entry(r.region)}{#if e !== undefined}<InRegion entry={e}><PendingMark kind="tlsPolicy" key={r.key} /></InRegion>{/if}{:else}<PendingMark kind="tlsPolicy" key={r.key} />{/if}
    {:else if c.key === 'region'}{r.region}
    {:else if c.key === 'min'}TLS {r.min}
    {:else if c.key === 'max'}{r.max === '—' ? '—' : `TLS ${r.max}`}
    {:else if c.key === 'hsts'}{#if r.hsts !== undefined}<Badge tone="ok" icon="●">max-age {r.hsts}s</Badge>{:else}<span class="sub">꺼짐</span>{/if}
    {:else if c.key === 'used'}{r.used}
    {:else}{String(r[c.key as keyof AggRow])}{/if}
  {/snippet}
</DataTable>
{#if delEntry !== undefined}
  <!-- 합산: 삭제 확인(사용처)과 쓰기가 그 행의 지역을 본다. -->
  {#key delEntry.name}<InRegion entry={delEntry}><DeleteConfirm bind:target={del} /></InRegion>{/key}
{:else}
  <DeleteConfirm bind:target={del} />
{/if}

<style>.sub { color: var(--tx3); }</style>
