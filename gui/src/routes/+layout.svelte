<script lang="ts">
  /**
   * 앱 셸 (#126, 디자인 시안 「App Shell」) — 사이드바 · 상단 바 · 배너 · 페이지 머리 · 본문.
   *
   * 로그인 · 초대 수락 · 재설정 · 이메일 확인은 셸 없이 혼자 선다(시안). 로그인하지도, 토큰으로 붙지도
   * 않았으면 로그인 화면으로 보낸다 — 화면마다 「연결하면 …」 을 띄우는 대신 한 자리에서 막는다.
   * **로그인 상태에서는 토큰 칸을 어디에도 안 보인다.** 토큰 연결은 로그인 화면에 있다.
   */
  import { onMount, setContext } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { isDynamicGuiPath, pageOf } from '@web/page';
  import { PAGE_META, STANDALONE, crumbsOf } from '@web/nav';
  import { createDesk } from '#lib/desk.svelte.ts';
  import { createSession } from '#lib/account/session.svelte.ts';
  import StepUpDialog from '#lib/account/StepUpDialog.svelte';
  import { createScope } from '#lib/global/scope.svelte.ts';
  import { Banner, Toaster } from '#lib/ui';
  import Sidebar from '#lib/shell/Sidebar.svelte';
  import TopBar from '#lib/shell/TopBar.svelte';
  import PageHeader from '#lib/shell/PageHeader.svelte';
  // 글꼴은 빌드가 자기 자산으로 들인다 — 외부 출처를 열지 않는다(serve-gui 의 CSP).
  import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
  import '@fontsource-variable/jetbrains-mono';
  import '../app.css';
  import '#lib/detail/style.css';

  let { children } = $props();

  // 전역 모드면 읽기 경로가 고른 지역으로 간다 — desk 보다 먼저 만든다.
  const scope = createScope();
  setContext('scope', scope);
  const desk = createDesk(scope);
  setContext('desk', desk);
  // 사람 계정 — 쿠키 세션이면 `/me` 가 답한다. 토큰으로 붙었으면 비어 있다.
  const session = createSession();
  setContext('session', session);

  const place = $derived(pageOf(page.url.pathname));
  const standalone = $derived(STANDALONE.includes(place));
  /** 상세(key 가 든 주소)는 자기 머리(DetailHeader)를 그린다 — 페이지 머리를 겹쳐 그리지 않는다. */
  const detail = $derived(isDynamicGuiPath(page.url.pathname));
  const meta = $derived(PAGE_META[place]);

  /** 전역인데 지역을 안 골랐다 — 설정 화면은 볼 것이 없다. 계정 화면은 그대로 쓴다. */
  const needsRegion = $derived(
    scope.mode === 'global' && scope.region === undefined
      && !['regions', 'login', 'invite', 'account', 'users', 'reset', 'email', 'design'].includes(place),
  );
  $effect(() => { if (needsRegion) void goto('/regions'); });

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
    // 서버가 철회를 확인 못 했으면(503) 그렇다고 말한다 — 「로그아웃됐다」로 덮지 않는다.
    logoutNote = r.ok ? undefined : r.message;
    await goto('/login');
  };
  const disconnect = (): void => {
    desk.disconnect();
    desk.token = '';
    void goto('/login');
  };

  // ── 브라우저에 기억하는 것(보는 사람 한 명의 편의) — 못 읽어도 기본값으로 선다 ──
  const remember = (k: string, v: string): void => { try { localStorage.setItem(k, v); } catch { /* 저장 못 해도 화면은 선다 */ } };
  const recall = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
  let theme = $state<'system' | 'dark' | 'light'>('system');
  let collapsed = $state(false);
  let menuOpen = $state(false);
  onMount(() => {
    const t = recall('bary.theme');
    if (t === 'dark' || t === 'light' || t === 'system') theme = t;
    collapsed = recall('bary.sidebar') === 'collapsed';
  });
  $effect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    remember('bary.theme', theme);
  });
  $effect(() => { remember('bary.sidebar', collapsed ? 'collapsed' : 'open'); });
  // 좁은 화면에서 메뉴를 눌러 옮기면 사이드바를 닫는다.
  $effect(() => { void page.url.pathname; menuOpen = false; });

  /** 실시간 연결 — 붙어 있으면 수신 중, 자격은 있는데 끊겼으면 재연결 중, 자격이 없으면 끊김. */
  const conn = $derived(desk.live ? 'live' : (session.me !== undefined || desk.token !== '') ? 'reconnecting' : 'down');

  /** 클러스터면 이 노드 이름을 상단 바에 보인다. 붙을 때 한 번 묻는다. */
  let node = $state<string | undefined>();
  $effect(() => {
    if (!desk.live || scope.mode === 'global') return;
    void desk.clusterNodes().then((r) => {
      const b = r as { enabled?: boolean; self?: string } | undefined;
      node = b?.enabled === true && typeof b.self === 'string' ? b.self : undefined;
    });
  });

  /** 적용 대기 배너 — 닫으면 건수가 바뀔 때까지 안 띄운다. 적용 대기 화면에서는 안 띄운다. */
  let dismissedAt = $state(-1);
  const showPending = $derived(desk.pendingCount > 0 && dismissedAt !== desk.pendingCount && place !== 'impact');

  const regionLabel = $derived(scope.mode === 'global'
    ? `전역 · ${scope.region?.name ?? '지역을 고른다'}`
    : node !== undefined ? `${node} · 이 인스턴스` : '이 인스턴스');
  const crumbs = $derived(crumbsOf(place, detail ? decodeURIComponent(page.params['key'] ?? page.params['node'] ?? '') : undefined));
