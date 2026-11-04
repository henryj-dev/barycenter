<script lang="ts">
  /**
   * 앱 셸 (#126, 디자인 시안 「App Shell」) — 사이드바 · 상단 바 · 배너 · 페이지 머리 · 본문.
   *
   * 로그인 · 초대 수락 · 재설정 · 이메일 확인은 셸 없이 혼자 선다(시안). 로그인하지도, 토큰으로 붙지도
   * 않았으면 로그인 화면으로 보낸다 — 화면마다 「연결하면 …」 을 띄우는 대신 한 자리에서 막는다.
   * **로그인 상태에서는 토큰 칸을 어디에도 안 보인다.** 토큰 연결은 로그인 화면에 있다.
   */
  import { onMount, setContext, untrack, type Snippet } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { isDynamicGuiPath, pageOf } from '@web/page';
  import { PAGE_META, STANDALONE, crumbsOf } from '@web/nav';
  import { connStateOf, hasStream } from '@web/reconnect';
  import { createDesk } from '#lib/desk.svelte.ts';
  import { createSession } from '#lib/account/session.svelte.ts';
  import StepUpDialog from '#lib/account/StepUpDialog.svelte';
  import { LOST_LABEL, createScope, type RegionSummary } from '#lib/global/scope.svelte.ts';
  import { createRegionDesks } from '#lib/global/regions.svelte.ts';
  import { REGION_PARAM, aggregateFallback, isAggregatePath } from '#lib/global/aggregate.ts';
  import { Banner, Toaster, toast } from '#lib/ui';
  import Sidebar, { type SideRegion } from '#lib/shell/Sidebar.svelte';
  import TopBar from '#lib/shell/TopBar.svelte';
  import PageHeader from '#lib/shell/PageHeader.svelte';
  // 글꼴은 빌드가 자기 자산으로 들인다 — 외부 출처를 열지 않는다(serve-gui 의 CSP).
  import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
  import '@fontsource-variable/jetbrains-mono';
  import '../app.css';

  let { children } = $props();

  // 전역 모드면 읽기 경로가 고른 지역으로 간다 — desk 보다 먼저 만든다.
  const scope = createScope();
  setContext('scope', scope);
  const desk = createDesk(scope);
  setContext('desk', desk);
  /**
   * 전체 합산(전역에서 지역을 안 골랐다)의 지역마다 desk — 합산 화면이 열려 있는 동안만 붙는다(`useAggregate`).
   * 지역 인스턴스에서는 지역 요약을 안 받으므로 비어 있고 아무것도 안 붙는다.
   */
  const regionDesks = createRegionDesks({ token: () => desk.token });
  setContext('regions', regionDesks);
  // 사람 계정 — 쿠키 세션이면 `/me` 가 답한다. 토큰으로 붙었으면 비어 있다.
  const session = createSession();
  setContext('session', session);

  /**
   * 페이지 머리 오른쪽 버튼(만들기 등) — 화면이 `usePageActions` 로 스니펫을 맡긴다. 화면을 떠나면 비운다.
   */
  const pageActions = $state<{ snippet?: Snippet }>({});
  setContext('pageActions', pageActions);

  const place = $derived(pageOf(page.url.pathname));
  const standalone = $derived(STANDALONE.includes(place));
  /** 상세(key 가 든 주소)는 자기 머리(DetailHeader)를 그린다 — 페이지 머리는 제목 · 설명만 두고 만들기 버튼을 숨긴다(콘솔). */
  const detail = $derived(isDynamicGuiPath(page.url.pathname));
  const meta = $derived(PAGE_META[place]);

  /** 주소가 그 지역으로 좁혀 열라고 한다(`?region=<이름>`, 합산 행의 상세 · 수정 · 만들기). 전역에서만 읽는다. */
  const wanted = $derived(scope.mode === 'global' ? page.url.searchParams.get(REGION_PARAM) : null);
  /**
   * 전역인데 지역을 안 골랐다 — **전체 합산**이다(2026-11-04, docs/design-global-mode.md §2.5). 합산으로 그리는 화면
   * (`AGGREGATE_PATHS`)과 계정 화면은 그대로 쓴다. 아직 지역 하나만 그릴 줄 아는 화면은 지역 고르기로(합산 목록의 상세 · 만들기면
   * 그 목록으로) 보낸다. 좁혀 열라는 주소면 좁힐 때까지 기다린다.
   */
  const needsRegion = $derived(
    scope.mode === 'global' && scope.region === undefined && wanted === null && !isAggregatePath(page.url.pathname)
      && !['regions', 'login', 'invite', 'account', 'users', 'reset', 'email', 'design'].includes(place),
  );
  $effect(() => { if (needsRegion) void goto(aggregateFallback(page.url.pathname)); });

  let ready = $state(false);
  onMount(async () => {
    await scope.detect();
    await session.refresh();
    // 전역은 지역을 고른 뒤에 붙는다(`/regions` 가 desk.connect 를 부른다).
    if (session.me !== undefined && scope.mode !== 'global') void desk.connect();
    ready = true;
  });
  /** 들어올 자격이 없다 — 로그인도, 토큰 연결도 없다. 디자인 견본은 API 를 안 부르므로 연다. */
  $effect(() => {
    if (!ready || standalone || place === 'design') return;
    if (session.me === undefined && !desk.live && desk.token === '') void goto('/login');
  });

  let logoutNote = $state<string | undefined>();
  const logout = async (): Promise<void> => {
    const r = await session.logout();
    desk.disconnect();
    regionDesks.closeAll();
    // 서버가 철회를 확인 못 했으면(503) 그렇다고 말한다 — 「로그아웃됐다」로 덮지 않는다.
    logoutNote = r.ok ? undefined : r.message;
    await goto('/login');
  };
  const disconnect = (): void => {
    desk.disconnect();
    regionDesks.closeAll();
    desk.token = '';
    void goto('/login');
  };

  // ── 브라우저에 기억하는 것(보는 사람 한 명의 편의) — 못 읽어도 기본값으로 선다 ──
  const remember = (k: string, v: string): void => { try { localStorage.setItem(k, v); } catch { /* 저장 못 해도 화면은 선다 */ } };
  const recall = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
  let theme = $state<'system' | 'dark' | 'light'>('system');
  let collapsed = $state(false);
  /**
   * 1024px 이하에서는 사이드바가 접힌다(시안 App Shell 「레이아웃 규칙」). 좁아질 때 접기만 하고, 사람이 펼치면 그대로 둔다.
   * 좁은 화면에서 바꾼 것은 기억하지 않는다 — 넓은 화면의 선택이 남는다.
   */
  let slim = $state(false);
  onMount(() => {
    const t = recall('bary.theme');
    if (t === 'dark' || t === 'light' || t === 'system') theme = t;
    collapsed = recall('bary.sidebar') === 'collapsed';
    const mq = window.matchMedia('(max-width: 1024px)');
    const fit = (): void => { slim = mq.matches; if (slim) collapsed = true; else collapsed = recall('bary.sidebar') === 'collapsed'; };
    fit();
    mq.addEventListener('change', fit);
    return () => { mq.removeEventListener('change', fit); };
  });
  $effect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    remember('bary.theme', theme);
  });
  $effect(() => { const c = collapsed; if (!untrack(() => slim)) remember('bary.sidebar', c ? 'collapsed' : 'open'); });

  /**
   * 실시간 연결 — 붙어 있으면 수신 중, 자격은 있는데 끊겼으면 재연결 중, 자격이 없으면 끊김.
   * 재연결 고리가 멈췄으면(401 등, `desk.retrying` 거짓) 「재연결 중」 이 아니라 끊김이다 — 사람이 다시 연결해야 한다.
   */
  /**
   * 전체 합산(전역에서 지역을 안 골랐다)이면 셸이 지역 스트림을 **늘** 잡는다 — 합산을 안 쓰는 화면(렌더된 설정 · 사람 · 내 계정)에서도
   * 상단 바의 연결 표시와 적용 대기 수가 살아 있어야 한다(운영 실측: 그 화면에서 「지역을 고르면 붙어요」 가 떴다).
   */
  const aggregateOn = $derived(scope.mode === 'global' && scope.region === undefined && (session.me !== undefined || desk.token !== ''));
  $effect(() => { if (aggregateOn) return regionDesks.acquire(); });
  // 셸 스트림이 없는 합산에서는 붙어 있는 지역 스트림이 하나라도 살아 있으면 「실시간 수신 중」 이다.
  const aggLive = $derived(aggregateOn && regionDesks.entries.some((e) => e.state === 'ok'));
  /** 적용 대기 수 — 합산이면 붙은 지역을 더한다(시안: 상단 「◐ 적용 대기 N」 과 배너가 지역 합계를 말한다). */
  const pendingTotal = $derived(aggregateOn
    ? regionDesks.entries.reduce((a, e) => a + (e.state === 'ok' ? e.desk.pendingCount : 0), 0)
    : desk.pendingCount);
  const connRaw = $derived(connStateOf({ live: desk.live || aggLive, signedIn: session.me !== undefined || desk.token !== '', hasStream: hasStream(scope) || regionDesks.active }));
  const conn = $derived(connRaw === 'reconnecting' && !desk.retrying ? 'down' as const : connRaw);
  const stalled = $derived(connRaw === 'reconnecting' && !desk.retrying);

  /** 클러스터면 이 노드 이름을 상단 바에 보인다. 붙을 때 한 번 묻는다. */
  let node = $state<string | undefined>();
  $effect(() => {
    if (!desk.live || scope.mode === 'global') return;
    void desk.clusterNodes().then((r) => {
      const b = r as { enabled?: boolean; self?: string } | undefined;
      node = b?.enabled === true && typeof b.self === 'string' ? b.self : undefined;
    });
  });

  /**
   * **팔로워면 읽기 전용이다** — 서버가 쓰기를 503 `not_leader` 로 막는다. 상태 스냅샷(`leader.isLeader`)을 받은 뒤에만 판정한다
   * (받기 전의 기본값은 거짓이라 모두 팔로워로 보인다). 리더의 이름 · 주소는 `/cluster/nodes` 에서 읽는다 — 상태의 `holder` 는
   * 이 노드 자신의 이름이라 리더가 아니다. 전역이면 고른 지역의 노드를 본다(같은 경로가 그 지역으로 간다).
   */
  const standby = $derived(desk.live && desk.head !== undefined && !desk.status.leader.isLeader);
  /** 리더 정보를 물은 곳(지역 이름, 지역 인스턴스면 ''). 같은 곳에서 팔로워인 동안 다시 묻지 않는다. 반응형이 아니다. */
  let askedLeader: string | undefined;
  $effect(() => {
    // 스냅샷마다 다시 본다 — 503 안전망이 팔로워로 본 뒤 상태가 리더라고 하면 풀어야 한다.
    void desk.status;
    const where = scope.region?.name ?? '';
    if (!standby) {
      askedLeader = undefined;
      if (untrack(() => scope.follower) !== undefined) scope.follow(undefined);
      return;
    }
    if (untrack(() => scope.follower) === undefined) scope.follow({});
    if (askedLeader === where) return;
    askedLeader = where;
    void desk.clusterNodes().then((r) => {
      if (!standby || askedLeader !== where) return;
      const b = r as { leader?: { name?: unknown }; nodes?: { name?: unknown; url?: unknown; role?: unknown }[] } | undefined;
      const name = typeof b?.leader?.name === 'string' ? b.leader.name : undefined;
      const lead = (b?.nodes ?? []).find((n) => (name !== undefined ? n.name === name : n.role === 'leader'));
      const leader = name ?? (typeof lead?.name === 'string' ? lead.name : undefined);
      const gui = typeof lead?.url === 'string' && lead.url !== '' ? lead.url : undefined;
      scope.follow({ ...(leader === undefined ? {} : { leader }), ...(gui === undefined ? {} : { gui }) });
    }).catch(() => undefined);
  });

  /**
   * 전역이면 사이드바 지역 상자가 지역 요약(`/api/v1/regions`)을 본다 — 지역 화면 · 적용 대기 화면이 읽는 것과 같다.
   * 적용 대기 수나 head 가 바뀌면 다시 묻는다(셸은 폴링하지 않는다 — `tests/unit/v10-open.test.ts`). 받으면 고른 지역의 연락 여부도 고친다(`scope.sync`).
   */
  let regions = $state<RegionSummary[]>([]);
  const signedIn = $derived(session.me !== undefined || desk.token !== '');
  const loadRegions = async (): Promise<void> => {
    const r = await fetch('/api/v1/regions', { credentials: 'same-origin', headers: desk.token === '' ? {} : { authorization: `Bearer ${desk.token}` } }).catch(() => undefined);
    if (r === undefined || !r.ok) return;
    regions = ((await r.json()) as { regions: RegionSummary[] }).regions;
    scope.sync(regions);
    regionDesks.sync(regions);
  };
  $effect(() => {
    if (scope.mode !== 'global' || !signedIn) return;
    void desk.pendingCount; void desk.head;
    // 전체 합산이면 셸의 desk 는 안 붙어 있다 — 지역마다 붙은 desk 의 대기 수 · head 가 바뀌면 다시 묻는다(폴링 아님).
    for (const e of regionDesks.entries) { void e.desk.pendingCount; void e.desk.head; }
    void loadRegions();
  });
  const pendingOf = (r: RegionSummary): number => {
    const p = (r.status as { pendingApply?: unknown } | undefined)?.pendingApply;
    return Array.isArray(p) ? p.length : 0;
  };
  const sideRegions = $derived<SideRegion[]>(regions.map((r) => {
    const current = r.name === scope.region?.name;
    // 합산 화면이 열려 있으면 지역마다 붙은 desk 가 더 새 값이다(연락 없음 · 대기 수).
    const e = regionDesks.active ? regionDesks.get(r.name) : undefined;
    const lost = current ? scope.lost : !r.reachable || e?.state === 'lost';
    const pending = current ? desk.pendingCount : e?.state === 'ok' ? e.desk.pendingCount : pendingOf(r);
    const pickable = r.reachable && r.auth === undefined;
    if (lost) return { name: r.name, current, pickable, tone: 'neutral', icon: '○', text: LOST_LABEL };
    if (r.auth === 'rejected') return { name: r.name, current, pickable, tone: 'danger', icon: '✕', text: '인증 거절' };
    return { name: r.name, current, pickable, tone: pending > 0 ? 'pending' : 'ok', icon: '●', text: pending > 0 ? `대기 ${pending}` : '' };
  }));
  /** 그 지역으로 좁힌다 — 셸의 desk 를 그 지역에 다시 붙인다. 못 고르는 지역(연락 없음 · 인증 거절)이면 거짓. */
  const narrow = (name: string): boolean => {
    const r = regions.find((x) => x.name === name);
    if (r === undefined || !r.reachable || r.auth !== undefined) return false;
    desk.disconnect();
    scope.choose(r);
    // **기다리지 않는다.** `connect` 는 스트림이 끊길 때까지 끝나지 않는다.
    void desk.connect();
    return true;
  };
  /** 사이드바에서 지역을 바꾼다(좁혀 보기) — 지역 화면의 「보기」 와 같다. 보던 화면은 그대로 두고, 지역 화면에 있었으면 첫 화면으로. */
  const pickRegion = (name: string): void => {
    if (narrow(name) && place === 'regions') void goto('/');
  };
  /**
   * 「◎ 전역 · 전체 합산」 — 좁혀 보기를 풀고 합산으로 돌아온다(시안 `regionList` 첫 줄). 셸의 desk 는 끊는다.
   * 보던 화면이 합산을 못 그리면 `needsRegion` 이 그 목록 · 지역 고르기로 보낸다.
   */
  const widen = (): void => {
    if (scope.mode !== 'global' || scope.region === undefined) return;
    desk.disconnect();
    scope.choose(undefined);
  };
  /**
   * `?region=<이름>` 으로 왔다 — 지역 요약을 받은 뒤 그 지역으로 좁히고 인자를 지운다(합산 행의 상세 · 수정 · 만들기, 새 탭 포함).
   * 못 고르는 지역이면 알리고 인자만 지운다 — 그러면 합산 화면 규칙(`needsRegion`)대로 간다.
   */
  $effect(() => {
    if (wanted === null || regions.length === 0) return;
    const name = wanted;
    if (untrack(() => scope.region?.name) !== name && !narrow(name)) {
      toast.fail(`${name} 지역을 열 수 없어요`, regions.some((x) => x.name === name) ? '이 지역과 지금 연결되지 않았어요.' : '모르는 지역이에요.');
    }
    const u = new URL(page.url);
    u.searchParams.delete(REGION_PARAM);
    void goto(`${u.pathname}${u.search}${u.hash}`, { replaceState: true, keepFocus: true, noScroll: true });
  });

  /** 적용 대기 배너 — 닫으면 건수가 바뀔 때까지 안 띄운다. 적용 대기 화면에서는 안 띄운다. */
  let dismissedAt = $state(-1);
  const showPending = $derived(pendingTotal > 0 && dismissedAt !== pendingTotal && place !== 'impact');

  /**
   * 사이드바 브랜드 아래 한 줄(시안 `regionLabel`) — 지역 인스턴스면 「<지역> · 이 인스턴스」, 전체 합산이면 「전역 · 전체 지역 합산」.
   * 좁혀 보면 「전역 · <지역>」 이다 — 그 지역 인스턴스가 아니라 전역이 그 지역으로 중계한다(시안은 지역으로 옮겨 간다).
   * 노드 이름은 상단 바의 노드 칩이 말한다.
   */
  const regionLabel = $derived(scope.mode === 'global'
    ? `전역 · ${scope.region?.name ?? '전체 지역 합산'}`
    : scope.self === undefined ? '이 인스턴스' : `${scope.self} · 이 인스턴스`);
  /** 브레드크럼 첫 칸은 보는 범위다 — 전역이면 「전역」, 아니면 「지역」(시안). 그 뒤는 `crumbsOf` 그대로다. */
  const crumbs = $derived([
    scope.mode === 'global' ? { label: '전역', href: '/regions' } : { label: '지역' },
    ...crumbsOf(place, detail ? decodeURIComponent(page.params['key'] ?? page.params['node'] ?? '') : undefined),
  ]);
  /** 대시보드는 전역이면 모든 지역을 합쳐 보인다 — 설명도 그렇게 말한다(시안). 나머지는 `PAGE_META` 그대로다. */
  const desc = $derived(place === 'dashboard' && scope.mode === 'global' ? '모든 지역의 상태를 확인해요.' : meta.desc);
