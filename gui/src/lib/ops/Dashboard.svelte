<script lang="ts">
  /**
   * 대시보드 — `/` (시안 「대시보드」). 숫자는 이미 받은 head 모델 · 헬스 · 상태 · 감사에서 센다 — 따로 묻지 않는다.
   * 전역이면 지역 요약(`/api/v1/regions`)만 더 묻는다.
   *
   * 위는 상태 카드 넷(head · 리스너 · 백엔드 · 인증서), 전역이면 지역별 현황, 그 아래 패널 넷(적용 대기 · 풀별 백엔드 헬스 ·
   * 인증서 만료 · 최근 변경), 맨 아래 엔진 줄이다.
   */
  import { getContext } from 'svelte';
  import { itemsOf } from '@web/resources';
  import { viewOfStatus, type StatusFact } from '@web/status-view';
  import { Badge, Banner, Button, Card, DataTable, FieldMessage, Skeleton, type Column, type Tone } from '#lib/ui';
  import { LOST_LABEL, type RegionSummary, type Scope } from '#lib/global/scope.svelte.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { clockText, groupAudit } from './audit';
  import { loadRegions } from './fetch';
  import { nodeState, type ClusterBody } from './cluster';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const global = $derived(scope?.mode === 'global');
  const st = $derived(desk.status);

  // ── 상태 카드 ──
  const backends = $derived(itemsOf(desk.model, 'backend').map((b) => String(b['key'])));
  const healthOf = (k: string): string | undefined => desk.health.find((h) => h.backendKey === k)?.state;
  const draining = (k: string): boolean => desk.traffic.get(k)?.reasons.includes('draining') === true;
  const unhealthy = $derived(backends.filter((k) => healthOf(k) === 'unhealthy'));
  const drained = $derived(backends.filter(draining));
  const idle = $derived(backends.filter((k) => desk.traffic.get(k)?.receivingTraffic === false && healthOf(k) !== 'unhealthy' && !draining(k)));
  const healthy = $derived(backends.filter((k) => healthOf(k) === 'healthy' && !draining(k)));
  const joining = $derived(desk.listeners.rows.filter((r) => r.mark === 'join').length);
  const serving = $derived(desk.listeners.rows.filter((r) => r.mark === 'stay').length);
  const certSoon = $derived(desk.certs.rows.filter((c) => !c.hasMaterial || (c.expiresInDays !== undefined && c.expiresInDays < 30)));
  const nearest = $derived([...certSoon].sort((a, b) => (a.hasMaterial ? a.expiresInDays ?? 0 : -Infinity) - (b.hasMaterial ? b.expiresInDays ?? 0 : -Infinity))[0]);

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
  const stats = $derived<Stat[]>([
    global
      ? {
        // 전역 — head 는 지역마다 다르다(시안 「지역마다」). 적용 대기는 지역을 합쳐 센다.
        href: '/change/pending', label: 'head 리비전', value: '지역마다',
        ...(regionPending > 0 ? { tone: 'pending' as const, text: `적용 대기 ${regionPending}건` } : { tone: 'ok' as const, text: '적용 대기 없음' }),
      }
      : {
        href: '/change/pending', label: 'head 리비전', value: desk.head === undefined ? '—' : `r${desk.head}`,
        ...(st.pending.length > 0 ? { tone: 'pending' as const, text: `적용 대기 ${st.pending.length}건${clusterText}` } : { tone: 'ok' as const, text: `트래픽에 걸려 있어요${clusterText}` }),
      },
    {
      href: '/traffic/listener', label: '리스너 상태', value: `${serving} / ${desk.listeners.rows.length}`,
      ...(joining > 0 ? { tone: 'pending' as const, text: `${joining}개 적용하면 열림` } : { tone: 'ok' as const, text: '모두 서빙 중' }),
    },
    {
      href: '/traffic/backend', label: '백엔드 상태', value: `${healthy.length} / ${backends.length}`,
      ...(unhealthy.length + drained.length + idle.length > 0
        ? {
          tone: (unhealthy.length > 0 ? 'danger' : 'warn') as Tone,
          text: [unhealthy.length > 0 ? `비정상 ${unhealthy.length}` : '', drained.length > 0 ? `⇣ 드레인 ${drained.length}` : '', idle.length > 0 ? `트래픽 없음 ${idle.length}` : '']
            .filter(Boolean).join(' · '),
        }
        : { tone: 'ok' as const, text: '모두 정상' }),
    },
    {
      href: '/tls/certificate', label: '인증서 만료 임박', value: String(certSoon.length),
      ...(nearest === undefined ? { tone: 'ok' as const, text: '30일 안에 만료되는 것이 없어요' }
        : !nearest.hasMaterial ? { tone: 'danger' as const, text: `${nearest.key} 자료 없음` }
        : (nearest.expiresInDays ?? 0) < 0 ? { tone: 'danger' as const, text: `${nearest.key} 만료됨` }
        : { tone: 'warn' as const, text: `${nearest.key} ${nearest.expiresInDays}일` }),
    },
  ]);

  // ── 지역별 현황 (전역) ──
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
  const regionsWithLeader = $derived(regionViews.filter((x) => x.v !== undefined && x.v.leader.holder !== '—').length);
  const regionColumns: Column<RegionSummary>[] = [
    { key: 'name', label: '지역', mono: true, sort: (r) => r.name },
    { key: 'head', label: 'head', mono: true, width: '100px', text: (r) => (r.status?.head === undefined ? '—' : `r${r.status.head}`) },
    { key: 'pend', label: '적용 대기', width: '120px', text: (r) => { const n = pendingOf(r); return n === undefined ? '—' : `${n}건`; } },
    { key: 'state', label: '상태', sort: (r) => regionState(r).text },
  ];

  // ── 패널 ──
  const groups = $derived(groupAudit(desk.audit.rows, st.pending.map((p) => p.revision)));
  const recent = $derived(groups.filter((g) => g.change).slice(0, 4));
  const whoOf = (rev: string): string | undefined => groups.find((g) => g.change && g.revision === rev)?.who;
  const pendingRevs = $derived(st.pending.map((p) => p.revision).sort((a, b) => Number(a) - Number(b)));
  const pendingWho = $derived([...new Set(pendingRevs.map(whoOf).filter((w): w is string => w !== undefined))].join(', '));

  const pools = $derived(desk.pools.rows.map((p) => {
    const keys = p.backends.map((b) => b.key);
    const dr = keys.filter(draining).length;
    const ok = p.backends.filter((b) => b.state === 'healthy' && !draining(b.key)).length;
    const bad = p.backends.filter((b) => b.state === 'unhealthy' && !draining(b.key)).length;
    const unk = p.backends.length - ok - bad - dr;
    const total = p.backends.length || 1;
    const text = p.backends.length === 0 ? '백엔드가 없어요'
      : [[`● 정상`, ok], [`⇣ 드레인`, dr], [`✕ 비정상`, bad], [`○ 관측 없음`, unk]].filter((x) => (x[1] as number) > 0).map((x) => `${x[0]} ${x[1]}`).join(' · ');
    return { key: p.key, segs: [['ok', ok], ['drain', dr], ['danger', bad], ['neutral', unk]] as const, total, text };
  }));

  const certTone = (c: (typeof desk.certs.rows)[number]): { tone: Tone; text: string } =>
    !c.hasMaterial ? { tone: 'danger', text: '자료 없음' }
    : (c.expiresInDays ?? 0) < 0 ? { tone: 'danger', text: '만료됨' }
    : (c.expiresInDays ?? 0) < 30 ? { tone: 'warn', text: `${c.expiresInDays}일 남음` }
    : { tone: 'ok', text: `${c.expiresInDays}일 남음` };
  const certs = $derived([...desk.certs.rows]
    .sort((a, b) => (a.hasMaterial ? a.expiresInDays ?? 0 : -Infinity) - (b.hasMaterial ? b.expiresInDays ?? 0 : -Infinity))
    .slice(0, 5));

  const engine = $derived(global ? [
    { label: '지역', value: regions === undefined ? '—' : `${regions.length}곳` },
    { label: '엔진', value: regionEngines === '' ? '—' : regionEngines },
    { label: '미완 전환', value: `${regionUnfinished}건` },
    { label: '리더', value: regions !== undefined && regionsWithLeader === regions.length ? '지역마다 1개' : `${regionsWithLeader}곳에 있어요` },
  ] : [
    { label: '리더', value: st.leader.isLeader ? '★ 이 인스턴스' : `☆ ${st.leader.holder}` },
    { label: '게시 세대', value: st.published.generation ?? '—' },
    { label: '미완 전환', value: st.unfinished ? '1건' : '0건' },
    { label: '엔진', value: st.engine.label },
  ]);
