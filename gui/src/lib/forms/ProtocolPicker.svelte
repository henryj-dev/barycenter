<script lang="ts">
  /** 리스너 만들기 1 / 2 — 프로토콜 고르기 (시안). 고르면 그 프로토콜의 둘째 단계 주소로 간다. */
  import { getContext } from 'svelte';
  import { Card } from '#lib/ui';
  import Writable from '#lib/global/Writable.svelte';
  import { LISTENER_PROTOCOLS } from '@web/page';
  import type { createDesk } from '#lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const TEXT: Record<(typeof LISTENER_PROTOCOLS)[number], { n: string; d: string }> = {
    http: { n: 'HTTP', d: '호스트와 경로로 라우트를 나눠요. 평문이에요.' },
    https: { n: 'HTTPS', d: '인증서와 TLS 정책이 필요해요. SNI 로 호스트를 갈라요.' },
    tcp: { n: 'TCP', d: '바이트를 그대로 풀로 넘겨요.' },
    udp: { n: 'UDP', d: 'DNS · WireGuard · 게임 프리셋이 있어요.' },
    tls_passthrough: { n: 'TLS 패스스루', d: '복호화하지 않아요. SNI 만 보고 풀을 골라요.' },
  };
</script>

{#if !desk.live}
  <p class="sub">연결하면 여기서 만들어요.</p>
{:else}
  <Writable>
    <div class="pick">
      <p class="sub">1 / 2 · 프로토콜을 먼저 골라요. 프로토콜마다 넣는 항목이 달라요.</p>
      {#each LISTENER_PROTOCOLS as p (p)}
        <a class="choice" href={`/traffic/listener/new/${p}`}><b>{TEXT[p].n}</b><span>{TEXT[p].d}</span></a>
      {/each}
      <Card>
        <div class="quick">
          <span>URL 하나로 리스너 · 풀 · 백엔드를 한 번에 만들어요.</span>
          <a href="/traffic/listener/new/quick">빠른 프록시 만들기 →</a>
        </div>
      </Card>
    </div>
  </Writable>
{/if}

<style>
  .pick { max-width: 560px; display: flex; flex-direction: column; gap: 8px; }
  .sub { margin: 0 0 4px; font: var(--t-small); color: var(--tx2); }
  .choice {
    display: flex; flex-direction: column; gap: 2px; padding: 12px 14px;
    border: 1px solid var(--bd-strong); border-radius: var(--r-md); color: var(--tx); text-decoration: none;
    transition: border-color var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease);
  }
  .choice:hover { border-color: var(--accent); background: var(--bg-hover); }
  .choice:focus-visible { outline: 2px solid var(--focus); outline-offset: 0; }
  .choice b { font: 600 14px/20px var(--font); }
  .choice span { font: var(--t-cap); color: var(--tx3); }
  .quick { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; font: var(--t-small); color: var(--tx2); }
  .quick a { color: var(--accent); font-weight: 500; }
</style>
