<script lang="ts">
  /**
   * 적용 대기 — 커밋됐지만 트래픽에 아직 안 걸린 plan 의 영향 (시안 §8 영향 요약 카드 · 적용 대기 화면).
   *
   * 왼쪽은 적용 항목(시안 `groupsOf`) — 지역 인스턴스면 자기 하나, 전역이면 지역마다 한 줄이다. 오른쪽은 고른 항목의
   * **합친 영향**이다. head 의 plan 은 활성 모델과 견준 것이라(`config-store` plan) 앞의 커밋까지 함께 잰다.
   *
   * **끊기는 것을 먼저 쓴다:** 닫히는 소켓 · 기존 세션 · 라우트 순서 경고 · 엔진 경고 · 인증서. 그 아래 포함된 커밋,
   * 소켓 변화, 영향 리스너 표. 새 요청부터 바뀌는 것은 「영향 없음」 으로 접는다.
   * 적용은 확인 대화상자(영향 확인 체크)를 지난다. 전역에서 연락 없는 지역이면 적용 버튼을 막고 사유를 쓴다.
   *
   * **전체 합산**(2026-11-04, §2.5)이면 적용 대기 화면(`routes/change/pending`)이 이 컴포넌트를 고른 지역의
   * `InRegion` 안에 그리고, 왼쪽 항목(지역마다 한 줄)을 `plans` 로 넘긴다. 그때 이 컴포넌트는 지역 요약을 묻지 않고
   * 항목을 누르면 `onpick` 을 부른다 — 셸의 desk 를 옮기지 않는다. 오른쪽 영향 · 적용 · 확인 창은 그 지역의 desk · 범위다.
   */
  import { getContext } from 'svelte';
  import { Button, ConfirmDialog, FieldMessage, ImpactCard, RadioGroup, StepList, toast, type ConfirmLine, type ImpactLine, type StepState, type Tone } from '#lib/ui';
  import WriteNote from '#lib/global/WriteNote.svelte';
  import { LOST_LABEL, LOST_MESSAGE, type RegionSummary, type Scope } from '#lib/global/scope.svelte.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { RESOURCES, type ResourceKind } from '@web/resources';
  import ClusterConvergence from './ClusterConvergence.svelte';
  import type { PlanRow } from './aggregate-view';

  let { plans, picked, onpick }: {
    /** 전체 합산의 왼쪽 항목(지역마다 한 줄). 주면 지역 요약을 묻지 않고 이것을 그린다. */
    plans?: readonly PlanRow[] | undefined;
    /** 고른 항목의 이름(지역). */
    picked?: string | undefined;
    /** 항목을 눌렀다 — 부르는 쪽이 그 지역으로 바꿔 그린다. */
    onpick?: ((name: string) => void) | undefined;
  } = $props();

  type Rev = { revision: string; createdBy: string; note: string | null; rollbackOf: string | null };
  type Group = { name: string; head?: string; pending: number; lost: boolean; current: boolean; region?: RegionSummary };
  type Result = { tone: 'ok' | 'danger'; planId?: string; revision?: string; title: string; body: string; done: boolean };

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const ro = $derived(scope?.readOnly === true);
  const glob = $derived(scope?.mode === 'global');
  const lost = $derived(scope?.lost === true);
  const view = $derived(desk.view);
  /** 마지막 적용의 결과 블록(시안 `applyRes`). 닫거나 다른 plan 이 오면 내린다. */
  let result = $state<Result | undefined>();
  const where = $derived(glob && scope?.region !== undefined ? ` 지역: ${scope.region.name}` : '');

  // ---- 포함된 커밋 — 적용 대기 plan 의 리비전과, 리비전 목록의 누가 · 메모
  let revs = $state<Rev[]>([]);
  $effect(() => {
    void desk.head;
    if (!desk.live) return;
    void desk.revisions().then((r) => { revs = (r ?? []) as Rev[]; });
  });
  const commits = $derived(
    [...desk.status.pending]
      .sort((a, b) => (BigInt(a.revision) < BigInt(b.revision) ? -1 : 1))
      .map((p) => {
        const r = revs.find((x) => x.revision === p.revision);
        const title = r?.note ?? (r?.rollbackOf != null ? `r${r.rollbackOf} 로 롤백` : '메모 없음');
        return { rev: p.revision, title, by: r?.createdBy ?? '' };
      }),
  );
  const revList = $derived(commits.map((c) => `r${c.rev}`).join(', '));

  // ---- 영향 — 끊기는 것을 먼저
  /** `viewOfImpact` 가 접은 세션 문장. 새 연결·새 요청부터 바뀌는 것은 끊지 않는다 — 「영향 없음」 으로 접는다. */
  const calmSession = (s: string): boolean => s.includes('새 연결·새 요청부터');
  const breaking = $derived<ImpactLine[]>(view === undefined ? [] : [
    // 롤백 plan 은 영향을 재지 않았다 — 「없다」 가 아니다.
    ...(view.rollbackOf === undefined ? [] : [{
      tone: 'warn' as const, icon: '▲',
      text: `롤백은 영향을 미리 재지 않아요. 소켓이 열리거나 닫히고 세션이 끊길 수 있어요. 기록 화면에서 r${view.rollbackOf} 와 지금의 차이를 먼저 봐요.`,
    }]),
    ...view.bindBlockers.map((s) => ({ tone: 'danger' as const, icon: '✕', text: `적용할 수 없어요 — ${s}` })),
    ...view.socketsRemoved.map((s) => ({ tone: 'danger' as const, icon: '✕', text: `소켓을 닫아요: ${s}` })),
    ...view.sessions.filter((s) => !calmSession(s)).map((s) => ({ tone: 'warn' as const, icon: '▲', text: s })),
    ...view.routeWarnings.map((s) => ({ tone: 'warn' as const, icon: '▲', text: `라우트 순서 — ${s}` })),
    ...view.capabilityWarnings.map((s) => ({ tone: 'warn' as const, icon: '▲', text: `엔진 — ${s}` })),
    ...view.certificates.map((s) => ({ tone: 'warn' as const, icon: '▲', text: `인증서 — ${s}` })),
  ]);
  /**
   * 소켓 한 줄 — 시안 「10.0.0.10:8443 (admin-https)」. 엔진 표기(`tcp://0.0.0.0:8443`)에서 전송 접두를 떼고,
   * 같은 주소:포트의 리스너가 영향 표에 있으면 이름을 붙인다.
   */
  const sockLine = (s: string): string => {
    const addr = s.replace(/^[a-z]+:\/\//, '');
    const l = listeners.find((x) => x.where.endsWith(` ${addr}`) || x.where === addr);
    return l === undefined ? addr : `${addr} (${l.key})`;
  };
  const opened = $derived((view?.socketsAdded ?? []).map(sockLine));
  const closed = $derived((view?.socketsRemoved ?? []).map(sockLine));
  const quiet = $derived(view === undefined ? [] : view.sessions.filter(calmSession));
  /** `viewOfImpact` 의 리스너 한 줄은 두 칸 띄움으로 나뉜다: 키 · 프로토콜 · 바인드:포트 · (변경). */
  const listeners = $derived((view?.listeners ?? []).map((l) => {
    const [key = l, protocol = '', bind = '', change] = l.split(/\s{2,}/);
    const sess = view?.sessions.find((s) => s.startsWith(`${protocol} —`));
    const kind = change?.replace(/^\(|\)$/g, '') ?? '설정 변경';
    // 시안 「변경 종류」 · 「기존 세션 영향」 말: 새 리스너는 소켓 열림 · 영향 없음(신규), 지운 리스너는 소켓 닫힘.
    const opens = /추가|신규|열/.test(kind); const closes = /삭제|제거|닫/.test(kind);
    const raw = sess?.slice(protocol.length + 2).trim();
    const sessText = opens ? '영향 없음 (신규)'
      : closes ? '진행 중인 세션은 옛 워커가 마무리해요'
      : raw === undefined ? '—' : calmSession(raw) ? '새 연결 · 새 요청부터 바뀌어요. 진행 중인 것은 옛 값으로 처리해요' : raw;
    return { key, where: `${protocol} ${bind}`.trim(), change: opens ? '소켓 열림' : closes ? '소켓 닫힘' : kind, sess: sessText };
  }));
  /**
   * **지울 것** (#126 후속) — head 에서 지웠지만 엔진은 아직 돌리는 리소스. 목록에는 행이 없어서 여기서만 보인다.
   * `pending-resources` 가 주는 그대로다(활성 리비전과 head 의 차이). 못 읽었으면 비어 있다.
   */
  const removed = $derived(desk.pendingResources.removed.map((r) => ({
    ...r, label: Object.hasOwn(RESOURCES, r.kind) ? RESOURCES[r.kind as ResourceKind].label : r.kind,
  })));
  /** 활성 리비전 — 게시된 세대(`r<리비전>-e<epoch>`, `src/control/plane.ts`)에서 읽는다. 모르면 undefined. */
  const active = $derived(/^r(\d+)-e/.exec(desk.status.published.generation ?? '')?.[1]);
  /**
   * 판정 한 줄(시안 `vt`). 롤백 plan · 세대만 새로 서는 엔진은 시안에 없는 사실이라 그 말을 그대로 둔다.
   * reload 는 진행 중인 세션을 옛 워커가 마무리한다(nginx graceful reload).
   */
  const verdict = $derived(view === undefined ? ''
    : view.rollbackOf !== undefined ? `r${view.rollbackOf}의 내용으로 되돌려요. 영향은 미리 재지 않았어요.`
    : view.requiresReload ? 'reload가 필요해요. 진행 중인 세션은 옛 워커가 마무리해요.'
    : view.headline.startsWith('산출물은 같지만') ? '산출물은 같지만 이 엔진은 세대를 새로 세워요. 멤버십 평면이 없어요.'
    : '세대 전환이 필요 없어요.');
  /** 「리비전 r8 → r9」 — 활성 리비전을 모르면 head 만. */
  const span = $derived(view === undefined ? '' : active === undefined ? `r${view.revision}` : `r${active} → r${view.revision}`);
  let commitsOpen = $state(false);
  const tone = $derived<Tone>(view === undefined ? 'ok' : view.bindBlockers.length > 0 ? 'danger' : view.requiresReload || view.rollbackOf !== undefined ? 'warn' : 'ok');

  // ---- 적용 항목 (시안 `groupsOf`) — 전역이면 지역 요약에서 지역마다 적용 대기 수를 읽는다
  let regions = $state<RegionSummary[]>([]);
  const loadRegions = async (): Promise<void> => {
    if (scope?.mode !== 'global' || plans !== undefined) return;
    const r = await fetch('/api/v1/regions', { credentials: 'same-origin', headers: desk.token === '' ? {} : { authorization: `Bearer ${desk.token}` } }).catch(() => undefined);
    if (r === undefined || !r.ok) return;
    regions = ((await r.json()) as { regions: RegionSummary[] }).regions;
    scope.sync(regions);
  };
  $effect(() => { void desk.pendingCount; void desk.head; void loadRegions(); });

  const pendingOf = (r: RegionSummary): number => {
    const p = (r.status as { pendingApply?: unknown } | undefined)?.pendingApply;
    return Array.isArray(p) ? p.length : 0;
  };
  const groups = $derived<Group[]>(glob
    ? regions.map((r): Group => {
      const current = r.name === scope?.region?.name;
      const head = current ? desk.head : r.status?.head;
      return { name: r.name, pending: current ? desk.pendingCount : pendingOf(r), lost: current ? lost : !r.reachable, current, region: r, ...(head === undefined ? {} : { head }) };
    }).filter((g) => g.current || g.pending > 0 || g.lost)
    : [{ name: scope?.self ?? '이 인스턴스', pending: desk.pendingCount, lost: false, current: true, ...(desk.head === undefined ? {} : { head: desk.head }) }]
      .filter(() => view !== undefined || desk.failedApply !== undefined || result !== undefined));
  const switchTo = (r: RegionSummary): void => {
    desk.disconnect();
    scope?.choose(r);
    // **기다리지 않는다.** `connect` 는 스트림이 끊길 때까지 끝나지 않는다.
    void desk.connect();
  };
  const rowState = (g: Group): { tone: Tone; text: string } => {
    if (g.lost) return { tone: 'neutral', text: LOST_LABEL };
    if (!g.current && g.region?.auth === 'rejected') return { tone: 'danger', text: '인증 거절' };
    if (g.current && desk.failedApply !== undefined) return { tone: 'danger', text: '적용 실패' };
    if (g.pending > 0) return { tone: 'pending', text: '적용 대기' };
    return { tone: 'ok', text: g.current && result === undefined ? '최신' : '적용됨' };
  };
  const rowTitle = (g: Group): string => {
    if (g.lost) return LOST_MESSAGE;
    if (g.current && view !== undefined) return `r${view.revision} 적용 — 커밋 ${commits.length}건 포함${revList === '' ? '' : ` (${revList})`}`;
    if (g.current && desk.failedApply !== undefined) return `r${desk.failedApply.revision} 적용이 실패했어요`;
    if (g.pending > 0) return `적용 대기 ${g.pending}건 — 골라서 영향을 봐요`;
    if (g.current && result !== undefined) return '적용했어요. 결과를 확인해요.';
    return '적용할 변경이 없어요.';
  };
  const ICON: Partial<Record<Tone, string>> = { ok: '●', pending: '◐', danger: '✕', neutral: '○', info: '↻' };

  /** 왼쪽 한 줄 — 지역 요약으로 만든 항목, 또는 합산이 넘긴 항목(`plans`). */
  const rows = $derived<PlanRow[]>(plans !== undefined ? [...plans] : groups.map((g) => {
    const st = rowState(g);
    return {
      name: g.name, ...(g.head === undefined ? {} : { head: g.head }), lost: g.lost, tone: st.tone as PlanRow['tone'], text: st.text,
      by: g.current ? [...new Set(commits.map((c) => c.by).filter((b) => b !== ''))].join(', ') : '', title: rowTitle(g), known: true,
    };
  }));
  /** 합산에서 고른 지역의 지금 값을 모른다(연락 없음 · 인증 거절 · 불러오는 중) — 오른쪽은 그 한 줄만 쓴다. */
  const unknownRow = $derived(plans?.find((r) => r.name === picked && !r.known));
  const rowValue = $derived(plans !== undefined ? picked : groups.find((g) => g.current)?.name);
  const pick = (name: string): void => {
    if (plans !== undefined) { onpick?.(name); return; }
    const g = groups.find((x) => x.name === name);
    if (g !== undefined && !g.current && !g.lost && g.region !== undefined && g.region.auth === undefined) switchTo(g.region);
  };

  // ---- 적용 — 확인 대화상자 → 진행 토스트 → 결과 블록
  const STEPS = ['렌더', '검증', '게시', 'reload', '활성화 확인'];
  const steps = (s: StepState): { name: string; state: StepState }[] => STEPS.map((name) => ({ name, state: s }));
  let asking = $state(false);
  // 다른 plan 이 오면 지난 결과는 내린다.
  $effect(() => { if (view !== undefined && result?.planId !== undefined && view.planId !== result.planId) result = undefined; });

  const settle = async (title: string, run: () => Promise<void>, planId: string | undefined, n: number, list: string): Promise<void> => {
    const before = scope?.refusals ?? 0;
    result = undefined;
    const id = toast.progress(title, `${STEPS.join(' → ')}${where}`);
    let thrown: string | undefined;
    try { await run(); } catch (e) { thrown = e instanceof Error ? e.message : String(e); }
    const error = thrown ?? desk.error;
    if (error === undefined) {
      const revision = /r(\d+)$/.exec(title)?.[1];
      const gen = desk.status.published.generation;
      const genText = revision !== undefined && gen?.startsWith(`r${revision}-`) === true ? ` 세대 ${gen}을 확인했어요.` : '';
      result = {
        tone: 'ok', title: `● ${title.replace(/^적용: /, '적용했어요: ')}.${genText}`, done: true,
        body: `${n > 1 ? `커밋 ${n}건(${list})이 함께 들어갔어요. ` : ''}활성화를 확인했어요.${where}`,
        ...(planId === undefined ? {} : { planId }),
        ...(revision === undefined ? {} : { revision }),
      };
      toast.done(id, { tone: 'ok', title: title.replace(/^적용: /, '적용했어요: '), body: `활성화를 확인했어요.${where}` });
    } else {
      result = { tone: 'danger', title: '✕ 적용하지 못했어요', body: `${error} 엔진은 전에 적용한 설정 그대로예요.`, done: false, ...(planId === undefined ? {} : { planId }) };
      // 연락 없음 · 403 은 scope 가 지역 이름으로 이미 알렸다 — 두 번 알리지 않는다.
      if ((scope?.refusals ?? 0) > before) toast.close(id);
      else toast.done(id, { tone: 'danger', title: '적용하지 못했어요', body: error });
    }
  };
  const confirmApply = (): void => {
    const v = view;
    if (v === undefined) return;
    asking = false;
    void settle(`적용: r${v.revision}`, () => desk.apply(), v.planId, commits.length, revList);
  };
  const retry = (): void => {
    const f = desk.failedApply;
    if (f === undefined || lost) return;
    void settle(`적용: r${f.revision}`, () => desk.retryApply(), f.planId, 1, `r${f.revision}`);
  };
  const dlgLines = $derived<ConfirmLine[]>(view === undefined ? [] : [
    { tone, icon: tone === 'ok' ? '●' : '▲', text: verdict },
    ...breaking.slice(0, 2),
    ...(view.rollbackOf === undefined ? [{ tone: 'ok' as const, icon: '＋', text: `소켓 ${opened.length}개를 열고 ${closed.length}개를 닫아요.` }] : []),
  ]);
</script>

{#snippet resultBlock()}
  {#if result !== undefined}
    <div class="res" data-tone={result.tone} role="status">
      <div class="rt">{result.title}</div>
      <div class="rb">{result.body}</div>
      <div class="rc"><Button size="sm" onclick={() => { result = undefined; }}>닫기</Button></div>
    </div>
    <!-- 클러스터면 노드마다 따라왔는지를 몇 번 다시 읽어 보인다(시안 `convRows` — 결과 아래 구획). -->
    {#if result.done}<ClusterConvergence revision={result.revision} />{/if}
  {/if}
{/snippet}

{#snippet progressBlock()}
  <div class="stp">
    <div class="sh">적용 단계</div>
    <StepList steps={steps('todo')} label="적용 단계" />
  </div>
{/snippet}

{#snippet removedBlock()}
  {#if removed.length > 0}
    <div class="sec">
      <div class="sh" style:color="var(--danger)">− 지울 것 · {removed.length}</div>
      <div class="tbl lst" role="table" aria-label="지울 것">
        {#each removed as r (`${r.kind}/${r.key}`)}
          <div class="tr gone" role="row"><span role="cell" class="muted">{r.label}</span><span role="cell" class="mono">{r.key}</span></div>
        {/each}
      </div>
    </div>
  {/if}
{/snippet}

{#snippet lostNote()}
  {#if lost}<span class="lost" role="status">✕ {LOST_MESSAGE}</span>{/if}
{/snippet}

<div class="pi" data-glob={glob}>
  <aside class="plans" aria-label="적용 항목">
    <div class="ph">적용 항목 · {plans !== undefined ? plans.filter((r) => r.tone === 'pending').length : groups.filter((g) => g.pending > 0).length}</div>
    {#if rows.length > 0}
      <!-- 합산이면 연락 없는 지역도 고를 수 있다 — 고르면 오른쪽이 막힌 사유를 쓴다(시안 `lostMsg`). -->
      <RadioGroup label="적용 항목" direction="column" dot={false} value={rowValue}
        options={plans !== undefined
          ? plans.map((r) => ({ value: r.name, label: r.name }))
          : groups.map((g) => ({ value: g.name, label: g.name, disabled: !g.current && (g.lost || g.region?.auth === 'rejected') }))}
        onchange={pick}>
        {#snippet item(o)}
          {@const g = rows.find((x) => x.name === o.value)}
          {#if g !== undefined}
            <span class="row" title={g.lost ? LOST_MESSAGE : undefined}>
              <span class="r1">
                <span class="rev">{g.head === undefined ? '—' : `r${g.head}`}</span>
                <span class="by">{g.by}</span>
                <span class="st" style:color="var(--{g.tone})">{ICON[g.tone]} {g.text}</span>
              </span>
              <span>{g.title}</span>
              {#if glob}<span class="reg">{g.name}{g.lost ? ` · ${LOST_LABEL}` : ''}</span>{/if}
            </span>
          {/if}
        {/snippet}
      </RadioGroup>
    {/if}
    {#if rows.length === 0}<div class="empty">적용할 변경이 없어요.</div>{/if}
  </aside>

  <div class="main">
    {#if unknownRow !== undefined}
      <span class="lost" role="status" data-tone={unknownRow.tone}>{ICON[unknownRow.tone]} {unknownRow.name} · {unknownRow.title}</span>
    {:else if view !== undefined}
      <!-- 시안 순서: 포함된 커밋 → 끊기거나 바뀌는 것 → 소켓 → 영향 리스너 → 영향 없음. 그래서 끊기는 것도 details 로 그린다. -->
      <ImpactCard {tone} title={verdict} {quiet} progress={desk.applying ? progressBlock : undefined} result={result !== undefined ? resultBlock : undefined}>
        {#snippet sub()}
          리비전 {span} · 커밋 {Math.max(commits.length, 1)}건을 합친 영향
        {/snippet}
        {#snippet details()}
          {#if commits.length > 0}
            <details class="cm" bind:open={commitsOpen}>
              <summary>{commitsOpen ? '▾' : '▸'} 포함된 커밋 · {commits.length}</summary>
              <div class="cml">
                {#each commits as c (c.rev)}<div class="cmr"><span class="rev">r{c.rev}</span><span>{c.title}</span><span class="cby">{c.by}</span></div>{/each}
              </div>
            </details>
          {/if}
          <div class:sec={commits.length > 0}>
            <div class="sh" style:color="var(--danger)">끊기거나 바뀌는 것 · {breaking.length}</div>
            <div class="lines">
              {#each breaking as l, i (i)}<div class="line"><span style:color="var(--{l.tone})">{l.icon}</span><span>{l.text}</span></div>{/each}
              {#if breaking.length === 0}<div class="calm">● 끊기는 연결이 없어요.</div>{/if}
            </div>
          </div>
          {#if opened.length + closed.length > 0}
            <div class="sec socks">
              <div><div class="sh" style:color="var(--ok)">＋ 열리는 소켓 · {opened.length}</div>
                <div class="sl">{#each opened as a (a)}<span>{a}</span>{:else}<span class="none">없음</span>{/each}</div></div>
              <div><div class="sh" style:color="var(--danger)">− 닫히는 소켓 · {closed.length}</div>
                <div class="sl">{#each closed as a (a)}<span>{a}</span>{:else}<span class="none">없음</span>{/each}</div></div>
            </div>
          {/if}
          {#if listeners.length > 0}
            <div class="sec">
              <div class="sh">영향을 받는 리스너</div>
              <div class="tbl lst" role="table" aria-label="영향을 받는 리스너">
                <div class="tr th" role="row"><span role="columnheader">리스너</span><span role="columnheader">변경 종류</span><span role="columnheader">기존 세션 영향</span></div>
                {#each listeners as l (l.key)}
                  <div class="tr" role="row"><span role="cell" class="mono" title={l.where}>{l.key}</span><span role="cell">{l.change}</span><span role="cell" class="muted">{l.sess}</span></div>
                {/each}
              </div>
            </div>
          {/if}
          {@render removedBlock()}
        {/snippet}
        {#snippet footer()}
          {#if !ro}
            {#if view.bindBlockers.length > 0}
              <span class="note">이 변경은 한 번에 적용할 수 없어요. 위 안내대로 두 번에 나눠 적용해요.</span>
            {:else}
              <span class="note">{active === undefined ? '' : `활성 리비전 r${active} → r${view.revision} · `}커밋 {Math.max(commits.length, 1)}건을 함께 적용해요.{where}</span>
            {/if}
            {@render lostNote()}
            <Button variant="danger" loading={desk.applying} disabled={view.bindBlockers.length > 0 || lost} onclick={() => { asking = true; }}>{desk.applying ? '적용하는 중' : `적용: r${view.revision}`}</Button>
          {:else}
            <WriteNote />
          {/if}
        {/snippet}
      </ImpactCard>
    {:else if desk.failedApply !== undefined}
      <ImpactCard tone="danger" title={`r${desk.failedApply.revision} 적용이 실패했어요`}
        breaking={[{ tone: 'danger', icon: '✕', text: desk.failedApply.failure }]} quiet={[]}
        progress={desk.applying ? progressBlock : undefined} result={result !== undefined ? resultBlock : undefined}>
        {#snippet sub()}엔진은 전에 적용한 설정 그대로예요. 설정을 고쳐 저장하거나, 원인을 없앤 뒤 같은 리비전을 다시 적용해요.{/snippet}
        {#snippet details()}{@render removedBlock()}{/snippet}
        {#snippet footer()}
          {#if !ro}
            <span class="note">같은 설정으로 다시 시도해요. 새 리비전은 안 만들어요.{where}</span>
            {@render lostNote()}
            <Button variant="danger" loading={desk.applying} disabled={lost} onclick={retry}>{desk.applying ? '적용하는 중' : `r${desk.failedApply.revision} 다시 적용해요`}</Button>
          {:else}
            <WriteNote />
          {/if}
        {/snippet}
      </ImpactCard>
    {:else if result !== undefined}
      <!-- 방금 적용했다 — 시안: 판정 없이 결과 블록 · 수렴, 아래 「이미 적용했어요.」 와 막힌 적용 버튼. -->
      <section class="done">
        <div class="db">{@render resultBlock()}</div>
        <footer><span class="note">이미 적용했어요.</span><Button variant="danger" disabled>적용</Button></footer>
      </section>
    {:else if desk.live}
      <FieldMessage>커밋했지만 적용하지 않은 plan 이 없어요. 리소스를 저장하거나 <code>bary import</code> 를 하면 여기 와요.</FieldMessage>
      {#if !ro && desk.head !== undefined}
        <div class="again">
          <Button loading={desk.applying} disabled={lost} onclick={() => { void desk.rerender(); }}>{desk.applying ? '만드는 중' : `r${desk.head} 다시 렌더해요`}</Button>
          <FieldMessage>설정은 그대로예요. barycenter 를 새 판으로 올린 뒤, 바뀐 nginx 설정을 내려고 써요. 영향을 먼저 보여 줘요.</FieldMessage>
          {@render lostNote()}
        </div>
      {/if}
    {/if}
  </div>
</div>

<ConfirmDialog
  bind:open={asking}
  title={`적용: r${view?.revision ?? ''}`}
  sub={`${active === undefined ? '' : `활성 리비전은 r${active}이에요. `}커밋 ${Math.max(commits.length, 1)}건${revList === '' ? '' : `(${revList})`}이 함께 들어가요.${where}`}
  lines={dlgLines}
  confirmLabel="적용" danger requireCheck busy={desk.applying}
  onconfirm={confirmApply}
/>

<style>
  /* 시안 값 그대로 — 적용 대기 화면(`pnDisp`). */
  .pi { display: grid; grid-template-columns: minmax(240px, 300px) minmax(0, 1fr); gap: 16px; align-items: start; }
  @media (max-width: 860px) { .pi { grid-template-columns: minmax(0, 1fr); } }
  .plans { background: var(--bg-panel); border: 1px solid var(--bd); border-radius: var(--r-lg); overflow: hidden; }
  .ph { padding: 10px 14px; border-bottom: 1px solid var(--bd); font-weight: 600; font-size: 14px; }
  /* RadioGroup 의 선택지를 적용 항목 한 줄로 — 줄마다 위 테두리, 고른 줄은 바탕과 왼쪽 막대(시안 `pl.bg` · `pl.bar`). */
  .plans :global([role='radiogroup']) { gap: 0; }
  .plans :global([role='radio']) { width: 100%; padding: 0; border: 0; border-top: 1px solid var(--bd); border-radius: 0; background: transparent; color: var(--tx); text-align: left; }
  .plans :global([role='radio'][aria-checked='true']) { background: var(--bg-sel); box-shadow: inset 3px 0 0 var(--accent); }
  .plans :global([role='radio']:not(:disabled):not([aria-checked='true']):hover) { background: var(--bg-hover); }
  .plans :global([role='radio']:focus-visible) { outline: 2px solid var(--focus); outline-offset: -2px; }
  .row { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; padding: 10px 14px; font-size: 13px; }
  .r1 { display: flex; gap: 8px; align-items: center; }
  .rev { font-family: var(--mono); color: var(--accent); }
  .by { flex: 1; font-size: 12px; color: var(--tx3); }
  .st { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; white-space: nowrap; }
  .reg { font-family: var(--mono); font-size: 12px; color: var(--tx3); }
  .empty { padding: 24px; text-align: center; color: var(--tx3); font-size: 13px; }
  .main { display: flex; flex-direction: column; gap: 12px; min-width: 0; }

  .sec { padding-top: 12px; border-top: 1px solid var(--bd); }
  .sh { font-size: 12px; font-weight: 600; color: var(--tx2); margin-bottom: 6px; }
  .lines { display: flex; flex-direction: column; gap: 6px; }
  .line { display: flex; gap: 8px; }
  .calm { color: var(--ok); }
  /* 포함된 커밋 — 글자 단추처럼 접고 편다(시안 `toggleCommits`). */
  .cm summary { list-style: none; cursor: pointer; padding: 0; font-size: 12px; font-weight: 600; color: var(--tx2); width: fit-content; }
  .cm summary::-webkit-details-marker { display: none; }
  .cm summary:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: var(--r-sm); }
  .cml { display: flex; flex-direction: column; margin-top: 8px; border: 1px solid var(--bd); border-radius: var(--r-md); overflow: hidden; animation: bc-in var(--dur) var(--ease); }
  .cmr { display: grid; grid-template-columns: 48px minmax(0, 1fr) 90px; gap: 12px; padding: 8px 12px; border-top: 1px solid var(--bd); align-items: start; }
  .cby { font-size: 12px; color: var(--tx3); text-align: right; }
  .socks { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .sl { display: flex; flex-direction: column; gap: 4px; font-family: var(--mono); font-size: 12px; }
  .none { color: var(--tx3); font-family: var(--font); }
  .tbl { border: 1px solid var(--bd); border-radius: var(--r-md); overflow: hidden; }
  .tr { display: grid; gap: 12px; padding: 6px 12px; align-items: center; border-top: 1px solid var(--bd); min-height: var(--row-h); }
  .tr:first-child { border-top: 0; }
  .lst .tr { grid-template-columns: 1fr 1fr 1.6fr; }
  .lst .tr.gone { grid-template-columns: 140px minmax(0, 1fr); }
  .th { height: 28px; min-height: 0; padding: 0 12px; background: var(--bg-hover); font-size: 12px; font-weight: 600; color: var(--tx2); }
  .mono { font-family: var(--mono); }
  .muted { color: var(--tx2); }
  code { font-family: var(--mono); font-size: 12px; }

  .stp { display: flex; flex-direction: column; gap: 6px; }
  .res { --c: var(--ok); --cb: var(--ok-bg); padding: 10px 12px; border-radius: var(--r-md); background: var(--cb); border: 1px solid var(--c); }
  .res[data-tone='danger'] { --c: var(--danger); --cb: var(--danger-bg); }
  .rt { font-weight: 600; color: var(--c); }
  .rb { color: var(--tx2); font-size: 12px; margin-top: 2px; }
  .rc { margin-top: 8px; }
  .note { font-size: 12px; color: var(--tx3); }
  .lost { color: var(--danger); font-size: 12px; flex: 1; }
  .lost[data-tone='info'] { color: var(--tx2); }
  .done { background: var(--bg-panel); border: 1px solid var(--bd); border-radius: var(--r-lg); overflow: hidden; }
  .db { padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; font-size: 13px; }
  .done footer { padding: 10px 16px; border-top: 1px solid var(--bd); display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .again { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; margin-top: 12px; }
</style>