</script>

{#snippet regionCell(r: RegionSummary, c: Column<RegionSummary>)}
  {#if c.key === 'state'}
    {@const s = regionState(r)}<Badge tone={s.tone}>{s.text}</Badge>
  {:else if c.key === 'pend'}
    {@const n = pendingOf(r)}<span class:pend={(n ?? 0) > 0}>{c.text?.(r)}</span>
  {:else}{c.text?.(r) ?? ''}{/if}
{/snippet}

{#if !desk.live}
  <Skeleton height="200px" label="연결하는 중" />
{:else}
  <div class="dash">
    {#if st.unfinished}
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
          <span><Badge tone={s.tone}>{s.text}</Badge></span>
        </a>
      {/each}
    </div>

    {#if global}
      <Card title="지역별 현황" padded={false}>
        <DataTable rows={regions ?? []} loading={regions === undefined} rowKey={(r) => r.name} columns={regionColumns} cell={regionCell}
          label="지역별 현황" emptyTitle="지역이 없어요" minHeight="0" />
      </Card>
    {/if}

    <div class="panels">
      <Card title="적용 대기" padded={false}>
        {#snippet actions()}{#if global ? regionPending > 0 : desk.view !== undefined}<Button size="sm" variant="primary" href="/change/pending">영향 확인</Button>{/if}{/snippet}
        {#if global}
          <!-- 전역 — 지역마다 한 줄(시안). 고른 지역의 plan 상세는 적용 대기 화면에서 본다. -->
          {#if regions === undefined}
            <div class="pad"><Skeleton height="40px" label="지역 요약을 읽는 중" /></div>
          {:else if regions.length === 0}
            <div class="pad"><FieldMessage>지역이 없어요.</FieldMessage></div>
          {:else}
            {#each regionViews as { r, v } (r.name)}
              {@const n = v?.pending.length}
              <div class="line">
                <span class="grow mono">{r.name}</span>
                <span class="rev">{v?.head === undefined ? '—' : `r${v.head}`}</span>
                {#if n === undefined}<Badge tone="neutral">{regionState(r).text}</Badge>
                {:else if n > 0}<Badge tone="pending">적용 대기 {n}건</Badge>
                {:else}<Badge tone="ok">없음</Badge>{/if}
              </div>
            {/each}
          {/if}
        {:else if desk.view === undefined}
          <div class="pad"><FieldMessage tone="ok">적용 대기가 없어요. head{desk.head === undefined ? '' : ` r${desk.head}`} 가 트래픽에 걸려 있어요.</FieldMessage></div>
        {:else}
          <div class="line plan">
            <span class="rev">r{desk.view.revision}</span>
            <div class="grow">
              <div>적용 — 커밋 {pendingRevs.length}건 포함{pendingRevs.length > 0 ? ` (${pendingRevs.map((r) => `r${r}`).join(', ')})` : ''}</div>
              <div class="cap">{desk.view.headline}{pendingWho !== '' ? ` · ${pendingWho}` : ''}</div>
            </div>
            {#if desk.view.requiresReload}<Badge tone="warn">reload 필요</Badge>{:else}<Badge tone="ok">세대 전환 불필요</Badge>{/if}
          </div>
        {/if}
      </Card>

      <Card title="풀별 백엔드 헬스" padded={false}>
        <!-- 헬스는 실시간 스트림으로 온다 — 그 연결 상태를 머리에 둔다(시안). 끊기면 이 화면은 뼈대로 바뀐다. -->
        {#snippet actions()}<span class="conn" data-live={desk.live}><span class="dot" aria-hidden="true"></span>{desk.live ? '실시간 수신 중' : '끊김'}</span>{/snippet}
        {#if pools.length === 0}
          <div class="pad"><FieldMessage>풀이 없어요.</FieldMessage></div>
        {:else}
          {#each pools as p (p.key)}
            <a class="line pool" href={`/traffic/pool/${encodeURIComponent(p.key)}`}>
              <span class="mono">{p.key}</span>
              <span class="hb">
                <span class="bar" aria-hidden="true">{#each p.segs as [tone, n] (tone)}{#if n > 0}<span data-tone={tone} style:width="{(n / p.total) * 100}%"></span>{/if}{/each}</span>
                <span class="cap">{p.text}</span>
              </span>
            </a>
          {/each}
        {/if}
      </Card>

      <Card title="인증서 만료" padded={false}>
        {#snippet actions()}<Button size="sm" variant="text" href="/tls/certificate">자세히</Button>{/snippet}
        {#if certs.length === 0}
          <div class="pad"><FieldMessage>인증서가 없어요.</FieldMessage></div>
        {:else}
          {#each certs as c (c.key)}
            {@const t = certTone(c)}
            <a class="line" href={`/tls/certificate/${encodeURIComponent(c.key)}`}>
              <span class="grow mono">{c.key}</span>
              <span class="cap mono">{c.notAfter?.slice(0, 10) ?? '—'}</span>
              <Badge tone={t.tone}>{t.text}</Badge>
            </a>
          {/each}
        {/if}
      </Card>

      <Card title="최근 변경" padded={false}>
        {#snippet actions()}<Button size="sm" variant="text" href="/ops/audit">자세히</Button>{/snippet}
        {#if recent.length === 0}
          <div class="pad"><FieldMessage>최근 변경이 없어요.</FieldMessage></div>
        {:else}
          {#each recent as g (g.key)}
            <div class="line act">
              <span class="cap mono">{clockText(g.at)}</span>
              <span class="grow"><b>{g.title}</b> <span class="cap">· {g.who}</span></span>
              {#if g.result}<Badge tone={g.result.tone}>{g.result.text}</Badge>{/if}
              <span class="rev">{g.revision === undefined ? '' : `r${g.revision}`}</span>
            </div>
          {/each}
        {/if}
      </Card>
    </div>

    <dl class="engine">
      {#each engine as e (e.label)}<div><dt>{e.label}</dt><dd>{e.value}</dd></div>{/each}
    </dl>
  </div>
{/if}

<style>
  .dash { display: flex; flex-direction: column; gap: 16px; max-width: 1280px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
  .stat {
    display: flex; flex-direction: column; gap: 6px; padding: 14px 16px;
    background: var(--bg-panel); border: 1px solid var(--bd); border-radius: var(--r-lg);
    color: var(--tx); text-decoration: none; transition: border-color var(--dur-fast) var(--ease);
  }
  .stat:hover { border-color: var(--accent); }
  .stat:focus-visible { outline: 2px solid var(--focus); outline-offset: 0; }
  .l { font: var(--t-cap); color: var(--tx3); }
  .n { font: 600 26px/32px var(--mono); }
  .panels { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: 16px; align-items: start; }
  @media (max-width: 520px) { .panels { grid-template-columns: minmax(0, 1fr); } }
  .pad { padding: 12px 16px; }
  .line {
    display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-top: 1px solid var(--bd);
    font: var(--t-small); color: var(--tx); text-decoration: none;
  }
  .line:first-child { border-top: 0; }
  a.line:hover { background: var(--bg-hover); }
  a.line:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
  .plan { align-items: flex-start; }
  .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .rev { flex: none; font-family: var(--mono); color: var(--accent); }
  .plan .rev { width: 40px; }
  .act .rev { width: 40px; text-align: right; }
  .cap { font: var(--t-cap); color: var(--tx3); }
  .mono { font-family: var(--mono); }
  b { font-weight: 500; }
  .pool { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 12px; }
  .hb { display: flex; flex-direction: column; gap: 4px; }
  .bar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; background: var(--bg-hover); }
  .bar [data-tone='ok'] { background: var(--ok); }
  .bar [data-tone='drain'] { background: var(--drain); }
  .bar [data-tone='danger'] { background: var(--danger); }
  .bar [data-tone='neutral'] { background: var(--neutral); }
  .pend { color: var(--pending); }
  .conn { display: inline-flex; align-items: center; gap: 6px; font: var(--t-cap); color: var(--danger); }
  .conn[data-live='true'] { color: var(--ok); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
  .engine {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px 24px; margin: 0; padding: 12px 16px;
    background: var(--bg-panel); border: 1px solid var(--bd); border-radius: var(--r-lg); font: var(--t-small);
  }
  .engine dt { font: var(--t-cap); color: var(--tx3); }
  .engine dd { margin: 0; font-family: var(--mono); overflow-wrap: anywhere; }
</style>
