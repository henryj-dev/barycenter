<script lang="ts">
  /**
   * 리스너 목록 — 시안 §5.3. 이름 · 프로토콜 · 바인드:포트 · 호스트 · 기본 풀 / 동작 · 라우트 수 · 출발지 제한 · 상태 · 활성화.
   * 상태는 적용 대기를 반영한다 — 커밋했지만 적용 안 한 리스너는 「적용하면 열림」, 지울 리스너는 「적용하면 닫힘」.
   * 행을 누르면 아래에 분할 상세가 열린다(시안).
   *
   * **전체 합산**(전역에서 지역을 안 골랐다, §2.5)이면 지역마다 행을 만들어 잇고, 셋째 열 뒤에 「지역」 열을 둔다.
   * 행의 수정 · 상세는 그 지역으로 좁혀 열고, 켜고 끄기 · 삭제는 그 지역의 desk 로 쓴다(`useAggregate`).
   */
  import { getContext } from 'svelte';
  import { goto } from '$app/navigation';
  import { itemOf, itemsOf, resourcePath } from '@web/resources';
  import type { ListenerMark } from '@web/listeners-view';
  import { after } from '#lib/after';
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
  import { LISTENER_MARK, sourceAllowSummary } from '#lib/detail/facts';
  import DeleteConfirm from './DeleteConfirm.svelte';
  import PendingMark from './PendingMark.svelte';
  import { listState } from './list-state';

  type Row = {
    id: string; key: string; protocol: string; bind: string; mark: ListenerMark;
    enabled: boolean; allow: { text: string; ranges: number; on: boolean }; action: string; routes: number;
    /** server_name (ADR-VHOST). http · https 만. 비면 그 포트의 기본 리스너다. */
    hosts: string;
    /** HTTPS 가 함께 여는 평문 리다이렉트 포트. */
    redirect?: number;
  };
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
  let del = $state<{ kind: 'listener'; key: string; region: string } | undefined>();
  let selected = $state<string[]>([]);

  const actionOf = (m: Record<string, unknown> | undefined): string => {
    if (m === undefined) return '—';
    const http = m['http'] as { defaultAction?: unknown } | undefined;
    const da = http?.defaultAction;
    if (m['protocol'] === 'http' || m['protocol'] === 'https') {
      return typeof da === 'object' && da !== null ? String((da as { pool: string }).pool) : '거절';
    }
    if (typeof m['defaultPool'] === 'string') return m['defaultPool'];
    return 'SNI 라우트';
  };
  const rowsOf = (desk: Desk): Row[] => desk.listeners.rows.map((r) => {
    const m = itemOf(desk.model, 'listener', r.key);
    const routeKind = r.protocol === 'tls_passthrough' ? 'passthroughRoute' : 'httpRoute';
    return {
      id: r.key, key: r.key, protocol: r.protocol, bind: `${r.bind}:${r.port}`,
      mark: r.mark, enabled: r.enabled, allow: sourceAllowSummary(desk.model, r.sourceAllow), action: actionOf(m),
      routes: itemsOf(desk.model, routeKind).filter((x) => x['listener'] === r.key).length,
      hosts: r.protocol !== 'http' && r.protocol !== 'https' ? '—'
        : Array.isArray(m?.['hosts']) ? (m['hosts'] as string[]).join(', ') : '기본',
      ...(r.redirect === undefined ? {} : { redirect: r.redirect.port }),
    };
  });
  const rows = $derived<AggRow[]>(agg.on ? agg.rows(rowsOf, (r) => r.key) : rowsOf(desk).map((r) => ({ ...r, region: '', rid: r.id })));
  const columns: Column<AggRow>[] = [
    { key: 'key', label: '이름', mono: true, sort: (r) => r.key },
    { key: 'protocol', label: '프로토콜', sort: (r) => r.protocol },
    { key: 'bind', label: '바인드:포트', mono: true, sort: (r) => r.bind },
    { key: 'hosts', label: '호스트', mono: true, text: (r) => r.hosts, sort: (r) => r.hosts },
    { key: 'action', label: '기본 풀 / 동작', mono: true, sort: (r) => r.action },
    { key: 'routes', label: '라우트', align: 'right', mono: true, sort: (r) => r.routes },
    { key: 'allow', label: '출발지 제한', text: (r) => r.allow.text, sort: (r) => r.allow.ranges },
    { key: 'mark', label: '상태', sort: (r) => r.mark },
    { key: 'enabled', label: '활성화', sort: (r) => (r.enabled ? 1 : 0) },
  ];
  /** 합산이면 「지역」 열을 셋째 열 뒤에(시안). */
  const shownColumns = $derived(agg.on ? withRegionColumn(columns, regionColumn<AggRow>()) : columns);
  const chips: FilterChip<AggRow>[] = [
    { key: 'stay', label: '서빙 중', tone: 'ok', match: (r) => r.mark === 'stay' },
    { key: 'join', label: LISTENER_MARK.join.text, tone: 'pending', match: (r) => r.mark === 'join' },
    { key: 'off', label: '꺼짐', tone: 'neutral', match: (r) => !r.enabled },
  ];
  /** 켜고 끄기 — 그 행의 지역 desk 로 쓴다(합산). 아니면 셸의 desk. */
  const toggle = (r: AggRow): void => {
    const d = agg.on ? agg.entry(r.region)?.desk : desk;
    const m = d === undefined ? undefined : itemOf(d.model, 'listener', r.key);
    if (d === undefined || m === undefined) return;
    const { key: _k, ...body } = m;
    void d.putResource('listener', r.key, { ...body, enabled: m['enabled'] === false }).then(after());
  };
  const menu = (r: AggRow): MenuItem[] => [
    { label: '상세 페이지 열기', href: at(r, resourcePath('listener', r.key)) },
    ...(rowRo(r) ? [] : [
      { label: '수정', href: at(r, resourcePath('listener', r.key, 'settings')) },
      { label: r.enabled ? '비활성화' : '활성화', onselect: () => toggle(r) },
      { label: '삭제…', danger: true, onselect: () => { del = { kind: 'listener', key: r.key, region: r.region }; } },
    ]),
  ];
  // 합산이면 만들기는 지역을 먼저 고른다(RegionCreate). 쓸 지역이 하나도 없으면 안 보인다.
  usePageActions(() => (agg.on ? (agg.entries.some((e) => e.writable) ? createIn : undefined) : ro ? undefined : create));
  const delEntry = $derived(del === undefined || !agg.on ? undefined : agg.entry(del.region));
