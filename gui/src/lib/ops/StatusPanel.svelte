<script lang="ts">
  /**
   * 상태 — head · 리더 · 게시 · 미완 전환 · 엔진 · 드라이버 (`/api/v1/status` 의 4-way). 시안 「상태」 대로 카드 여섯 장,
   * 클러스터면 「클러스터 화면에서 노드별 상태 보기 →」, 전역이면 「지역별 상태」 표다.
   * 미완 전환이 있으면 위에 배너를 띄우고 「이어받기」 를 둔다(시안에는 미완 전환이 없다 — 있을 때만 보인다).
   * 전역에서 지역을 골랐으면(좁혀 보기) 지역 요약(`/api/v1/regions`)으로 지역별 표를 그린다.
   *
   * **전체 합산**(전역에서 지역을 안 골랐다, 2026-11-04 · §2.5)이면 카드는 지역을 합친 값이고, 지역별 표는 지역마다 붙은
   * desk(`useAggregate`)의 상태 스냅샷으로 한 줄씩이다. 붙지 않은 지역은 값을 「—」 로 두고 엔진 칸에 「연락 없음」 등을
   * 배지로 쓴다 — 값을 지어내지 않는다(§2.4). 미완 전환의 이어받기는 그 지역의 desk 로 보낸다(한 번에 한 지역, §1.1).
   */
  import { getContext } from 'svelte';
  import { viewOfStatus, type StatusFact } from '@web/status-view';
  import { Badge, Banner, Button, DataTable, FieldMessage, Skeleton, type Column, type Tone } from '#lib/ui';
  import { LOST_LABEL, type RegionSummary, type Scope } from '#lib/global/scope.svelte.ts';
  import { useAggregate } from '#lib/global/use-aggregate.svelte.ts';
  import type { RegionEntry } from '#lib/global/regions.svelte.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { loadRegions } from './fetch';
  import { nodeState, type ClusterBody } from './cluster';
  import { regionBadge } from './aggregate-view';

  type Desk = ReturnType<typeof createDesk>;
  type StatCard = { label: string; value: string; sub: string; badge?: { tone: Tone; text: string } };
  const desk = getContext<Desk>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const ro = $derived(scope?.readOnly === true);
  const agg = useAggregate();
  /** 전역에서 지역 하나로 좁혀 본다. 전체 합산(`agg.on`)은 아니다. */
  const global = $derived(scope?.mode === 'global' && !agg.on);
  const v = $derived(desk.status);

  /** 클러스터면 노드별 상태 화면으로 가는 길을 보인다. 전역은 지역마다 다르므로 묻지 않는다. */
  let cluster = $state<ClusterBody | undefined>();
  $effect(() => {
    void desk.status;
    if (!desk.live || global) return;
    void desk.clusterNodes().then((r) => { cluster = r as ClusterBody | undefined; });
  });
  const clustered = $derived(cluster?.enabled === true);

  /**
   * 활성 리비전(시안 「활성 리비전은 r8이에요.」) — 상태 스냅샷은 그것을 따로 주지 않는다.
   * 적용 대기가 없으면 head 가 트래픽에 걸려 있다. 있으면 감사에서 마지막 적용(전체 · 멤버십)의 리비전이다.
   * 둘 다 모르면 「—」 다.
   */
  const activeOf = (d: Desk): string | undefined => {
    const s = d.status;
    if (s.pending.length === 0) return s.head;
    const last = [...d.audit.rows]
      .filter((r) => (r.action === 'apply' || r.action === 'apply.membership') && r.revision !== undefined)
      .sort((a, b) => Number(b.id) - Number(a.id))[0];
    return last?.revision;
  };
  const activeSub = (rev: string | undefined): string => (rev === undefined ? '—' : `활성 리비전은 r${rev}이에요.`);

  /**
   * 리더 카드 — 시안: 클러스터가 아니면 「클러스터 모드가 아니에요.」, 클러스터면 팔로워가 맞는지를 센다.
   * 말은 클러스터 화면과 같다(★ 리더 · 팔로워 · 맞음). 「맞음」 은 `nodeState` 가 판정한다 — 연락 없음도 맞지 않은 쪽이다.
   */
  const leaderCard = $derived.by<StatCard>(() => {
    // `leader.holder` 는 **이 인스턴스 자신의 이름**이다(src/control/leader.ts) — 팔로워에서 리더 이름으로 쓰면 자기를 리더라고 말한다.
    const value = v.leader.isLeader ? '★ 이 인스턴스' : '☆ 다른 인스턴스';
    if (global) {
      const name = scope?.region?.name;
      return {
        label: '리더', value, sub: `${name === undefined ? '' : `${name} · `}클러스터는 그 지역의 GUI 에서 봐요.`,
        badge: v.leader.isLeader ? { tone: 'ok', text: '정상' } : { tone: 'info', text: '팔로워' },
      };
    }
    if (cluster === undefined || !cluster.enabled) {
      const where = scope?.self;
      return v.leader.isLeader
        ? { label: '리더', value, sub: `${where === undefined ? '' : `${where} · `}클러스터 모드가 아니에요.`, badge: { tone: 'ok', text: '정상' } }
        : { label: '리더', value, sub: `이 인스턴스는 팔로워예요. 쓰기는 리더가 해요.${v.leader.reason ? ` ${v.leader.reason}` : ''}`, badge: { tone: 'info', text: '팔로워' } };
    }
    const followers = cluster.nodes.filter((n) => n.role === 'follower');
    const ok = followers.filter((n) => nodeState(n).tone === 'ok').length;
    const counted = `팔로워 ${followers.length}대 · ${ok}대가 맞음${followers.length > ok ? `, ${followers.length - ok}대는 확인이 필요해요.` : '.'}`;
    if (v.leader.isLeader) {
      return {
        label: '리더', value: cluster.self === undefined ? value : `★ ${cluster.self}`, sub: counted,
        badge: followers.length > ok ? { tone: 'warn', text: '팔로워 확인' } : { tone: 'ok', text: '정상' },
      };
    }
    return {
      label: '리더', value: `☆ ${cluster.leader?.name ?? '다른 인스턴스'}`,
      sub: `이 노드${cluster.self === undefined ? '' : `(${cluster.self})`}는 팔로워예요. 쓰기는 리더가 해요. ${counted}`,
      badge: followers.length > ok ? { tone: 'warn', text: '팔로워 확인' } : { tone: 'info', text: '팔로워' },
    };
  });

  const unfinishedCard = (n: number, sub: string): StatCard => ({
    label: '미완 전환', value: `${n}건`, sub: n === 0 ? '진행 중인 reload가 없어요.' : sub,
    badge: n === 0 ? { tone: 'ok', text: '없음' } : { tone: 'warn', text: '이어받기 필요' },
  });
  const DRIVER_SUB = '백엔드 목록을 외부에서 받는 플러그인이에요. 서비스 디스커버리 드라이버를 실으면 여기에 나와요.';

  const cards = $derived<StatCard[]>([
    {
      label: 'head 리비전', value: v.head === undefined ? '—' : `r${v.head}`, sub: activeSub(activeOf(desk)),
      badge: v.pending.length > 0 ? { tone: 'pending', text: `적용 대기 ${v.pending.length}건` } : { tone: 'ok', text: '적용 대기 없음' },
    },
    leaderCard,
    { label: '게시 세대', value: v.published.generation ?? '—', sub: `게시: ${v.published.kind}` },
    unfinishedCard(v.unfinished ? 1 : 0, '끝나지 않은 전환이 있어요. 복구 대상이에요.'),
    { label: '엔진', value: v.engine.label, sub: v.engine.probed ? '엔진에 물어 확인했어요.' : '엔진을 못 물었어요.' },
    { label: '드라이버', value: v.driver.loaded ? (v.driver.name ?? '실었어요') : '안 실었어요', sub: DRIVER_SUB },
  ]);

  // ── 지역별 상태 — 시안 열: 지역 · head · 리더 · 게시 세대 · 미완 전환 · 엔진. 모르는 지역은 값 「—」, 엔진 칸에 상태 배지 ──
  const dash = '—';
  type Known = { badge: { tone: Tone; text: string } | undefined; note: string | undefined };
  type RegRow = { name: string; v: ReturnType<typeof viewOfStatus> | undefined } & Known;
  let regions = $state<RegRow[] | undefined>();
  let regionsFailed = $state(false);
  const summaryState = (r: RegionSummary): Known => {
    if (!r.reachable) return { badge: { tone: 'neutral', text: LOST_LABEL }, note: undefined };
    if (r.auth === 'rejected') return { badge: { tone: 'danger', text: '인증 거절' }, note: undefined };
    return r.status === undefined ? { badge: undefined, note: r.error ?? '닿지 않아요' } : { badge: undefined, note: undefined };
  };
  $effect(() => {
    if (!global) return;
    void desk.head;
    void loadRegions(desk.token).then((rs: RegionSummary[] | undefined) => {
      regionsFailed = rs === undefined;
      regions = (rs ?? []).map((r) => ({
        name: r.name, ...summaryState(r),
        v: r.status === undefined ? undefined : viewOfStatus(r.status as StatusFact),
      }));
    });
  });
  type StatusLike = { head: string | undefined; leader: { isLeader: boolean; holder: string }; published: { generation: string | undefined }; unfinished: boolean; engine: { label: string } };
  const cols = <R extends { name: string; v: StatusLike | undefined }>(): Column<R>[] => [
    { key: 'name', label: '지역', mono: true, text: (r) => r.name },
    { key: 'head', label: 'head', mono: true, text: (r) => (r.v?.head === undefined ? dash : `r${r.v.head}`) },
    { key: 'leader', label: '리더', mono: true, text: (r) => (r.v === undefined ? dash : r.v.leader.isLeader ? r.v.leader.holder : '팔로워가 답했어요') },
    { key: 'gen', label: '게시 세대', mono: true, text: (r) => (r.v === undefined ? dash : r.v.published.generation ?? dash) },
    { key: 'unf', label: '미완 전환', mono: true, text: (r) => (r.v === undefined ? dash : r.v.unfinished ? '1' : '0') },
    { key: 'engine', label: '엔진', mono: true, text: (r) => (r.v === undefined ? dash : r.v.engine.label) },
  ];
  const regColumns = cols<RegRow>();

  // ── 전체 합산 — 지역마다 한 줄. 붙은(`ok`) 지역만 값을 쓴다 ──
  type AggRow = { name: string; entry: RegionEntry; v: Desk['status'] | undefined };
  const aggRows = $derived<AggRow[]>(agg.entries.map((e) => ({ name: e.name, entry: e, v: e.state === 'ok' ? e.desk.status : undefined })));
  const aggColumns = cols<AggRow>();
  const aggUnfinished = $derived(aggRows.filter((r) => r.v?.unfinished === true));
  const aggPending = $derived(aggRows.reduce((a, r) => a + (r.v?.pending.length ?? 0), 0));
  /** 전체 합산의 카드 — 시안 전역 상태 화면도 카드 여섯 장 아래에 지역 표를 둔다. 붙지 않은 지역은 세지 않는다(모름). */
  const aggCards = $derived.by<StatCard[]>(() => {
    const live = agg.entries.filter((e) => e.state === 'ok');
    const n = agg.entries.length;
    const leaders = live.filter((e) => e.desk.status.leader.isLeader).length;
    const engines = [...new Set(live.map((e) => e.desk.status.engine.label))];
    const gens = [...new Set(live.map((e) => e.desk.status.published.generation).filter((g): g is string => g !== undefined))];
    const drivers = [...new Set(live.filter((e) => e.desk.status.driver.loaded).map((e) => e.desk.status.driver.name ?? '실었어요'))];
    const lost = n - live.length;
    return [
      { label: 'head 리비전', value: '지역마다', sub: '지역마다 따로 커밋해요. 아래 표에서 지역별로 봐요.',
        badge: aggPending > 0 ? { tone: 'pending', text: `적용 대기 ${aggPending}건` } : { tone: 'ok', text: '적용 대기 없음' } },
      { label: '리더', value: '지역마다 1개', sub: lost > 0 ? `${live.length}곳은 리더가 답했어요. ${lost}곳은 연락이 없어요.` : `${n}곳 모두 리더가 있어요.`,
        badge: leaders === n ? { tone: 'ok', text: '정상' } : { tone: 'warn', text: '확인 필요' } },
      { label: '게시 세대', value: gens.length === 1 ? gens[0]! : gens.length === 0 ? '—' : '지역마다', sub: '세대는 지역의 엔진마다 따로 올라가요.' },
      unfinishedCard(aggUnfinished.length, aggUnfinished.map((r) => r.name).join(', ')),
      { label: '엔진', value: engines.length === 1 ? engines[0]! : engines.length === 0 ? '—' : `${engines.length}가지`, sub: engines.length > 1 ? engines.join(', ') : `지역 ${live.length}곳` },
      { label: '드라이버', value: drivers.length === 0 ? '안 실었어요' : drivers.join(', '), sub: DRIVER_SUB },
    ];
  });
