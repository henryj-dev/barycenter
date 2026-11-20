<script lang="ts">
  /**
   * 대시보드 「리스너별 트래픽」 (2026-11-20) — 마지막 구간의 초당 수가 큰 순서로 다섯.
   *
   * 막대는 크기 하나만 말한다(한 색). 숫자는 막대 옆에 글자로 있다 — 색으로만 읽게 하지 않는다.
   */
  import { getContext } from 'svelte';
  import { resourcePath } from '@web/resources';
  import { OFF_TITLE, rateText, windowText, type TrafficSummaryBody } from '@web/traffic-view';
  import type { createDesk } from '#lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  let body = $state<TrafficSummaryBody | undefined>();
  let failed = $state(false);

  $effect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (): Promise<void> => {
      const b = await desk.trafficSummary('listener').catch(() => undefined);
      if (stop) return;
      failed = b === undefined;
      if (b !== undefined) body = b;
      timer = setTimeout(() => { void load(); }, (b?.state === 'ok' ? Math.max(5, b.intervalS) : 15) * 1000);
    };
    void load();
    return () => { stop = true; if (timer !== undefined) clearTimeout(timer); };
  });

  const rows = $derived(body?.state === 'ok'
    ? [...body.rows].sort((a, b) => (b.last?.rps ?? 0) - (a.last?.rps ?? 0) || a.key.localeCompare(b.key)).slice(0, 5)
    : []);
  const top = $derived(Math.max(0, ...rows.map((r) => r.last?.rps ?? 0)));
  const sub = $derived(body?.state === 'ok' ? windowText(body.window) : undefined);
</script>

<section class="panel" aria-labelledby="dash-traffic">
  <div class="phx"><span class="pt" id="dash-traffic">리스너별 트래픽</span>{#if sub}<span class="cap">{sub}</span>{/if}</div>
  {#if body === undefined}
    <div class="empty">{failed ? '트래픽을 읽지 못했어요.' : '읽는 중이에요.'}</div>
  {:else if body.state !== 'ok'}
    <div class="empty">{OFF_TITLE[body.state]}</div>
  {:else if rows.length === 0}
    <div class="empty">아직 센 요청이 없어요.</div>
  {:else}
    {#each rows as r (r.key)}
      {@const v = r.last?.rps ?? 0}
      <a class="row" href={`${resourcePath('listener', r.key)}/traffic`}>
        <span class="mono name" title={r.key}>{r.key}</span>
        <span class="bar" aria-hidden="true"><span style:width="{top > 0 ? (v / top) * 100 : 0}%"></span></span>
        <span class="v">{rateText(v)}</span>
      </a>
    {/each}
  {/if}
</section>

<style>
  .panel { background: var(--bg-panel); border: 1px solid var(--bd); border-radius: var(--r-lg); overflow: hidden; min-width: 0; }
  .phx { display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-bottom: 1px solid var(--bd); }
  .pt { font-weight: 600; font-size: 14px; flex: 1; }
  .cap { font: var(--t-cap); color: var(--tx3); }
  .empty { padding: 16px; color: var(--tx3); font-size: 13px; }
  .row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(80px, 1.2fr) 72px; gap: 12px; align-items: center; padding: 0 16px; height: var(--row-h); border-top: 1px solid var(--bd); color: var(--tx); text-decoration: none; font-size: 13px; }
  .row:first-of-type { border-top: 0; }
  .row:hover { background: var(--bg-hover); }
  .row:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mono { font-family: var(--mono); }
  .bar { height: 8px; background: var(--bg-hover); border-radius: 4px; overflow: hidden; }
  .bar span { display: block; height: 100%; background: var(--accent); border-radius: 4px; }
  .v { text-align: right; font-variant-numeric: tabular-nums; color: var(--tx2); }
</style>
