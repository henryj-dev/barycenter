<script lang="ts">
  /**
   * 대시보드 — `/` (시안 「대시보드」). 숫자는 이미 받은 head 모델 · 헬스 · 상태 · 감사에서 센다 — 따로 묻지 않는다.
   * 전역에서 지역을 골랐으면(좁혀 보기) 지역 요약(`/api/v1/regions`)만 더 묻는다.
   *
   * 위는 상태 카드 넷(head · 리스너 · 백엔드 · 인증서), 전역이면 지역별 현황, 그 아래 패널 넷(적용 대기 · 풀별 백엔드 헬스 ·
   * 인증서 만료 · 최근 변경), 맨 아래 엔진 줄이다.
   *
   * **전체 합산**(전역에서 지역을 안 골랐다, 2026-11-04 · §2.5)이면 지역마다 붙은 desk(`useAggregate`)에서 센다.
   * 카드는 붙은 지역을 더하고, 지역별 표는 지역마다 한 줄(지역 · head · 적용 대기 · 리스너 · 백엔드 · 상태), 적용 대기는
   * 지역마다, 최근 변경은 모든 지역을 시각 순서로 잇고 지역을 단다. 연락 없는 지역은 「연락 없음」 이다 — 0 으로 세지 않는다(§2.4).
   */
  import { getContext } from 'svelte';
  import { itemsOf } from '@web/resources';
  import { viewOfStatus, type StatusFact } from '@web/status-view';
  import { Badge, Banner, Button, Skeleton, type Column, type Tone } from '#lib/ui';
  import { LOST_LABEL, type RegionSummary, type Scope } from '#lib/global/scope.svelte.ts';
  import { useAggregate } from '#lib/global/use-aggregate.svelte.ts';
  import RegionNotices from '#lib/global/RegionNotices.svelte';
  import { rowId, type RegionState } from '#lib/global/aggregate.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { clockText, groupAudit, type ChangeGroup } from './audit';
  import { titleOf, want } from './change-titles.svelte';
  import { loadRegions } from './fetch';
  import { nodeState, type ClusterBody } from './cluster';
  import { certOrder, mergeByTime, regionBadge, sumTally, tallyNotices, type Tally } from './aggregate-view';

  type Desk = ReturnType<typeof createDesk>;
  const desk = getContext<Desk>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const agg = useAggregate();
  /** 전역에서 지역 하나로 좁혀 본다. 전체 합산(`agg.on`)은 아니다. */
  const global = $derived(scope?.mode === 'global' && !agg.on);
  const st = $derived(desk.status);

  // ── 숫자 — desk 하나에서 센다(이 인스턴스 · 좁혀 본 지역 · 합산의 지역 하나) ──
  const drainingIn = (d: Desk, k: string): boolean => d.traffic.get(k)?.reasons.includes('draining') === true;
  const tallyOf = (d: Desk): Tally => {
    const keys = itemsOf(d.model, 'backend').map((b) => String(b['key']));
    const healthOf = (k: string): string | undefined => d.health.find((h) => h.backendKey === k)?.state;
    const soon = d.certs.rows.filter((c) => !c.hasMaterial || (c.expiresInDays !== undefined && c.expiresInDays < 30));
    const near = [...soon].sort((a, b) => certOrder({ hasMaterial: a.hasMaterial, days: a.expiresInDays }) - certOrder({ hasMaterial: b.hasMaterial, days: b.expiresInDays }))[0];
    return {
      listeners: d.listeners.rows.length,
      serving: d.listeners.rows.filter((r) => r.mark === 'stay').length,
      joining: d.listeners.rows.filter((r) => r.mark === 'join').length,
      backends: keys.length,
      healthy: keys.filter((k) => healthOf(k) === 'healthy' && !drainingIn(d, k)).length,
      unhealthy: keys.filter((k) => healthOf(k) === 'unhealthy').length,
      drained: keys.filter((k) => drainingIn(d, k)).length,
      idle: keys.filter((k) => d.traffic.get(k)?.receivingTraffic === false && healthOf(k) !== 'unhealthy' && !drainingIn(d, k)).length,
      certSoon: soon.length,
      ...(near === undefined ? {} : { nearest: { key: near.key, hasMaterial: near.hasMaterial, ...(near.expiresInDays === undefined ? {} : { days: near.expiresInDays }) } }),
      pending: d.status.pending.length,
      unfinished: d.status.unfinished,
    };
  };
  const local = $derived(tallyOf(desk));

  // ── 전체 합산 — 붙은 지역마다 숫자 · 감사 묶음 ──
  type Part = { name: string; desk: Desk; tally: Tally; groups: ChangeGroup[] };
  const parts = $derived<Part[]>(agg.entries.filter((e) => e.state === 'ok').map((e) => ({
    name: e.name, desk: e.desk, tally: tallyOf(e.desk),
    groups: groupAudit(e.desk.audit.rows, e.desk.status.pending.map((p) => p.revision)),
  })));
  const total = $derived(sumTally(parts.map((p) => ({ region: p.name, tally: p.tally }))));
  const notices = $derived(tallyNotices(agg.entries.map((e) => ({ name: e.name, state: e.state }))));
  const t = $derived<Tally>(agg.on ? total : local);

  /** 클러스터면 head 카드에 「N대 중 M대 맞음」 을 붙인다(시안). 전역은 지역마다 다르므로 묻지 않는다. */
  let cluster = $state<ClusterBody | undefined>();
  $effect(() => {
    void desk.status;
    if (!desk.live || global) return;
    void desk.clusterNodes().then((r) => { cluster = r as ClusterBody | undefined; });
  });
  const clusterText = $derived(cluster?.enabled === true && cluster.nodes.length > 1
    ? ` · ${cluster.nodes.length}대 중 ${cluster.nodes.filter((n) => nodeState(n).tone === 'ok').length}대 맞음` : '');

  type Stat = { href: string; label: string; value: string; tone: Tone; text: string };
  const nearText = (n: NonNullable<Tally['nearest']>): string => `${n.region === undefined ? '' : `${n.region} · `}${n.key}`;
  const stats = $derived<Stat[]>([
    agg.on || global
      ? {
        // 전역 — head 는 지역마다 다르다(시안 「지역마다」). 적용 대기는 지역을 합쳐 센다.
        href: '/change/pending', label: 'head 리비전', value: '지역마다',
        ...((agg.on ? total.pending : regionPending) > 0 ? { tone: 'pending' as const, text: `적용 대기 ${agg.on ? total.pending : regionPending}건` } : { tone: 'ok' as const, text: '적용 대기 없음' }),
      }
      : {
        href: '/change/pending', label: 'head 리비전', value: desk.head === undefined ? '—' : `r${desk.head}`,
        ...(st.pending.length > 0 ? { tone: 'pending' as const, text: `적용 대기 ${st.pending.length}건${clusterText}` } : { tone: 'ok' as const, text: `트래픽에 걸려 있어요${clusterText}` }),
      },
    {
      href: '/traffic/listener', label: '리스너 상태', value: `${t.serving} / ${t.listeners}`,
      ...(t.joining > 0 ? { tone: 'pending' as const, text: `${t.joining}개 적용하면 열림` } : { tone: 'ok' as const, text: '모두 서빙 중' }),
    },
    {
      href: '/traffic/backend', label: '백엔드 상태', value: `${t.healthy} / ${t.backends}`,
      ...(t.unhealthy + t.drained + t.idle > 0
        ? {
          tone: (t.unhealthy > 0 ? 'danger' : 'warn') as Tone,
          text: [t.unhealthy > 0 ? `비정상 ${t.unhealthy}` : '', t.drained > 0 ? `⇣ 드레인 ${t.drained}` : '', t.idle > 0 ? `트래픽 없음 ${t.idle}` : '']
            .filter(Boolean).join(' · '),
        }
        : { tone: 'ok' as const, text: '모두 정상' }),
    },
    {
      href: '/tls/certificate', label: '인증서 만료 임박', value: String(t.certSoon),
      ...(t.nearest === undefined ? { tone: 'ok' as const, text: '30일 안에 만료되는 것이 없어요' }
        : !t.nearest.hasMaterial ? { tone: 'danger' as const, text: `${nearText(t.nearest)} 자료 없음` }
        : (t.nearest.days ?? 0) < 0 ? { tone: 'danger' as const, text: `${nearText(t.nearest)} 만료됨` }
        // 전역은 시안대로 「가장 가까운 N일」 — 어느 것인지는 아래 인증서 만료 패널이 지역과 함께 쓴다.
        : { tone: 'warn' as const, text: agg.on || global ? `가장 가까운 ${t.nearest.days}일` : `${nearText(t.nearest)} ${t.nearest.days}일` }),
    },
  ]);

  // ── 지역별 현황 (전역 · 좁혀 보기) — 지역 요약으로 ──
  let regions = $state<RegionSummary[] | undefined>();
  $effect(() => {
    if (!global) return;
    void desk.head;
    void loadRegions(desk.token).then((r) => { regions = r ?? []; });
  });
  const regionState = (r: RegionSummary): { tone: Tone; text: string } => {
    if (!r.reachable) return { tone: 'neutral', text: LOST_LABEL };
    if (r.auth === 'rejected') return { tone: 'danger', text: '인증 거절' };
    if (r.status === undefined) return { tone: 'neutral', text: '모름' };
    if (r.status['unfinished'] !== undefined && r.status['unfinished'] !== null) return { tone: 'warn', text: '미완 전환' };
    return { tone: 'ok', text: '정상' };
  };
  const pendingOf = (r: RegionSummary): number | undefined =>
    (Array.isArray(r.status?.['pendingApply']) ? (r.status['pendingApply'] as unknown[]).length : undefined);
  /** 전역 합산 — 지역 요약의 `status` 로 센다. 닿지 않는 지역은 세지 않는다(모름). */
  const regionViews = $derived((regions ?? []).map((r) => ({ r, v: r.status === undefined ? undefined : viewOfStatus(r.status as StatusFact) })));
  const regionPending = $derived(regionViews.reduce((a, x) => a + (x.v?.pending.length ?? 0), 0));
  const regionUnfinished = $derived(regionViews.filter((x) => x.v?.unfinished === true).length);
  const regionEngines = $derived([...new Set(regionViews.map((x) => x.v?.engine.label).filter((e): e is string => e !== undefined))].join(', '));
  const regionsWithLeader = $derived(regionViews.filter((x) => x.v !== undefined).length);
  const regionColumns: Column<RegionSummary>[] = [
    { key: 'name', label: '지역', mono: true, sort: (r) => r.name, text: (r) => r.name },
    { key: 'head', label: 'head', mono: true, width: '100px', text: (r) => (r.status?.head === undefined ? '—' : `r${r.status.head}`) },
    { key: 'pend', label: '적용 대기', width: '120px', text: (r) => { const n = pendingOf(r); return n === undefined ? '—' : `${n}건`; } },
    // 지역 요약에는 백엔드 헬스가 없다 — 지어내지 않는다.
    { key: 'be', label: '백엔드 정상', mono: true, text: () => '—' },
    { key: 'state', label: '상태', sort: (r) => regionState(r).text },
  ];

  // ── 지역별 현황 (전체 합산) — 지역마다 붙은 desk 로. 붙지 않은 지역은 숫자 없이 「연락 없음」 ──
  type AggRegion = { name: string; state: RegionState; head: string | undefined; tally: Tally | undefined };
  const aggRegions = $derived<AggRegion[]>(agg.entries.map((e) => ({
    name: e.name, state: e.state,
    head: e.state === 'ok' ? e.desk.head : undefined,
    tally: parts.find((p) => p.name === e.name)?.tally,
  })));
  const aggState = (r: AggRegion): { tone: Tone; text: string } => {
    if (r.tally === undefined) { const b = regionBadge(r.state === 'ok' ? 'loading' : r.state); return { tone: b.tone, text: b.text }; }
    if (r.tally.unfinished) return { tone: 'warn', text: '미완 전환' };
    if (r.tally.unhealthy > 0) return { tone: 'danger', text: `비정상 ${r.tally.unhealthy}` };
    return { tone: 'ok', text: '정상' };
  };
  const aggColumns: Column<AggRegion>[] = [
    { key: 'name', label: '지역', mono: true, sort: (r) => r.name, text: (r) => r.name },
    { key: 'head', label: 'head', mono: true, width: '100px', text: (r) => (r.head === undefined ? '—' : `r${r.head}`) },
    { key: 'pend', label: '적용 대기', width: '110px', text: (r) => (r.tally === undefined ? '—' : `${r.tally.pending}건`) },
    { key: 'be', label: '백엔드 정상', mono: true, width: '130px', text: (r) => (r.tally === undefined ? '—' : `${r.tally.healthy} / ${r.tally.backends}`) },
    { key: 'state', label: '상태', sort: (r) => aggState(r).text },
  ];

  /** 지역별 현황 표 한 벌 — 열 정의(`aggColumns` · `regionColumns`)를 시안의 평문 칸으로 편다. */
  type RegionTable = {
    head: string[]; note?: string;
    rows: { key: string; cells: { text: string; mono: boolean; name: boolean; pend: boolean; badge?: { tone: Tone; text: string } }[] }[];
  };
  const tableOf = <R extends { name: string }>(rows: readonly R[], cols: readonly Column<R>[], state: (r: R) => { tone: Tone; text: string }, pend: (r: R) => boolean, loading = false): RegionTable => ({
    head: cols.map((c) => c.label),
    ...(loading ? { note: '지역 요약을 읽는 중이에요.' } : rows.length === 0 ? { note: '지역이 없어요.' } : {}),
    rows: rows.map((r) => ({
      key: r.name,
      cells: cols.map((c) => (c.key === 'state'
        ? { text: '', mono: false, name: false, pend: false, badge: state(r) }
        : { text: c.text?.(r) ?? '', mono: c.mono === true, name: c.key === 'name', pend: c.key === 'pend' && pend(r) })),
    })),
  });

  // ── 패널 ──
  const groups = $derived(groupAudit(desk.audit.rows, st.pending.map((p) => p.revision)));
  type Recent = ChangeGroup & { region: string; rid: string };
  /** 최근 변경은 리비전이 생긴 변경만(시안: 줄마다 rN). 커밋 안 한 · 버린 changeset 은 기록 화면에만 있다. */
  const committed = (g: ChangeGroup): boolean => g.change && g.revision !== undefined;
  const recent = $derived<Recent[]>(agg.on
    ? mergeByTime(parts.map((p) => ({ region: p.name, rows: p.groups.filter(committed) })), (g) => g.key, (g) => g.at).slice(0, 4)
    : groups.filter(committed).slice(0, 4).map((g) => ({ ...g, region: '', rid: g.key })));
  /** 최근 변경의 설명(시안 `백엔드 demo-2 추가`) — 보이는 넷만 읽는다. 못 읽으면 「설정 변경」 그대로다. 합산이면 그 지역 desk 로. */
  const recentSrc = (g: Recent): Desk | undefined => (agg.on ? parts.find((p) => p.name === g.region)?.desk : desk);
  $effect(() => {
    for (const g of recent) {
      const src = recentSrc(g);
      if (src !== undefined && g.changeset !== undefined) want(src, g.changeset.id, g.changeset.ver);
    }
  });
  const recentTitle = (g: Recent): string => {
    const src = recentSrc(g);
    return (src === undefined ? undefined : titleOf(src, g.changeset?.id))?.title ?? g.title;
  };
  const whoIn = (gs: readonly ChangeGroup[], rev: string): string | undefined => gs.find((g) => g.change && g.revision === rev)?.who;
  const revsOf = (d: Desk): string[] => d.status.pending.map((p) => p.revision).sort((a, b) => Number(a) - Number(b));
  const whoOfRevs = (gs: readonly ChangeGroup[], revs: readonly string[]): string =>
    [...new Set(revs.map((r) => whoIn(gs, r)).filter((w): w is string => w !== undefined))].join(', ');
  const pendingRevs = $derived(revsOf(desk));
  const pendingWho = $derived(whoOfRevs(groups, pendingRevs));
  /** 전체 합산의 적용 대기 — 지역마다 한 줄. 적용 대기가 있는 지역과, 모르는 지역(연락 없음 · 인증 거절 · 불러오는 중). */
  type AggPlan = { name: string; badge: ReturnType<typeof regionBadge> | undefined; plan: { revision: string; revs: string[]; who: string; headline: string; reload: boolean } | undefined };
  const aggPlans = $derived(agg.entries.flatMap((e): AggPlan[] => {
    if (e.state !== 'ok') return [{ name: e.name, badge: regionBadge(e.state), plan: undefined }];
    const v = e.desk.view;
    if (v === undefined) return [];
    const p = parts.find((x) => x.name === e.name);
    const revs = revsOf(e.desk);
    return [{ name: e.name, badge: undefined, plan: { revision: v.revision, revs, who: whoOfRevs(p?.groups ?? [], revs), headline: v.headline, reload: v.requiresReload } }];
  }));
  const aggHasPlan = $derived(aggPlans.some((p) => p.plan !== undefined));

  type PoolLine = { rid: string; key: string; href: string | undefined; segs: readonly (readonly [string, number])[]; total: number; text: string };
  const poolCounts = (d: Desk) => d.pools.rows.map((p) => {
    const keys = p.backends.map((b) => b.key);
    const dr = keys.filter((k) => drainingIn(d, k)).length;
    const ok = p.backends.filter((b) => b.state === 'healthy' && !drainingIn(d, b.key)).length;
    const bad = p.backends.filter((b) => b.state === 'unhealthy' && !drainingIn(d, b.key)).length;
    return { key: p.key, ok, dr, bad, unk: p.backends.length - ok - bad - dr, n: p.backends.length };
  });
  const poolLine = (c: { key: string; ok: number; dr: number; bad: number; unk: number; n: number }, rid: string, href: string | undefined): PoolLine => ({
    rid, key: c.key, href, total: c.n || 1,
    segs: [['ok', c.ok], ['drain', c.dr], ['danger', c.bad], ['neutral', c.unk]] as const,
    text: c.n === 0 ? '백엔드가 없어요'
      : [[`● 정상`, c.ok], [`⇣ 드레인`, c.dr], [`✕ 비정상`, c.bad], [`○ 관측 없음`, c.unk]].filter((x) => (x[1] as number) > 0).map((x) => `${x[0]} ${x[1]}`).join(' · '),
  });
  /**
   * 풀 — 합산이면 같은 이름의 풀을 지역을 넘어 더한다(시안). 한 지역에만 있으면 그 지역으로 좁혀 연다.
   * 여러 지역에 있으면 링크를 달지 않는다 — 어느 지역인지 모른 채 하나를 고르지 않는다.
   */
  const pools = $derived<PoolLine[]>(agg.on
    ? (() => {
      const by = new Map<string, { key: string; ok: number; dr: number; bad: number; unk: number; n: number; regions: string[] }>();
      for (const p of parts) for (const c of poolCounts(p.desk)) {
        const m = by.get(c.key) ?? { key: c.key, ok: 0, dr: 0, bad: 0, unk: 0, n: 0, regions: [] };
        by.set(c.key, { ...m, ok: m.ok + c.ok, dr: m.dr + c.dr, bad: m.bad + c.bad, unk: m.unk + c.unk, n: m.n + c.n, regions: [...m.regions, p.name] });
      }
      return [...by.values()].map((m) => poolLine(m, m.key, m.regions.length === 1 ? agg.href(m.regions[0]!, `/traffic/pool/${encodeURIComponent(m.key)}`) : undefined));
    })()
    : poolCounts(desk).map((c) => poolLine(c, c.key, `/traffic/pool/${encodeURIComponent(c.key)}`)));
  const liveRegions = $derived(agg.entries.filter((e) => e.state === 'ok').length);

  type CertRow = Desk['certs']['rows'][number];
  const certTone = (c: CertRow): { tone: Tone; text: string } =>
    !c.hasMaterial ? { tone: 'danger', text: '자료 없음' }
    : (c.expiresInDays ?? 0) < 0 ? { tone: 'danger', text: '만료됨' }
    : (c.expiresInDays ?? 0) < 30 ? { tone: 'warn', text: `${c.expiresInDays}일 남음` }
    : { tone: 'ok', text: `${c.expiresInDays}일 남음` };
  const byExpiry = (a: CertRow, b: CertRow): number =>
    certOrder({ hasMaterial: a.hasMaterial, days: a.expiresInDays }) - certOrder({ hasMaterial: b.hasMaterial, days: b.expiresInDays });
  const certs = $derived((agg.on
    ? parts.flatMap((p) => p.desk.certs.rows.map((c) => ({ c, region: p.name, rid: rowId(p.name, c.key), href: agg.href(p.name, `/tls/certificate/${encodeURIComponent(c.key)}`) })))
    : desk.certs.rows.map((c) => ({ c, region: '', rid: c.key, href: `/tls/certificate/${encodeURIComponent(c.key)}` })))
    .sort((a, b) => byExpiry(a.c, b.c))
    .slice(0, 5));

  const aggLeaders = $derived(parts.filter((p) => p.desk.status.leader.isLeader).length);
  const engine = $derived(agg.on ? [
    { label: '지역', value: `${agg.entries.length}곳` },
    { label: '엔진', value: [...new Set(parts.map((p) => p.desk.status.engine.label))].join(', ') || '—' },
    { label: '미완 전환', value: `${total.unfinishedIn.length}건` },
    { label: '리더', value: agg.entries.length > 0 && aggLeaders === agg.entries.length ? '지역마다 1개' : `${aggLeaders}곳에 있어요` },
  ] : global ? [
    { label: '지역', value: regions === undefined ? '—' : `${regions.length}곳` },
    { label: '엔진', value: regionEngines === '' ? '—' : regionEngines },
    { label: '미완 전환', value: `${regionUnfinished}건` },
    { label: '리더', value: regions !== undefined && regionsWithLeader === regions.length ? '지역마다 1개' : `${regionsWithLeader}곳에 있어요` },
  ] : [
    { label: '리더', value: st.leader.isLeader ? '★ 이 인스턴스' : `☆ ${cluster?.leader?.name ?? '다른 인스턴스'}` },
    { label: '게시 세대', value: st.published.generation ?? '—' },
    { label: '미완 전환', value: st.unfinished ? '1건' : '0건' },
    { label: '엔진', value: st.engine.label },
  ]);
  /** 합산이면 붙은 지역이 하나도 없고 오는 중인 지역이 있을 때만 뼈대다. 모두 빠졌으면 지역별 표가 「연락 없음」 을 말한다. */
  const waiting = $derived(agg.on ? agg.listState.loading : !desk.live);
  /** 실시간 연결 표시(시안 `connMap`) — 수신 중 · 재연결 중 · 끊김. 합산이면 붙은 지역이 모두 붙어야 수신 중이다. */
  const conn = $derived<'ok' | 'reconn' | 'down'>(agg.on
    ? (liveRegions > 0 && liveRegions === agg.entries.length ? 'ok' : liveRegions > 0 ? 'reconn' : 'down')
    : desk.live ? 'ok' : desk.retrying ? 'reconn' : 'down');
  const connText = $derived(agg.on && conn !== 'ok' && liveRegions > 0 ? `실시간 수신 중 · ${liveRegions} / ${agg.entries.length} 지역`
    : { ok: '실시간 수신 중', reconn: '재연결 중', down: '끊김' }[conn]);
