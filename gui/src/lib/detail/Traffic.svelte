<script lang="ts">
  /** 트래픽 경로 탭 — 들어온 요청이 라우트 → 풀 → 백엔드로 어떻게 가는가 (`trafficOf`). 한 경로가 카드 하나다. */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { RESOURCES, resourcePath, trafficOf, type ResourceKind } from '@web/resources';
  import { Badge, Card, FieldMessage } from '#lib/ui';
  import type { createDesk } from '#lib/desk.svelte.ts';

  let { kind }: { kind: ResourceKind } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const healthOf = (b: string): string => desk.health.find((h) => h.backendKey === b)?.state ?? 'unknown';
  const lines = $derived(trafficOf(desk.model, { kind, key }, healthOf));
</script>

{#if lines.length === 0}
  <FieldMessage>이 리소스로 들어오는 트래픽 경로가 없어요.</FieldMessage>
{:else}
  <div class="paths">
    {#each lines as line, i (i)}
      <Card>
        <div class="row">
          <code class="match">{line.match}</code>
          {#if line.route !== undefined && line.route.key !== key}
            <span class="muted">{RESOURCES[line.route.kind].label}</span>
            <a class="lnk" href={resourcePath(line.route.kind, line.route.key)}>{line.route.key}</a>
          {/if}
          <span class="arrow" aria-hidden="true">→</span>
          {#if line.target.kind === 'pool'}
            {#if line.target.missing}
              <Badge tone="danger">풀 {line.target.pool} — head 에 없어요</Badge>
            {:else}
              <a class="lnk" href={resourcePath('pool', line.target.pool)}>풀 {line.target.pool}</a>
              {#if line.target.backends.length === 0}<Badge tone="warn">백엔드가 없어요</Badge>{/if}
            {/if}
          {:else if line.target.kind === 'redirect'}
            <code>redirect {line.target.status} → {line.target.to}</code>
          {:else}
            <Badge tone="danger">거절{line.target.status === undefined ? ' — 연결을 끊어요' : ` ${line.target.status}`}</Badge>
          {/if}
        </div>
        {#if line.target.kind === 'pool' && !line.target.missing && line.target.backends.length > 0}
          <div class="backends">
            {#each line.target.backends as b (b.key)}
              <div class="be">
                <a class="lnk" href={resourcePath('backend', b.key)}>{b.key}</a>
                <code class="muted">{b.target} · w{b.weight}</code>
                {#if b.health === 'healthy'}<Badge tone="ok">정상</Badge>{:else if b.health === 'unhealthy'}<Badge tone="danger">비정상</Badge>{:else}<Badge>관측 없음</Badge>{/if}
              </div>
            {/each}
          </div>
        {/if}
      </Card>
    {/each}
    <FieldMessage>라우트는 우선순위 순서예요. 엔진이 실제로 보는 순서(매치 클래스)는 <a class="lnk" href="/traffic/route/http">HTTP 라우트</a> 목록이 정본이에요.</FieldMessage>
  </div>
{/if}

<style>
  .paths { display: flex; flex-direction: column; gap: 8px; max-width: 960px; }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; font: var(--t-body); }
  .match { min-width: 160px; }
  code { font-family: var(--mono); font-size: 13px; color: var(--tx); }
  .muted { color: var(--tx3); }
  .arrow { color: var(--tx3); }
  .backends { margin: 10px 0 0 16px; padding-left: 12px; border-left: 2px solid var(--bd); display: flex; flex-direction: column; gap: 6px; }
  .be { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; font: var(--t-small); }
  .lnk { color: var(--accent); font-family: var(--mono); text-decoration: none; }
  .lnk:hover { text-decoration: underline; }
</style>
