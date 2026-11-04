<script lang="ts">
  /**
   * 리스너 만들기 1 / 2 — 프로토콜 고르기. 콘솔 시안 `drS1` 블록 그대로: 안내 한 줄과 프로토콜 다섯(이름 · 설명).
   * 고르면 그 프로토콜의 둘째 단계 주소로 간다(드로어 부제가 「2 / 2 · 설정」 으로 바뀐다).
   */
  import { getContext } from 'svelte';
  import Writable from '#lib/global/Writable.svelte';
  import { LISTENER_PROTOCOLS } from '@web/page';
  import type { createDesk } from '#lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  /** 시안 `protoNames` 글 그대로. */
  const TEXT: Record<(typeof LISTENER_PROTOCOLS)[number], { n: string; d: string }> = {
    http: { n: 'HTTP', d: 'HTTP 리버스 프록시예요. 호스트와 경로로 나눠요.' },
    https: { n: 'HTTPS', d: 'TLS를 종료하는 HTTP예요. 인증서와 TLS 정책이 필요해요.' },
    tcp: { n: 'TCP', d: 'TCP 프록시예요. 트래픽을 풀로 그대로 보내요.' },
    udp: { n: 'UDP', d: 'UDP 프록시예요. DNS, WireGuard, 게임에 쓰여요.' },
    tls_passthrough: { n: 'TLS 패스스루', d: 'TLS를 종료하지 않고 SNI로만 나눠요.' },
  };
</script>

{#if !desk.live}
  <p class="sub">연결하면 여기서 만들어요.</p>
{:else}
  <Writable>
    <div class="pick">
      <p class="sub">프로토콜을 먼저 선택해요. 프로토콜마다 입력 항목이 달라요.</p>
      {#each LISTENER_PROTOCOLS as p (p)}
        <a class="choice" href={`/traffic/listener/new/${p}`}><b>{TEXT[p].n}</b><span>{TEXT[p].d}</span></a>
      {/each}
    </div>
  </Writable>
{/if}

<style>
  /* 값은 시안 `drS1` 블록의 인라인 style 그대로다. */
  .pick { display: flex; flex-direction: column; gap: 8px; }
  .sub { margin: 0 0 4px; font-size: 13px; color: var(--tx2); }
  .choice {
    text-align: left; display: flex; flex-direction: column; gap: 2px; padding: 12px 14px;
    border: 1px solid var(--bd-strong); border-radius: var(--r-md); background: transparent; color: var(--tx); text-decoration: none;
  }
  .choice:hover { background-image: linear-gradient(var(--hov), var(--hov)); }
  .choice:focus-visible { outline: 2px solid var(--focus); outline-offset: 0; }
  .choice b { font-weight: 600; font-size: 14px; }
  .choice span { font-size: 12px; color: var(--tx3); }
</style>
