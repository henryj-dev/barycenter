<script lang="ts">
  /**
   * 백엔드 개요의 「트래픽」 (2026-11-20) — 마지막 구간의 율과 창 전체의 합.
   *
   * 백엔드는 그래프 탭이 없다. 숫자만 보인다. 풀의 「트래픽 경로」 탭에 풀 전체 그래프가 있다.
   */
  import { getContext } from 'svelte';
  import { OFF_TITLE, countText, msText, rateText, windowText, type TrafficSummaryBody } from '@web/traffic-view';
  import { Card } from '#lib/ui';
  import { accessLogHref } from '@web/access-log-view';
  import type { createDesk } from '#lib/desk.svelte.ts';

  let { key }: { key: string } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  let body = $state<TrafficSummaryBody | undefined>();
  let failed = $state(false);

  $effect(() => {
    void key;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (): Promise<void> => {
      const b = await desk.trafficSummary('backend').catch(() => undefined);
      if (stop) return;
      failed = b === undefined;
      if (b !== undefined) body = b;
      timer = setTimeout(() => { void load(); }, (b?.state === 'ok' ? Math.max(5, b.intervalS) : 15) * 1000);
    };
    void load();
    return () => { stop = true; if (timer !== undefined) clearTimeout(timer); };
  });

  const row = $derived(body?.state === 'ok' ? body.rows.find((r) => r.key === key) : undefined);
  const sub = $derived(body?.state === 'ok' ? windowText(body.window) : undefined);
</script>

<div class="wrap">
  <Card title="트래픽" {sub}>
    {#if body === undefined}
      <p class="m">{failed ? '트래픽을 읽지 못했어요.' : '읽는 중이에요.'}</p>
    {:else if body.state !== 'ok'}
      <p class="m">{OFF_TITLE[body.state]} — {body.reason}</p>
    {:else if row === undefined}
      <p class="m">이 창에서 이 백엔드로 간 요청이 없어요.</p>
    {:else}
      <dl>
        <div><dt>초당 요청</dt><dd>{rateText(row.last?.rps ?? 0)}</dd></div>
        <div><dt>초당 5xx</dt><dd>{rateText(row.last?.status.s5 ?? 0)}</dd></div>
        <div><dt>평균 시간</dt><dd>{row.window.avgMs === undefined ? '—' : msText(row.window.avgMs)}</dd></div>
        <div><dt>요청 수</dt><dd>{countText(row.window.requests)}</dd></div>
        <div><dt>5xx 수</dt><dd>{countText(row.window.errors5xx)}</dd></div>
      </dl>
    {/if}
    <!-- 기능 105 — 이 백엔드로 간 요청만 거른 액세스 로그 (2026-11-22). -->
    <p class="al"><a href={accessLogHref('backend', key)}>이 백엔드로 간 요청을 액세스 로그에서 봐요 →</a></p>
  </Card>
</div>

<style>
  .wrap { margin-top: 16px; }
  .m { margin: 0; color: var(--tx3); font: var(--t-small); }
  .al { margin: 12px 0 0; font: var(--t-small); }
  .al a { color: var(--accent); text-decoration: none; }
  .al a:hover { text-decoration: underline; }
  dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; margin: 0; }
  dt { font: var(--t-cap); color: var(--tx3); }
  dd { margin: 2px 0 0; font: 600 16px/22px var(--font); color: var(--tx); font-variant-numeric: tabular-nums; }
</style>
