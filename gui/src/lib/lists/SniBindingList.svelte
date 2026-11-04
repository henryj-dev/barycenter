<script lang="ts">
  /**
   * SNI 바인딩 목록 — 시안 §5.3. 이름 · 리스너 · 호스트 · 인증서. 없는 인증서를 가리키면 표시한다.
   *
   * **전체 합산**(전역에서 지역을 안 골랐다, §2.5)이면 지역마다 행을 만들어 잇고, 셋째 열 뒤에 「지역」 열을 둔다.
   * 「없는 인증서」 는 그 행의 지역 안에서 본다. 상세 · 수정 · 리스너 · 인증서 링크는 그 지역으로 좁혀 열고,
   * 삭제는 그 지역의 desk 로 쓴다(`useAggregate`).
   */
  import { getContext } from 'svelte';
  import { goto } from '$app/navigation';
  import { itemOf, itemsOf, resourcePath } from '@web/resources';
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

  type Row = { key: string; listener: string; hosts: string; count: number; first: string; cert: string; certMissing: boolean };
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
  let del = $state<{ kind: 'sniBinding'; key: string; region: string } | undefined>();

  const rowsOf = (desk: Desk): Row[] => itemsOf(desk.model, 'sniBinding').map((b) => {
    const hs = Array.isArray(b['hosts']) ? (b['hosts'] as string[]) : [];
    return {
      key: String(b['key']), listener: String(b['listener']),
      hosts: hs.join(', '), count: hs.length,
      // 시안: 첫 호스트와 「외 N」. 전체는 title 과 상세에서 본다.
      first: hs.length === 0 ? '—' : `${hs[0]}${hs.length > 1 ? ` 외 ${hs.length - 1}` : ''}`,
      cert: String(b['certificate']), certMissing: itemOf(desk.model, 'certificate', String(b['certificate'])) === undefined,
    };
  });
  const rows = $derived<AggRow[]>(agg.on ? agg.rows(rowsOf, (r) => r.key) : rowsOf(desk).map((r) => ({ ...r, region: '', rid: r.key })));
  const columns: Column<AggRow>[] = [
    { key: 'key', label: '이름', mono: true, sort: (r) => r.key },
    { key: 'listener', label: '리스너', mono: true, sort: (r) => r.listener },
    { key: 'count', label: '호스트 수', align: 'right', mono: true, sort: (r) => r.count },
    { key: 'hosts', label: '호스트', mono: true, sort: (r) => r.hosts },
    { key: 'cert', label: '인증서', mono: true, sort: (r) => r.cert },
  ];
  /** 합산이면 「지역」 열을 셋째 열 뒤에(시안). */
  const shownColumns = $derived(agg.on ? withRegionColumn(columns, regionColumn<AggRow>()) : columns);
  const menu = (r: AggRow): MenuItem[] => [
    { label: '상세를 봐요', href: at(r, resourcePath('sniBinding', r.key)) },
    ...(rowRo(r) ? [] : [
      { label: '수정해요', href: at(r, resourcePath('sniBinding', r.key, 'settings')) },
      { label: '삭제…', danger: true, onselect: () => { del = { kind: 'sniBinding', key: r.key, region: r.region }; } },
    ]),
  ];
  // 합산이면 만들기는 지역을 먼저 고른다(RegionCreate). 쓸 지역이 하나도 없으면 안 보인다.
  usePageActions(() => (agg.on ? (agg.entries.some((e) => e.writable) ? createIn : undefined) : ro ? undefined : create));
  const delEntry = $derived(del === undefined || !agg.on ? undefined : agg.entry(del.region));
</script>

{#snippet create()}<Button variant="primary" href="/tls/sni/new">＋ 만들기</Button>{/snippet}
{#snippet createIn()}<RegionCreate {agg} href="/tls/sni/new" />{/snippet}

{#if agg.on}<RegionNotices notices={agg.notices} />{:else}<WriteNote spaced />{/if}
<DataTable label="SNI 바인딩 목록" {rows} rowKey={(r) => r.rid} columns={shownColumns} {...(agg.on ? agg.listState : { loading: !desk.live })}
  search={{ placeholder: '이름·호스트로 찾기', match: (r, q) => `${r.key} ${r.hosts} ${r.cert}${agg.on ? ` ${r.region}` : ''}`.toLowerCase().includes(q) }}
  emptyTitle="SNI 바인딩이 없어요" emptyBody="HTTPS 호스트는 바인딩이 있어야 plan 이 돼요."
  onopen={(r) => { void goto(at(r, resourcePath('sniBinding', r.key))); }} rowMenu={menu}>
  {#snippet cell(r, c)}
    {#if c.key === 'key'}<a href={at(r, resourcePath('sniBinding', r.key))}>{r.key}</a>{#if agg.on}{@const e = agg.entry(r.region)}{#if e !== undefined}<InRegion entry={e}><PendingMark kind="sniBinding" key={r.key} /></InRegion>{/if}{:else}<PendingMark kind="sniBinding" key={r.key} />{/if}
    {:else if c.key === 'region'}{r.region}
    {:else if c.key === 'listener'}<a class="sub" href={at(r, resourcePath('listener', r.listener))}>{r.listener}</a>
    {:else if c.key === 'cert'}{#if r.certMissing}<Badge tone="danger">{r.cert} — 없음</Badge>{:else}<a class="sub" href={at(r, resourcePath('certificate', r.cert))}>{r.cert}</a>{/if}
    {:else if c.key === 'count'}{r.count}개
    {:else if c.key === 'hosts'}<span title={r.hosts}>{r.first}</span>
    {:else}{String(r[c.key as keyof AggRow])}{/if}
  {/snippet}
</DataTable>
{#if delEntry !== undefined}
  <!-- 합산: 삭제 확인과 쓰기가 그 행의 지역을 본다. -->
  {#key delEntry.name}<InRegion entry={delEntry}><DeleteConfirm bind:target={del} /></InRegion>{/key}
{:else}
  <DeleteConfirm bind:target={del} />
{/if}

<style>.sub { color: var(--tx2); }</style>