</script>

{#snippet card(c: StatCard)}
  <section class="card" aria-label={c.label}>
    <span class="l">{c.label}</span>
    <span class="v">{c.value}</span>
    <span class="sub">{c.sub}</span>
    {#if c.badge}<span class="b"><Badge tone={c.badge.tone}>{c.badge.text}</Badge></span>{/if}
  </section>
{/snippet}

{#snippet aggCell(r: AggRow, c: Column<AggRow>)}
  {#if c.key === 'head'}<span class="acc">{c.text?.(r)}</span>
  {:else if c.key === 'engine' && r.v === undefined}{@const b = regionBadge(r.entry.state)}<Badge tone={b.tone}>{b.text}</Badge>
  {:else}{c.text?.(r) ?? ''}{/if}
{/snippet}

{#snippet regCell(r: RegRow, c: Column<RegRow>)}
  {#if c.key === 'head'}<span class="acc">{c.text?.(r)}</span>
  {:else if c.key === 'engine' && r.badge !== undefined}<Badge tone={r.badge.tone}>{r.badge.text}</Badge>
  {:else if c.key === 'engine' && r.note !== undefined}<span class="muted">{r.note}</span>
  {:else}{c.text?.(r) ?? ''}{/if}
{/snippet}

{#if agg.on}
  {#if agg.listState.loading}
    <Skeleton height="160px" label="지역에 연결하는 중" />
  {:else}
    <div class="st">
      {#each aggUnfinished as r (r.name)}
        <Banner tone="warn">
          {r.name} 에 끝나지 않은 전환이 있어요. 복구가 이어받아야 그 지역에서 다음 적용을 할 수 있어요.
          {#snippet action()}
            {#if agg.writable(r.name)}<Button size="sm" loading={r.entry.desk.recovering} onclick={() => { void r.entry.desk.recover(); }}>{r.entry.desk.recovering ? '이어받는 중' : `${r.name} 이어받기`}</Button>{/if}
          {/snippet}
        </Banner>
      {/each}
      <div class="cards">{#each aggCards as c (c.label)}{@render card(c)}{/each}</div>
      {#if aggPending > 0}
        <div><a class="link" href="/change/pending">적용 대기 화면에서 지역마다 영향 확인하기 →</a></div>
      {/if}
      <section class="panel" aria-label="지역별 상태">
        <div class="ph">지역별 상태</div>
        <DataTable rows={aggRows} rowKey={(r) => r.name} columns={aggColumns} cell={aggCell}
          label="지역별 상태" emptyTitle="지역이 없어요" minHeight="0" />
      </section>
    </div>
  {/if}
{:else if !desk.live}
  <Skeleton height="160px" label="연결하는 중" />
{:else}
  <div class="st">
    {#if v.unfinished}
      <Banner tone="warn">
        끝나지 않은 전환이 있어요. 복구가 이어받아야 다음 적용을 할 수 있어요.
        {#snippet action()}
          {#if !ro}<Button size="sm" loading={desk.recovering} onclick={() => { void desk.recover(); }}>{desk.recovering ? '이어받는 중' : '이어받기'}</Button>{/if}
        {/snippet}
      </Banner>
    {/if}

    <div class="cards">{#each cards as c (c.label)}{@render card(c)}{/each}</div>

    {#if clustered || v.pending.length > 0}
      <!-- 시안: 카드 아래 한 줄의 링크 버튼. 적용 대기 화면으로 가는 길도 같은 모양으로 둔다. -->
      <div class="links">
        {#if clustered}<a class="link" href="/ops/cluster">클러스터 화면에서 노드별 상태 보기 →</a>{/if}
        {#if v.pending.length > 0}<a class="link" href="/change/pending">적용 대기 화면에서 영향 확인하기 →</a>{/if}
      </div>
    {/if}

    {#if global}
      <section class="panel" aria-label="지역별 상태">
        <div class="ph">지역별 상태</div>
        {#if regionsFailed}
          <div class="pad"><FieldMessage tone="error">지역 요약을 못 읽었어요.</FieldMessage></div>
        {:else}
          <DataTable rows={regions ?? []} loading={regions === undefined} rowKey={(r) => r.name} columns={regColumns} cell={regCell}
            label="지역별 상태" emptyTitle="지역이 없어요" minHeight="0" />
        {/if}
      </section>
    {/if}
  </div>
{/if}

<style>
  /* 시안 「상태」: display:flex;flex-direction:column;gap:16px */
  .st { display: flex; flex-direction: column; gap: 16px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
  .card {
    background: var(--bg-panel); border: 1px solid var(--bd); border-radius: var(--r-lg);
    padding: 14px 16px; display: flex; flex-direction: column; gap: 6px; min-width: 0;
  }
  .l { font-size: 12px; color: var(--tx3); }
  .v { font-family: var(--mono); font-size: 22px; line-height: 30px; font-weight: 600; overflow-wrap: anywhere; }
  .sub { font-size: 12px; color: var(--tx2); }
  .b { align-self: flex-start; display: inline-flex; }
  .links { display: flex; gap: 8px; flex-wrap: wrap; }
  .link {
    display: inline-flex; align-items: center; height: 28px; padding: 0 12px; border: 1px solid var(--bd-strong);
    background: transparent; color: var(--accent); border-radius: var(--r-md); font-size: 12px; font-weight: 500; text-decoration: none;
  }
  .link:hover { background: var(--bg-hover); }
  .link:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  .panel { display: flex; flex-direction: column; background: var(--bg-panel); border: 1px solid var(--bd); border-radius: var(--r-lg); overflow: hidden; }
  .ph { padding: 10px 16px; border-bottom: 1px solid var(--bd); font-weight: 600; font-size: 14px; }
  .pad { padding: 12px 16px; }
  .acc { color: var(--accent); }
  .muted { color: var(--tx3); }
</style>