</script>

{#if standalone}
  <main class="solo">
    <div class="solo-brand"><span class="logo" aria-hidden="true">b</span>barycenter</div>
    <div class="solo-card">
      <PageHeader title={meta.title} desc={meta.desc} />
      {#if logoutNote !== undefined}<Banner tone="danger">{logoutNote}</Banner>{/if}
      {@render children()}
    </div>
  </main>
{:else}
  <div class="app" data-menu={menuOpen}>
    <div class="side">
      <Sidebar {place} bind:collapsed pending={desk.pendingCount} global={scope.mode === 'global'} {regionLabel}
        regionHref={scope.mode === 'global' ? '/regions' : undefined} />
    </div>
    {#if menuOpen}<button type="button" class="scrim" aria-label="메뉴 닫기" onclick={() => { menuOpen = false; }}></button>{/if}
    <div class="main">
      <TopBar {crumbs} {node} head={desk.head} {conn} pending={desk.pendingCount}
        user={session.me?.username} role={session.me?.role} bind:theme bind:menuOpen onlogout={() => { void logout(); }} ondisconnect={disconnect} />
      {#if scope.mode === 'global' && scope.region !== undefined}
        <div class="strip"><Banner tone="info" icon="◎">전역 화면은 읽기만 해요. 설정은 <b>{scope.region.name}</b> 의 GUI에서 바꿔요.</Banner></div>
      {/if}
      {#if showPending}
        <div class="strip">
          <Banner tone="pending" ondismiss={() => { dismissedAt = desk.pendingCount; }}>
            적용 대기 중인 변경이 <b>{desk.pendingCount}건</b> 있어요.
            {#snippet action()}<a class="banner-action" href="/change/pending">영향 확인</a>{/snippet}
          </Banner>
        </div>
      {/if}
      {#if conn === 'reconnecting' && ready}
        <div class="strip"><Banner tone="danger">실시간 연결이 끊겼어요. 헬스가 최신이 아닐 수 있어요. 다시 연결하는 중이에요.</Banner></div>
      {/if}
      <main class="content">
        {#if desk.error}<Banner tone="danger">{desk.error}</Banner>{/if}
        {#if !detail}<PageHeader title={meta.title} desc={meta.desc} />{/if}
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
  .strip { padding: 8px 20px 0; }
  .content { flex: 1; min-width: 0; padding: 20px 24px 48px; display: flex; flex-direction: column; gap: 16px; }
  .scrim { display: none; }

  .solo { min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 48px 16px; gap: 20px; }
  .solo-brand { display: flex; align-items: center; gap: 10px; font: 700 16px/1 var(--font); }
  .logo { width: 28px; height: 28px; border-radius: var(--r-md); background: var(--accent); color: var(--accent-fg); display: grid; place-items: center; font: 700 14px/1 var(--font); }
  .solo-card {
    width: 100%; max-width: 440px; background: var(--bg-panel); border: 1px solid var(--bd); border-radius: var(--r-lg);
    padding: 24px; display: flex; flex-direction: column; gap: 16px;
  }

  /* 좁은 화면 — 사이드바는 메뉴 버튼으로 덮어 연다 */
  @media (max-width: 860px) {
    .side { position: fixed; inset: 0 auto 0 0; z-index: var(--z-drawer); transform: translateX(-100%); transition: transform var(--dur) var(--ease); }
    .app[data-menu='true'] .side { transform: none; }
    .scrim { display: block; position: fixed; inset: 0; z-index: calc(var(--z-drawer) - 1); background: rgba(0, 0, 0, .4); border: 0; }
    .content { padding: 16px 16px 40px; }
    .strip { padding: 8px 16px 0; }
  }
</style>