</script>

{#snippet regionTable(tbl: RegionTable)}
  <!-- 시안 `regionRows`: 패널 머리 · 32px 머리 줄 · 1.4fr .8fr .8fr 1fr 1fr · 행 --row-h. 칸은 평문이다. -->
  <section class="panel" aria-labelledby="dash-regions">
    <div class="ph" id="dash-regions">지역별 현황</div>
    <div role="table" aria-labelledby="dash-regions">
      <div class="rgh" role="row">{#each tbl.head as h (h)}<span role="columnheader">{h}</span>{/each}</div>
      {#if tbl.note !== undefined}<div class="rgr" role="row"><span role="cell" class="muted">{tbl.note}</span></div>{/if}
      {#each tbl.rows as r (r.key)}
        <div class="rgr" role="row">
          {#each r.cells as c, i (i)}
            {#if c.badge !== undefined}<span role="cell"><Badge tone={c.badge.tone}>{c.badge.text}</Badge></span>
            {:else}<span role="cell" class:name={c.name} class:mono={c.mono} class:pend={c.pend}>{c.text}</span>{/if}
          {/each}
        </div>
      {/each}
    </div>
  </section>
{/snippet}

{#if waiting}
  <Skeleton height="200px" label="연결하는 중" />
{:else}
  <div class="dash">
    {#if agg.on}
      <RegionNotices {notices} strip={false} />
      {#each total.unfinishedIn as name (name)}
        <Banner tone="warn">
          {name} 에 끝나지 않은 전환이 있어요. 복구가 이어받아야 그 지역에서 다음 적용을 할 수 있어요.
          {#snippet action()}<Button size="sm" href={agg.href(name, '/ops/status')}>{name} 상태 화면에서 이어받기</Button>{/snippet}
        </Banner>
      {/each}
    {:else if st.unfinished}
      <Banner tone="warn">
        끝나지 않은 전환이 있어요. 복구가 이어받아야 다음 적용을 할 수 있어요.
        {#snippet action()}<Button size="sm" href="/ops/status">상태 화면에서 이어받기</Button>{/snippet}
      </Banner>
    {/if}

    <div class="stats">
      {#each stats as s (s.href)}
        <a class="stat" href={s.href}>
          <span class="l">{s.label}</span>
          <span class="n">{s.value}</span>
          <span class="b"><Badge tone={s.tone}>{s.text}</Badge></span>
        </a>
      {/each}
    </div>

    {#if agg.on}
      {@render regionTable(tableOf(aggRegions, aggColumns, aggState, (r) => r.tally !== undefined))}
    {:else if global}
      {@render regionTable(tableOf(regions ?? [], regionColumns, regionState, (r) => pendingOf(r) !== undefined, regions === undefined))}
    {/if}

    <div class="panels">
      <section class="panel" aria-labelledby="dash-plans">
        <div class="phx"><span class="pt" id="dash-plans">적용 대기</span><a class="go-pend" href="/change/pending">영향 확인</a></div>
        {#if agg.on}
          <!-- 전체 합산 — 적용 대기가 있는 지역마다 한 줄(시안 `plans`), 모르는 지역은 「연락 없음」 등으로. -->
          {#if aggPlans.length === 0}
            <div class="empty">적용 대기가 없어요. 지역마다 head 가 트래픽에 걸려 있어요.</div>
          {:else}
            {#each aggPlans as p (p.name)}
              {#if p.plan !== undefined}
                <div class="plan">
                  <span class="rev">r{p.plan.revision}</span>
                  <div class="grow">
                    <div>적용 — 커밋 {p.plan.revs.length}건 포함{p.plan.revs.length > 0 ? ` (${p.plan.revs.map((r) => `r${r}`).join(', ')})` : ''}</div>
                    <div class="cap">{p.plan.who !== '' ? `${p.plan.who} · ` : ''}{p.name}</div>
                  </div>
                  {#if p.plan.reload}<Badge tone="warn">reload 필요</Badge>{:else}<Badge tone="ok">세대 전환 불필요</Badge>{/if}
                </div>
              {:else if p.badge !== undefined}
                <div class="plan">
                  <span class="rev">—</span>
                  <div class="grow"><div class="muted">지금 값을 몰라요.</div><div class="cap">{p.name}</div></div>
                  <Badge tone={p.badge.tone}>{p.badge.text}</Badge>
                </div>
              {/if}
            {/each}
          {/if}
        {:else if global}
          <!-- 좁혀 보기 — 지역 요약으로 지역마다 한 줄(시안 `plans`). 커밋한 사람 · reload 여부는 요약에 없다 — 적용 대기 화면에서 본다. -->
          {#if regions === undefined}
            <div class="empty">지역 요약을 읽는 중이에요.</div>
          {:else if regionViews.every(({ v }) => v !== undefined && v.pending.length === 0)}
            <div class="empty">적용 대기가 없어요. 지역마다 head 가 트래픽에 걸려 있어요.</div>
          {:else}
            {#each regionViews as { r, v } (r.name)}
              {#if v === undefined}
                <div class="plan">
                  <span class="rev">—</span>
                  <div class="grow"><div class="muted">지금 값을 몰라요.</div><div class="cap">{r.name}</div></div>
                  <Badge tone={regionState(r).tone}>{regionState(r).text}</Badge>
                </div>
              {:else if v.pending.length > 0}
                {@const revs = v.pending.map((p) => p.revision).sort((a, b) => Number(a) - Number(b))}
                <div class="plan">
                  <span class="rev">{v.head === undefined ? '—' : `r${v.head}`}</span>
                  <div class="grow">
                    <div>적용 — 커밋 {revs.length}건 포함 ({revs.map((x) => `r${x}`).join(', ')})</div>
                    <div class="cap">{r.name}</div>
                  </div>
                  <Badge tone="pending">적용 대기</Badge>
                </div>
              {/if}
            {/each}
          {/if}
        {:else if desk.view === undefined}
          <div class="empty">적용 대기가 없어요. head{desk.head === undefined ? '' : ` r${desk.head}`} 가 트래픽에 걸려 있어요.</div>
        {:else}
          <div class="plan">
            <span class="rev">r{desk.view.revision}</span>
            <div class="grow">
              <div>적용 — 커밋 {pendingRevs.length}건 포함{pendingRevs.length > 0 ? ` (${pendingRevs.map((r) => `r${r}`).join(', ')})` : ''}</div>
              <div class="cap">{pendingWho !== '' ? `${pendingWho} · ` : ''}이 인스턴스</div>
            </div>
            {#if desk.view.requiresReload}<Badge tone="warn">reload 필요</Badge>{:else}<Badge tone="ok">세대 전환 불필요</Badge>{/if}
          </div>
        {/if}
      </section>

      <section class="panel" aria-labelledby="dash-pools">
        <!-- 헬스는 실시간 스트림으로 온다 — 그 연결 상태를 머리에 둔다(시안 `connName`). 합산이면 붙은 지역 수. -->
        <div class="phx"><span class="pt" id="dash-pools">풀별 백엔드 헬스</span><span class="conn" data-conn={conn} role="status"><span class="dot" aria-hidden="true"></span>{connText}</span></div>
        {#if pools.length === 0}
          <div class="empty">풀이 없어요.</div>
        {:else}
          {#each pools as p (p.rid)}
            <svelte:element this={p.href === undefined ? 'div' : 'a'} class="pool" href={p.href}>
              <span class="mono name" title={p.key}>{p.key}</span>
              <span class="hb">
                <span class="bar" aria-hidden="true">{#each p.segs as [tone, n] (tone)}<span data-tone={tone} style:width="{(n / p.total) * 100}%"></span>{/each}</span>
                <span class="ptx">{p.text}</span>
              </span>
            </svelte:element>
          {/each}
        {/if}
      </section>

      <section class="panel" aria-labelledby="dash-certs">
        <div class="phx"><span class="pt" id="dash-certs">인증서 만료</span><a class="more" href="/tls/certificate">자세히</a></div>
        {#if certs.length === 0}
          <div class="empty">인증서가 없어요.</div>
        {:else}
          {#each certs as { c, region, rid, href } (rid)}
            {@const tc = certTone(c)}
            <a class="cert" {href}>
              <span class="cn mono" title={c.key}>{c.key}{#if region !== ''} <span class="cap">· {region}</span>{/if}</span>
              <span class="cd">{c.notAfter?.slice(0, 10) ?? '—'}</span>
              <Badge tone={tc.tone}>{tc.text}</Badge>
            </a>
          {/each}
        {/if}
      </section>

      <section class="panel" aria-labelledby="dash-acts">
        <div class="phx"><span class="pt" id="dash-acts">최근 변경</span><a class="more" href="/ops/audit">자세히</a></div>
        {#if recent.length === 0}
          <div class="empty">최근 변경이 없어요.</div>
        {:else}
          {#each recent as g (g.rid)}
            <div class="act">
              <span class="at">{clockText(g.at)}</span>
              <span class="an"><b>{recentTitle(g)}</b> <span class="cap">· {g.who}{g.region !== '' ? ` · ${g.region}` : ''}</span></span>
              <span class="ar">{g.revision === undefined ? '' : `r${g.revision}`}</span>
            </div>
          {/each}
        {/if}
      </section>
    </div>

    <dl class="engine">
      {#each engine as e (e.label)}<div><dt>{e.label}</dt><dd>{e.value}</dd></div>{/each}
    </dl>
  </div>
{/if}

<style>
  /* 시안 값 그대로 — 대시보드(`dashDisp`). */
  .dash { display: flex; flex-direction: column; gap: 16px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
  .stat {
    text-align: left; display: flex; flex-direction: column; gap: 6px; padding: 14px 16px;
    background: var(--bg-panel); border: 1px solid var(--bd); border-radius: var(--r-lg);
    color: var(--tx); text-decoration: none; transition: border-color var(--dur-fast) var(--ease);
  }
  .stat:hover { border-color: var(--accent); }
  .stat:focus-visible { outline: 2px solid var(--focus); outline-offset: 0; }
  .l { font-size: 12px; color: var(--tx3); }
  .n { font-family: var(--mono); font-size: 26px; line-height: 32px; font-weight: 600; }
  .b { align-self: flex-start; }

  .panel { background: var(--bg-panel); border: 1px solid var(--bd); border-radius: var(--r-lg); overflow: hidden; min-width: 0; }
  .ph { padding: 10px 16px; border-bottom: 1px solid var(--bd); font-weight: 600; font-size: 14px; }
  .phx { display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-bottom: 1px solid var(--bd); }
  .pt { font-weight: 600; font-size: 14px; flex: 1; }
  .go-pend {
    height: 24px; padding: 0 10px; display: inline-flex; align-items: center; border: 1px solid var(--pending); background: transparent;
    color: var(--pending); border-radius: var(--r-sm); font-weight: 600; font-size: 12px; text-decoration: none;
  }
  .go-pend:hover { background: var(--pending-bg); }
  .more { border: 0; background: transparent; color: var(--accent); font-weight: 500; font-size: 12px; text-decoration: none; }
  .more:hover { color: var(--focus); }
  .go-pend:focus-visible, .more:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

  .rgh, .rgr { display: grid; grid-template-columns: 1.4fr .8fr .8fr 1fr 1fr; gap: 12px; padding: 0 16px; align-items: center; }
  .rgh { height: 32px; background: var(--bg-hover); font-size: 12px; font-weight: 600; color: var(--tx2); }
  .rgr { height: var(--row-h); border-top: 1px solid var(--bd); font-size: 13px; }
  .rgr > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rgr .name { font-weight: 500; }
  .pend { color: var(--pending); }

  /* 패널은 시안처럼 두 열까지 — `auto-fit, minmax(380px, 1fr)` 이 시안 폭(1400px 틀)에서 두 열이 된다. 넓은 화면에서도 두 열을 넘지 않는다. */
  .panels { display: grid; grid-template-columns: repeat(auto-fit, minmax(max(380px, calc((100% - 16px) / 2)), 1fr)); gap: 16px; align-items: start; }
  @media (max-width: 860px) { .panels { grid-template-columns: minmax(0, 1fr); } }
  .empty { padding: 10px 16px; font-size: 13px; color: var(--tx3); }
  .plan { display: flex; align-items: flex-start; gap: 10px; padding: 10px 16px; border-top: 1px solid var(--bd); font-size: 13px; }
  .plan > :global(.badge) { flex: none; }
  .rev { font-family: var(--mono); color: var(--accent); flex: none; width: 40px; }
  .grow { flex: 1; min-width: 0; }
  .cap { font-size: 12px; color: var(--tx3); }
  .muted { color: var(--tx2); }
  .mono { font-family: var(--mono); }
  b { font-weight: 500; }

  .conn { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ok); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
  .conn[data-conn='reconn'] { color: var(--warn); }
  .conn[data-conn='reconn'] .dot { animation: bc-pulse 1s infinite; }
  .conn[data-conn='down'] { color: var(--danger); }
  .conn[data-conn='down'] .dot { border-radius: 2px; }

  .pool {
    width: 100%; text-align: left; display: grid; grid-template-columns: 110px 1fr; gap: 12px; align-items: center; padding: 10px 16px;
    border-top: 1px solid var(--bd); background: transparent; color: var(--tx); font-size: 13px; text-decoration: none;
  }
  .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .hb { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .bar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; background: var(--bg-hover); }
  .bar [data-tone='ok'] { background: var(--ok); }
  .bar [data-tone='drain'] { background: var(--drain); }
  .bar [data-tone='danger'] { background: var(--danger); }
  .bar [data-tone='neutral'] { background: var(--neutral); }
  .ptx { font-size: 12px; color: var(--tx2); }

  .cert { display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-top: 1px solid var(--bd); font-size: 13px; color: var(--tx); text-decoration: none; }
  .cn { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cd { font-family: var(--mono); color: var(--tx3); font-size: 12px; }

  .act { display: grid; grid-template-columns: 64px 1fr 36px; gap: 12px; align-items: center; padding: 0 16px; height: var(--row-h); border-top: 1px solid var(--bd); font-size: 13px; }
  .at { font-family: var(--mono); font-size: 12px; color: var(--tx3); }
  .an { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .an .cap { font-size: inherit; }
  .ar { font-family: var(--mono); color: var(--accent); text-align: right; }

  a.pool:hover, a.cert:hover { background: var(--bg-hover); }
  a.pool:focus-visible, a.cert:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }

  .engine {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px 24px; margin: 0; padding: 12px 16px;
    background: var(--bg-panel); border: 1px solid var(--bd); border-radius: var(--r-lg); font-size: 13px;
  }
  .engine dt { font-size: 12px; color: var(--tx3); }
  .engine dd { margin: 0; font-family: var(--mono); overflow-wrap: anywhere; }
</style>