</script>

{#if standalone}
  <!-- 시안 Login: 가운데 400px 기둥 — 로고 줄 · 카드(화면이 `AuthCard` 로 그린다) · 아래 링크 줄. -->
  <main class="solo">
    <div class="solo-col">
      <div class="solo-brand"><span class="solo-logo" aria-hidden="true">b</span><span>barycenter</span></div>
      {#if logoutNote !== undefined}<Banner tone="danger">{logoutNote}</Banner>{/if}
      {@render children()}
    </div>
  </main>
{:else}
  <div class="app">
    <div class="side">
      <Sidebar {place} bind:collapsed pending={pendingTotal} global={scope.mode === 'global'} {regionLabel}
        regionHref={scope.mode === 'global' ? '/regions' : undefined} regions={sideRegions} chosen={scope.region?.name} onpick={pickRegion} onwiden={widen} />
    </div>
    <div class="main">
      <TopBar {crumbs} monoLast={detail} {node} {standby} head={aggregateOn ? undefined : desk.head} {conn} pending={pendingTotal}
        user={session.me?.username} role={session.me?.role} mfa={session.me?.mfa.totp} bind:theme onlogout={() => { void logout(); }} ondisconnect={disconnect} />
      <!-- 배너 줄 — 시안 Pending banner 의 모양(상단 바 바로 아래 한 줄, 아래 테두리). 좁혀 보기 · 연결 끊김 줄은 시안에 없는 기능이라 같은 모양으로 둔다. -->
      {#if scope.mode === 'global' && scope.region !== undefined}
        <div class="bn" data-tone="info" role="status">
          <span class="bi" aria-hidden="true">◎</span>
          <span class="bt">전역 화면에서 <b>{scope.region.name}</b> 만 좁혀 보고 있어요. 바꾼 것은 그 지역으로 바로 가요.</span>
          <button type="button" class="ba" onclick={widen}>전체 합산으로</button>
        </div>
      {/if}
      {#if showPending}
        <div class="bn" data-tone="pending" role="status">
          <span class="bi" aria-hidden="true">◐</span>
          <span class="bt">적용 대기 중인 변경이 <b>{pendingTotal}건</b> 있어요.</span>
          <a class="ba" href="/change/pending">영향 확인</a>
          <button type="button" class="bx" aria-label="배너 닫기" onclick={() => { dismissedAt = pendingTotal; }}>✕</button>
        </div>
      {/if}
      {#if conn === 'reconnecting' && ready}
        <div class="bn" data-tone="danger" role="alert">
          <span class="bi" aria-hidden="true">✕</span>
          <span class="bt">실시간 연결이 끊겼어요. 헬스가 최신이 아닐 수 있어요. 다시 연결하는 중이에요.</span>
        </div>
      {:else if stalled && ready}
        <div class="bn" data-tone="danger" role="alert">
          <span class="bi" aria-hidden="true">✕</span>
          <span class="bt">실시간 연결이 끊겼어요. 헬스가 최신이 아닐 수 있어요.</span>
          <button type="button" class="ba" onclick={() => { void desk.connect(); }}>다시 연결해요</button>
        </div>
      {/if}
      <main class="content">
        {#if desk.error}<Banner tone="danger">{desk.error}</Banner>{/if}
        <!-- 콘솔: 상세에서도 페이지 머리(제목 · 설명)는 그대로 있고 만들기 버튼만 숨는다(`headActDisp: isList && !detail`). -->
        <PageHeader title={meta.title} {desc} actions={detail ? undefined : pageActions.snippet} />
        {@render children()}
      </main>
    </div>
  </div>
{/if}
<Toaster />
<StepUpDialog />

<style>
  .app { display: flex; min-height: 100vh; }
  .side { flex: none; }
  .main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  /* 시안 Content: padding 20px 24px · 세로 간격 16 */
  .content { flex: 1; min-width: 0; padding: 20px 24px; display: flex; flex-direction: column; gap: 16px; }

  /* 시안 Pending banner: 한 줄 · 아래 테두리 · 둥근 모서리 없음 */
  .bn {
    --c: var(--pending); --cb: var(--pending-bg);
    flex: none; display: flex; align-items: center; gap: 12px; padding: 8px 20px;
    background: var(--cb); border-bottom: 1px solid var(--c); font-size: 13px;
  }
  .bn[data-tone='info'] { --c: var(--info); --cb: var(--info-bg); }
  .bn[data-tone='danger'] { --c: var(--danger); --cb: var(--danger-bg); }
  .bi { color: var(--c); font-weight: 700; }
  .bt { flex: 1; min-width: 0; }
  .ba {
    height: 24px; padding: 0 10px; display: inline-flex; align-items: center; border: 1px solid var(--c); background: transparent;
    color: var(--c); border-radius: var(--r-sm); font-weight: 600; font-size: 12px; text-decoration: none; white-space: nowrap;
  }
  .ba:hover { color: var(--c); text-decoration: none; background-image: linear-gradient(var(--hov), var(--hov)); }
  .bx { border: 0; background: transparent; color: var(--tx3); padding: 2px 4px; }
  .bx:hover { background-image: linear-gradient(var(--hov), var(--hov)); }

  /* 시안 Login: place-items center · padding 24 · 기둥 400px · 간격 20 */
  .solo { min-height: 100vh; display: grid; place-items: center; padding: 24px; background: var(--bg-page); }
  .solo-col { width: 100%; max-width: 400px; display: flex; flex-direction: column; gap: 20px; }
  .solo-brand { display: flex; align-items: center; gap: 10px; justify-content: center; font-weight: 700; font-size: 20px; letter-spacing: -.2px; }
  .solo-logo {
    width: 32px; height: 32px; border-radius: var(--r-md); background: var(--accent); color: var(--accent-fg);
    display: grid; place-items: center; font-weight: 700; font-size: 16px; letter-spacing: 0;
  }

  @media (max-width: 860px) {
    .content { padding: 16px 16px 40px; }
    .bn { padding: 8px 16px; }
  }
</style>
