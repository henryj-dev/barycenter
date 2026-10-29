<script lang="ts">
  import { setContext } from 'svelte';
  import { page } from '$app/state';
  import { pageOf } from '@web/page';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { createDesk } from '#lib/desk.svelte.ts';
  import { createSession } from '#lib/account/session.svelte.ts';
  import StepUpDialog from '#lib/account/StepUpDialog.svelte';
  import { createScope } from '#lib/global/scope.svelte.ts';
  import '../app.css';

  let { children } = $props();

  // 전역 모드면 읽기 경로가 고른 지역으로 간다 — desk 보다 먼저 만든다.
  const scope = createScope();
  setContext('scope', scope);
  const desk = createDesk(scope);
  setContext('desk', desk);
  /** 전역인데 지역을 안 골랐다 — 설정 화면은 볼 것이 없다. 계정 화면은 그대로 쓴다. */
  const needsRegion = $derived(
    scope.mode === 'global' && scope.region === undefined
      && !['regions', 'login', 'invite', 'account', 'users', 'reset', 'email'].includes(place),
  );
  $effect(() => { if (needsRegion) void goto('/regions'); });
  // 사람 계정 — 쿠키 세션이면 `/me` 가 답한다. 토큰으로 붙었으면 비어 있다.
  const session = createSession();
  setContext('session', session);
  let logoutNote = $state<string | undefined>();
  onMount(async () => {
    await scope.detect();
    await session.refresh();
    // 전역은 지역을 고른 뒤에 붙는다(`/regions` 가 desk.connect 를 부른다).
    if (session.me !== undefined && scope.mode !== 'global') void desk.connect();
  });
  const logout = async (): Promise<void> => {
    const r = await session.logout();
    desk.disconnect();
    // 서버가 철회를 확인 못 했으면(503) 그렇다고 말한다 — 「로그아웃됐다」로 덮지 않는다.
    logoutNote = r.ok ? undefined : r.message;
    await goto('/login');
  };
  const place = $derived(pageOf(page.url.pathname));

  const connect = (): void => {
    void desk.connect();
  };

  const lede: Record<string, { h: string; p: string }> = {
    listeners: {
      h: '열려 있는 포트',
      p: 'head 모델이다. 포트를 여는 것은 commit 이다. 패스스루는 인증서를 제시하지 않는다. HTTPS 는 자료 있는 인증서와 TLS 정책이 필요하다.',
    },
    pools: {
      h: '풀이 받는 것',
      p: '빈 풀은 저장되지 않는다. source_ip_hash 는 hashKey 가 없다. 키는 소스 IP 다.',
    },
    routes: {
      h: '엔진이 보는 순서',
      p: '호스트 라우트를 넣는 것은 commit 이다. 패스스루 reject 는 SNI 를 끊는다. HTTP 상태 코드는 없다.',
    },
    certificates: {
      h: '언제 죽는가',
      p: '자료를 넣는 것은 commit 이다. HTTPS 호스트는 SNI 바인딩이 있어야 plan 이 된다.',
    },
    status: {
      h: '네 갈래',
      p: '커밋과 게시와 리더는 다르다. 스탠바이가 리더처럼 보이면 apply 가 왜 503 인지 모른다.',
    },
    rendered: {
      h: '엔진이 받을 것',
      p: 'nginx.conf 는 산출물이다. head 리비전을 렌더한 것이다. 폴링하지 않는다.',
    },
    audit: {
      h: '누가 무엇을 했는가',
      p: '로그다. 모델이 아니다. 폴링하지 않는다.',
    },
    impact: {
      h: '이 적용이 하는 일',
      p: '저장과 적용은 다르다. 여기 있는 것은 이미 커밋된 plan 이 트래픽에 닿을 때 생기는 영향이다.',
    },
    login: {
      h: '로그인',
      p: '계정으로 들어오거나(관리자는 인증 앱 코드까지), IdP 로 들어오거나, 해시 토큰을 위 칸에 넣는다.',
    },
    invite: {
      h: '링크로 들어왔다',
      p: '초대·첫 관리자·복구 링크는 한 번만 쓴다. 관리자는 인증 앱 등록까지 마쳐야 끝난다.',
    },
    account: {
      h: '내 계정',
      p: '비밀번호·인증 앱·열린 세션. 로그아웃은 서버에서 세션을 끊는다.',
    },
    reset: {
      h: '비밀번호 재설정',
      p: '계정 이메일로 링크를 받는다. 재설정은 인증 앱을 풀지 않는다.',
    },
    email: {
      h: '이메일 확인',
      p: '새 주소로 간 링크를 열면 바뀐다.',
    },
    regions: {
      h: '지역',
      p: '전역 화면은 읽기만 한다. 닿지 않는 지역은 「모른다」로 보인다. 설정은 그 지역의 GUI 에서 바꾼다.',
    },
    users: {
      h: '사람과 초대',
      p: '공개 가입은 없다. 역할 하향·정지는 그 사람의 다음 요청부터 막는다. 마지막 관리자는 강등·정지할 수 없다.',
    },
  };
