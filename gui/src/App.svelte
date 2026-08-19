<script lang="ts">
  import { pageOf } from '@web/page';
  import Impact from './lib/Impact.svelte';
  import Listeners from './lib/Listeners.svelte';
  import Pools from './lib/Pools.svelte';
  import Routes from './lib/Routes.svelte';
  import Certs from './lib/Certs.svelte';
  import Status from './lib/Status.svelte';
  import Rendered from './lib/Rendered.svelte';
  import { createDesk } from './lib/desk.svelte.ts';

  const desk = createDesk();
  let path = $state(location.pathname);
  const page = $derived(pageOf(path));

  const connect = (): void => {
    void desk.connect();
  };

  const apply = (): void => {
    void desk.apply();
  };

  const go = (to: string): void => {
    history.pushState({}, '', to);
    path = to;
  };

  $effect(() => {
    const onPop = (): void => {
      path = location.pathname;
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  });
</script>

<div class="page">
  <header class="mast">
    <p class="eyebrow">barycenter</p>
    <nav class="nav" aria-label="화면">
      <a
        href="/"
        aria-current={page === 'impact' ? 'page' : undefined}
        onclick={(e) => { e.preventDefault(); go('/'); }}
      >영향</a>
      <a
        href="/listeners"
        aria-current={page === 'listeners' ? 'page' : undefined}
        onclick={(e) => { e.preventDefault(); go('/listeners'); }}
      >리스너</a>
      <a
        href="/pools"
        aria-current={page === 'pools' ? 'page' : undefined}
        onclick={(e) => { e.preventDefault(); go('/pools'); }}
      >풀</a>
      <a
        href="/routes"
        aria-current={page === 'routes' ? 'page' : undefined}
        onclick={(e) => { e.preventDefault(); go('/routes'); }}
      >라우트</a>
      <a
        href="/certificates"
        aria-current={page === 'certificates' ? 'page' : undefined}
        onclick={(e) => { e.preventDefault(); go('/certificates'); }}
      >인증서</a>
      <a
        href="/status"
        aria-current={page === 'status' ? 'page' : undefined}
        onclick={(e) => { e.preventDefault(); go('/status'); }}
      >상태</a>
      <a
        href="/rendered"
        aria-current={page === 'rendered' ? 'page' : undefined}
        onclick={(e) => { e.preventDefault(); go('/rendered'); }}
      >산출물</a>
    </nav>
    {#if page === 'listeners'}
      <h1>열려 있는 포트</h1>
      <p class="lede">head 모델이다. 포트를 여는 것은 commit 이다. 패스스루는 인증서를 제시하지 않는다. HTTPS 는 자료 있는 인증서와 TLS 정책이 필요하다.</p>
    {:else if page === 'pools'}
      <h1>풀이 받는 것</h1>
      <p class="lede">빈 풀은 저장되지 않는다. source_ip_hash 는 hashKey 가 없다. 키는 소스 IP 다.</p>
    {:else if page === 'routes'}
      <h1>엔진이 보는 순서</h1>
      <p class="lede">호스트 라우트를 넣는 것은 commit 이다. 패스스루 reject 는 SNI 를 끊는다. HTTP 상태 코드는 없다.</p>
    {:else if page === 'certificates'}
      <h1>언제 죽는가</h1>
      <p class="lede">자료를 넣는 것은 commit 이다. HTTPS 호스트는 SNI 바인딩이 있어야 plan 이 된다.</p>
    {:else if page === 'status'}
      <h1>네 갈래</h1>
      <p class="lede">커밋과 게시와 리더는 다르다. 스탠바이가 리더처럼 보이면 apply 가 왜 503 인지 모른다.</p>
    {:else if page === 'rendered'}
      <h1>엔진이 받을 것</h1>
      <p class="lede">nginx.conf 는 산출물이다. head 리비전을 렌더한 것이다. 폴링하지 않는다.</p>
    {:else}
      <h1>이 적용이 하는 일</h1>
      <p class="lede">저장과 적용은 다르다. 여기 있는 것은 이미 커밋된 plan 이 트래픽에 닿을 때 생기는 영향이다.</p>
    {/if}
  </header>

  <form class="dock" onsubmit={(e) => { e.preventDefault(); connect(); }}>
    <label>
      <span>토큰</span>
      <input
        type="password"
        autocomplete="off"
        bind:value={desk.token}
        placeholder="Bearer 토큰"
      />
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

  {#if page === 'listeners'}
    <Listeners
      view={desk.listeners}
      live={desk.live}
      editing={desk.editing}
      pools={desk.pools.rows.filter((p) => p.protocolClass === 'http').map((p) => p.key)}
      tcpPools={desk.pools.rows.filter((p) => p.protocolClass === 'tcp').map((p) => p.key)}
      udpPools={desk.pools.rows.filter((p) => p.protocolClass === 'udp').map((p) => p.key)}
      withdraw={(key) => {
        void desk.withdraw('listener', key).then((ok) => { if (ok) go('/'); });
      }}
      insert={(key, bind, port, pool) => {
        void desk.insertHttpListener(key, { bind, port, pool }).then((ok) => { if (ok) go('/'); });
      }}
      insertTcp={(key, bind, port, pool) => {
        void desk.insertTcpListener(key, { bind, port, pool }).then((ok) => { if (ok) go('/'); });
      }}
      insertPassthrough={(key, bind, port, pool) => {
        void desk.insertPassthroughListener(
          key,
          pool === undefined ? { bind, port } : { bind, port, pool },
        ).then((ok) => { if (ok) go('/'); });
      }}
      insertUdp={(key, bind, port, pool, preset) => {
        void desk.insertUdpListener(key, { bind, port, pool, preset }).then((ok) => { if (ok) go('/'); });
      }}
      policies={desk.policies}
      certificates={desk.certs.rows.filter((c) => c.hasMaterial).map((c) => c.key)}
      insertPolicy={(key, minVersion) => {
        void desk.insertTlsPolicy(key, minVersion).then((ok) => { if (ok) go('/'); });
      }}
      insertHttps={(key, bind, port, pool, policy, certificate) => {
        void desk.insertHttpsListener(key, { bind, port, pool, policy, certificate }).then((ok) => { if (ok) go('/'); });
      }}
    />
  {:else if page === 'pools'}
    <Pools
      view={desk.pools}
      live={desk.live}
      editing={desk.editing}
      withdraw={(key) => {
        void desk.withdraw('backend', key).then((ok) => { if (ok) go('/'); });
      }}
      insert={(pool, key, host, port) => {
        void desk.insertBackend(key, { pool, host, port }).then((ok) => { if (ok) go('/'); });
      }}
      openPool={(input) => {
        void desk.insertPool(input).then((ok) => { if (ok) go('/'); });
      }}
      openHashPool={(input) => {
        void desk.insertHashPool(input).then((ok) => { if (ok) go('/'); });
      }}
      openSourceIpHashPool={(input) => {
        void desk.insertSourceIpHashPool(input).then((ok) => { if (ok) go('/'); });
      }}
    />
  {:else if page === 'routes'}
    <Routes
      view={desk.routes}
      live={desk.live}
      editing={desk.editing}
      listeners={desk.listeners.rows
        .filter((l) => l.mark !== 'leave' && (l.protocol === 'http' || l.protocol === 'https'))
        .map((l) => l.key)}
      pools={desk.pools.rows.filter((p) => p.protocolClass === 'http').map((p) => p.key)}
      ptListeners={desk.listeners.rows
        .filter((l) => l.mark !== 'leave' && l.protocol === 'tls_passthrough')
        .map((l) => l.key)}
      tcpPools={desk.pools.rows.filter((p) => p.protocolClass === 'tcp').map((p) => p.key)}
      withdraw={(key) => {
        void desk.withdraw('httpRoute', key).then((ok) => { if (ok) go('/'); });
      }}
      withdrawPt={(key) => {
        void desk.withdraw('passthroughRoute', key).then((ok) => { if (ok) go('/'); });
      }}
      insert={(input) => {
        void desk.insertHttpRoute(input).then((ok) => { if (ok) go('/'); });
      }}
      insertRedirect={(input) => {
        void desk.insertHttpRedirect(input).then((ok) => { if (ok) go('/'); });
      }}
      insertReject={(input) => {
        void desk.insertHttpReject(input).then((ok) => { if (ok) go('/'); });
      }}
      insertPt={(input) => {
        void desk.insertPassthroughRoute(input).then((ok) => { if (ok) go('/'); });
      }}
      insertPtReject={(input) => {
        void desk.insertPassthroughReject(input).then((ok) => { if (ok) go('/'); });
      }}
    />
  {:else if page === 'certificates'}
    <Certs
      view={desk.certs}
      live={desk.live}
      editing={desk.editing}
      insert={(key, fullchain, privkey) => {
        void desk.insertCertificate(key, { fullchain, privkey }).then((ok) => { if (ok) go('/'); });
      }}
      listeners={desk.listeners.rows
        .filter((l) => l.mark !== 'leave' && l.protocol === 'https')
        .map((l) => l.key)}
      certificates={desk.certs.rows.filter((c) => c.hasMaterial).map((c) => c.key)}
      bindings={desk.bindings}
      insertSni={(input) => {
        void desk.insertSniBinding(input).then((ok) => { if (ok) go('/'); });
      }}
      withdrawSni={(key) => {
        void desk.withdraw('sniBinding', key).then((ok) => { if (ok) go('/'); });
      }}
    />
  {:else if page === 'status'}
    <Status view={desk.status} live={desk.live} />
  {:else if page === 'rendered'}
    <Rendered view={desk.rendered} live={desk.live} />
  {:else if desk.view}
    <Impact view={desk.view} applying={desk.applying} apply={apply} />
  {:else if desk.live}
    <p class="empty">커밋됐지만 적용되지 않은 plan 이 없다. <code>bary import</code> 또는 <code>changeset commit</code> 뒤에 여기로 온다.</p>
  {/if}
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
  .empty { color: var(--mute); }
  .empty code { font-family: var(--data); font-size: 0.85em; }
  @media (max-width: 640px) {
    .dock { grid-template-columns: 1fr; }
  }
</style>
