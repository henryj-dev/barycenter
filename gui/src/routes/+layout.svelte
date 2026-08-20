<script lang="ts">
  import { setContext } from 'svelte';
  import { page } from '$app/state';
  import { pageOf } from '@web/page';
  import { createDesk } from '$lib/desk.svelte.ts';
  import '../app.css';

  let { children } = $props();

  const desk = createDesk();
  setContext('desk', desk);
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
  };
</script>

<div class="page">
  <header class="mast">
    <p class="eyebrow">barycenter</p>
    <nav class="nav" aria-label="화면">
      <a href="/" aria-current={place === 'impact' ? 'page' : undefined}>영향</a>
      <a href="/listeners" aria-current={place === 'listeners' ? 'page' : undefined}>리스너</a>
      <a href="/pools" aria-current={place === 'pools' ? 'page' : undefined}>풀</a>
      <a href="/routes" aria-current={place === 'routes' ? 'page' : undefined}>라우트</a>
      <a href="/certificates" aria-current={place === 'certificates' ? 'page' : undefined}>인증서</a>
      <a href="/status" aria-current={place === 'status' ? 'page' : undefined}>상태</a>
      <a href="/rendered" aria-current={place === 'rendered' ? 'page' : undefined}>산출물</a>
      <a href="/audit" aria-current={place === 'audit' ? 'page' : undefined}>기록</a>
    </nav>
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