</script>

<div class="page">
  <header class="mast">
    <p class="eyebrow">barycenter</p>
    <nav class="nav" aria-label="화면">
      {#if scope.mode === 'global'}
        <a href="/regions" aria-current={place === 'regions' ? 'page' : undefined}>
          지역{scope.region !== undefined ? ` · ${scope.region.name}` : ''}
        </a>
      {/if}
      <a href="/" aria-current={place === 'impact' ? 'page' : undefined}>영향</a>
      <a href="/listeners" aria-current={place === 'listeners' ? 'page' : undefined}>리스너</a>
      <a href="/pools" aria-current={place === 'pools' ? 'page' : undefined}>풀</a>
      <a href="/routes" aria-current={place === 'routes' ? 'page' : undefined}>라우트</a>
      <a href="/certificates" aria-current={place === 'certificates' ? 'page' : undefined}>인증서</a>
      <a href="/status" aria-current={place === 'status' ? 'page' : undefined}>상태</a>
      <a href="/rendered" aria-current={place === 'rendered' ? 'page' : undefined}>산출물</a>
      <a href="/audit" aria-current={place === 'audit' ? 'page' : undefined}>기록</a>
      {#if session.me === undefined}
        <a href="/login" aria-current={place === 'login' ? 'page' : undefined}>로그인</a>
      {:else}
        <a href="/account" aria-current={place === 'account' ? 'page' : undefined}>{session.me.username}</a>
        {#if session.isAdmin}<a href="/users" aria-current={place === 'users' ? 'page' : undefined}>사람</a>{/if}
        <button type="button" class="link" onclick={() => { void logout(); }}>로그아웃</button>
      {/if}
    </nav>
    {#if logoutNote !== undefined}<p class="err" role="alert">{logoutNote}</p>{/if}
    <h1>{lede[place]?.h}</h1>
    <p class="lede">{lede[place]?.p}</p>
  </header>

  <form class="dock" onsubmit={(e) => { e.preventDefault(); connect(); }}>
    <label>
      <span>토큰</span>
      <input type="password" autocomplete="off" bind:value={desk.token} placeholder="Bearer 토큰" />
    </label>
    <button type="submit">{desk.live ? '다시 연결' : '연결'}</button>
    <p class="pulse" data-live={desk.live}>{desk.live ? '수신 중' : '끊김'}</p>
  </form>

  {#if desk.error}
    <p class="err" role="alert">{desk.error}</p>
  {/if}

  <p class="head">
    {#if desk.head !== undefined}
      head <span class="mono">r{desk.head}</span>
    {:else}
      아직 상태를 받지 않았다
    {/if}
  </p>

  {@render children()}
  <StepUpDialog />
</div>

<style>
  .page {
    max-width: 40rem;
    margin: 0 auto;
    padding: 2.5rem 1.25rem 4rem;
  }
  .eyebrow {
    font-family: var(--data);
    font-size: 0.75rem;
    letter-spacing: 0.16em;
    text-transform: lowercase;
    color: var(--mute);
    margin: 0 0 0.4rem;
  }
  .nav { display: flex; flex-wrap: wrap; gap: 1rem; margin: 0 0 1.1rem; }
  .nav a {
    font-family: var(--data);
    font-size: 0.8rem;
    color: var(--mute);
    text-decoration: none;
    border-bottom: 1px solid transparent;
  }
  .nav .link {
    font-family: var(--data); font-size: 0.8rem; color: var(--mute);
    background: none; border: none; padding: 0; cursor: pointer;
  }
  .nav a[aria-current='page'] {
    color: var(--ink);
    border-bottom-color: var(--ember);
  }
  h1 {
    font-family: var(--display);
    font-weight: 560;
    font-size: 2.1rem;
    line-height: 1.15;
    margin: 0 0 0.6rem;
  }
  .lede { color: var(--mute); margin: 0 0 2rem; }
  .dock {
    display: grid;
    grid-template-columns: 1fr auto auto;
    gap: 0.6rem;
    align-items: end;
    margin-bottom: 1.25rem;
  }
  label { display: flex; flex-direction: column; gap: 0.25rem; }
  label span { font-size: 0.8rem; color: var(--mute); }
  input {
    background: var(--plate);
    border: 1px solid var(--rule);
    color: var(--ink);
    padding: 0.45rem 0.6rem;
  }
  button {
    background: var(--plate);
    border: 1px solid var(--rule);
    color: var(--ink);
    padding: 0.5rem 0.85rem;
    cursor: pointer;
  }
  .pulse { margin: 0; font-size: 0.8rem; color: var(--mute); padding-bottom: 0.35rem; }
  .pulse[data-live='true'] { color: var(--moss); }
  .err { color: var(--ember); }
  .head { font-family: var(--data); font-size: 0.9rem; color: var(--mute); }
  .mono { font-family: var(--data); }
  @media (max-width: 640px) {
    .dock { grid-template-columns: 1fr; }
  }
</style>