</script>

{#snippet create()}
  <Button href="/traffic/listener/new/quick">빠른 프록시 만들기</Button>
  <Button variant="primary" href="/traffic/listener/new">＋ 만들기</Button>
{/snippet}

{#snippet createIn()}
  <RegionCreate {agg} href="/traffic/listener/new/quick" label="빠른 프록시 만들기" variant="secondary" />
  <RegionCreate {agg} href="/traffic/listener/new" />
{/snippet}

{#snippet table()}
{#if agg.on}<RegionNotices notices={agg.notices} />{:else}<WriteNote spaced />{/if}
<DataTable label="리스너 목록" {rows} rowKey={(r) => r.rid} columns={shownColumns} {chips} {...(agg.on ? agg.listState : listState(desk))} bind:selected
  search={{ placeholder: '이름·주소로 찾기', match: (r, q) => `${r.key} ${r.bind} ${r.protocol} ${r.action} ${r.hosts} ${r.redirect ?? ''}${agg.on ? ` ${r.region}` : ''}`.toLowerCase().includes(q) }}
  emptyTitle="리스너가 없어요" emptyBody="포트를 열면 트래픽을 받아요. 패스스루는 인증서를 제시하지 않아요."
  onopen={(r) => { void goto(at(r, resourcePath('listener', r.key))); }} rowMenu={menu}>
  {#snippet cell(r, c)}
    {#if c.key === 'key'}
      <a href={at(r, resourcePath('listener', r.key))}>{r.key}</a>{#if agg.on}{@const e = agg.entry(r.region)}{#if e !== undefined}<InRegion entry={e}><PendingMark kind="listener" key={r.key} hide={r.mark === 'join'} /></InRegion>{/if}{:else}<PendingMark kind="listener" key={r.key} hide={r.mark === 'join'} />{/if}
    {:else if c.key === 'region'}{r.region}
    {:else if c.key === 'protocol'}{r.protocol.toUpperCase().replace('TLS_PASSTHROUGH', 'TLS 패스스루')}
    {:else if c.key === 'bind'}{r.bind}{#if r.redirect !== undefined}<span class="muted" title="HTTP 로 오면 HTTPS 로 301"> · HTTP :{r.redirect} → HTTPS</span>{/if}
    {:else if c.key === 'hosts'}{#if r.hosts === '기본'}<span class="muted">기본</span>{:else}{r.hosts}{/if}
    {:else if c.key === 'routes'}{r.routes}
    {:else if c.key === 'allow'}{#if r.allow.on}<Badge tone="warn" icon="⊘">{r.allow.text}</Badge>{:else}<span class="muted">제한 없음</span>{/if}
    {:else if c.key === 'mark'}
      {@const lm = LISTENER_MARK[r.mark]}<Badge tone={lm.tone} icon={lm.icon}>{lm.text}</Badge>
    {:else if c.key === 'enabled'}{#if r.enabled}<span class="on">● 켜짐</span>{:else}<span class="muted">○ 꺼짐</span>{/if}
    {:else}{#if r.action === '거절'}<span class="muted">거절</span>{:else}{r.action}{/if}{/if}
  {/snippet}
</DataTable>
{/snippet}

<ListSplit kind="listener" bind:selected {table} />
{#if delEntry !== undefined}
  <!-- 합산: 삭제 확인과 쓰기가 그 행의 지역을 본다(관계 · 커밋 모두 그 지역). -->
  {#key delEntry.name}<InRegion entry={delEntry}><DeleteConfirm bind:target={del} /></InRegion>{/key}
{:else}
  <DeleteConfirm bind:target={del} />
{/if}

<style>
  .muted { color: var(--tx3); }
  .on { color: var(--tx2); }
</style>
