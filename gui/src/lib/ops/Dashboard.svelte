<script lang="ts">
  /**
   * 대시보드 — `/`. 숫자는 이미 받은 head 모델 · 헬스 · 상태에서 센다 — 따로 묻지 않는다.
   * 맨 위는 「적용 대기가 있나」 다. 그 아래 리소스 수, 그 아래 주의할 것(비정상 백엔드 · 만료 임박 인증서).
   */
  import { getContext } from 'svelte';
  import { itemsOf } from '@web/resources';
  import { Badge, Banner, Button, Card, FieldMessage, Skeleton } from '#lib/ui';
  import type { createDesk } from '#lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const backends = $derived(itemsOf(desk.model, 'backend').map((b) => String(b['key'])));
  const unhealthy = $derived(backends.filter((k) => desk.health.find((h) => h.backendKey === k)?.state === 'unhealthy'));
  const idle = $derived(backends.filter((k) => desk.traffic.get(k)?.receivingTraffic === false));
  const certSoon = $derived(desk.certs.rows.filter((c) => !c.hasMaterial || (c.expiresInDays !== undefined && c.expiresInDays < 30)));
  const cards = $derived([
    { href: '/traffic/listener', label: '리스너', n: desk.listeners.rows.length },
    { href: '/traffic/route/http', label: '라우트', n: desk.routes.order.length + desk.routes.passthrough.length },
    { href: '/traffic/pool', label: '풀', n: desk.pools.rows.length },
    { href: '/traffic/backend', label: '백엔드', n: backends.length },
    { href: '/tls/certificate', label: '인증서', n: desk.certs.rows.length },
  ]);
</script>

{#if !desk.live}
  <Skeleton height="200px" label="연결하는 중" />
{:else}
  <div class="dash">
    {#if desk.view !== undefined}
      <Banner tone="pending">
        적용 대기가 있어요. 커밋했지만 트래픽에 아직 안 걸렸어요.
        {#snippet action()}<Button size="sm" variant="primary" href="/change/pending">영향 보고 적용하기</Button>{/snippet}
      </Banner>
    {:else}
      <Banner tone="ok">적용 대기가 없어요. head{desk.head === undefined ? '' : ` r${desk.head}`} 가 트래픽에 걸려 있어요.</Banner>
    {/if}

    <div class="grid">
      {#each cards as c (c.href)}
        <a class="stat" href={c.href}><span class="n">{c.n}</span><span class="l">{c.label}</span></a>
      {/each}
    </div>

    <Card title="주의할 것">
      {#if unhealthy.length === 0 && idle.length === 0 && certSoon.length === 0 && !desk.status.unfinished}
        <FieldMessage tone="ok">지금 주의할 것이 없어요.</FieldMessage>
      {:else}
        <ul class="watch">
          {#if desk.status.unfinished}
            <li><Badge tone="warn">미완 전환</Badge><a href="/ops/status">상태 화면에서 이어받아요</a></li>
          {/if}
          {#each unhealthy as k (k)}
            <li><Badge tone="danger">비정상</Badge><a class="mono" href={`/traffic/backend/${encodeURIComponent(k)}`}>{k}</a></li>
          {/each}
          {#each idle.filter((k) => !unhealthy.includes(k)) as k (k)}
            <li><Badge tone="warn">트래픽 없음</Badge><a class="mono" href={`/traffic/backend/${encodeURIComponent(k)}`}>{k}</a></li>
          {/each}
          {#each certSoon as c (c.key)}
            <li>
              {#if !c.hasMaterial}<Badge tone="danger">자료 없음</Badge>
              {:else if (c.expiresInDays ?? 0) < 0}<Badge tone="danger">만료됨</Badge>
              {:else}<Badge tone="warn">{c.expiresInDays}일 뒤 만료</Badge>{/if}
              <a class="mono" href={`/tls/certificate/${encodeURIComponent(c.key)}`}>{c.key}</a>
            </li>
          {/each}
        </ul>
      {/if}
    </Card>
  </div>
{/if}

<style>
  .dash { display: flex; flex-direction: column; gap: 16px; max-width: 1080px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; }
  .stat {
    display: flex; flex-direction: column; gap: 4px; padding: 14px 16px;
    background: var(--bg-panel); border: 1px solid var(--bd); border-radius: var(--r-lg);
    color: var(--tx); text-decoration: none; transition: border-color var(--dur-fast) var(--ease);
  }
  .stat:hover { border-color: var(--accent); }
  .stat:focus-visible { outline: 2px solid var(--focus); outline-offset: 0; }
  .n { font: 600 24px/32px var(--mono); }
  .l { font: var(--t-small); color: var(--tx2); }
  .watch { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .watch li { display: flex; gap: 10px; align-items: center; font: var(--t-small); }
  .watch a { color: var(--accent); text-decoration: none; }
  .watch a:hover { text-decoration: underline; }
  .mono { font-family: var(--mono); }
</style>
