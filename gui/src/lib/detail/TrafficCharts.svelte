<script lang="ts">
  /**
   * 「실시간 트래픽」 (2026-11-20) — 리스너 · 라우트 · 풀의 트래픽 경로 탭 위에 선다.
   *
   * `GET /api/v1/traffic/:kind/:id` 를 표본 간격마다 다시 읽는다(데몬이 그 간격으로 센다).
   * 그래프는 넷이다 — 축을 둘 쓰지 않으려고 나눴다: 초당 수 · 오류(4xx · 5xx) · 바이트(받음 · 보냄) · 평균 시간.
   * 숫자는 이 화면이 붙은 노드의 것이다. 세지 않는 엔진이면 그 이유를, 못 읽으면 그 사실을 말한다 — 0 을 그리지 않는다.
   */
  import { getContext } from 'svelte';
  import {
    OFF_TITLE, bytesText, countText, msText, rateText, unitOf, windowText,
    type TrafficKind, type TrafficPoint, type TrafficSeriesBody,
  } from '@web/traffic-view';
  import { Banner, Card, Expander, Skeleton } from '#lib/ui';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import TrafficChart from './TrafficChart.svelte';

  let { kind, key, stream = false }: { kind: TrafficKind; key: string; stream?: boolean } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');

  let body = $state<TrafficSeriesBody | undefined>();
  let failed = $state(false);
  let loaded = $state(false);
  let table = $state(false);

  $effect(() => {
    const k = kind;
    const id = key;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (): Promise<void> => {
      const b = await desk.traffic(k, id).catch(() => undefined);
      if (stop) return;
      loaded = true;
      failed = b === undefined;
      // 다시 읽는 동안 앞의 그림을 둔다 — 깜빡이지 않는다.
      if (b !== undefined) body = b;
      const every = b !== undefined && b.state === 'ok' ? Math.max(5, b.intervalS) : 15;
      timer = setTimeout(() => { void load(); }, every * 1000);
    };
    void load();
    return () => { stop = true; if (timer !== undefined) clearTimeout(timer); };
  });

  const unit = $derived(unitOf(stream));
  const points = $derived<TrafficPoint[]>(body?.state === 'ok' ? body.points : []);
  const times = $derived(points.map((p) => p.at));
  const last = $derived(points[points.length - 1]);
  const sub = $derived.by(() => {
    if (body?.state !== 'ok') return undefined;
    const w = windowText(body.window);
    return [w, body.node === undefined ? undefined : `노드 ${body.node}`, `${body.intervalS}초마다 셉니다`].filter(Boolean).join(' · ');
  });
  const total = $derived(points.reduce((a, p) => a + p.rps * (body?.state === 'ok' ? body.intervalS : 0), 0));
</script>

<Card title="실시간 트래픽" {sub}>
  {#if !loaded}
    <Skeleton />
  {:else if failed && body === undefined}
    <Banner tone="warn">트래픽을 읽지 못했어요. 잠시 뒤에 다시 읽어요.</Banner>
  {:else if body !== undefined && body.state !== 'ok'}
    <Banner tone={body.state === 'unsupported' ? 'neutral' : 'warn'}>{OFF_TITLE[body.state]} — {body.reason}</Banner>
  {:else if points.length === 0}
    <p class="empty">아직 표본이 모이는 중이에요. 표본 두 개가 모이면 그래프가 나와요.</p>
  {:else}
    <div class="stats" aria-label="마지막 구간">
      <div><b>{rateText(last?.rps ?? 0)}</b><span>초당 {unit}</span></div>
      <div><b>{rateText(last?.status.s5 ?? 0)}</b><span>초당 5xx</span></div>
      <div><b>{last?.avgMs === undefined ? '—' : msText(last.avgMs)}</b><span>평균 시간</span></div>
      <div><b>{countText(total)}</b><span>{unit} 수 (창 전체)</span></div>
    </div>
    <div class="grid">
      <TrafficChart title={`초당 ${unit}`} {times} format={rateText}
        series={[{ name: unit, slot: 1, values: points.map((p) => p.rps) }]} />
      {#if !stream}
        <TrafficChart title="초당 오류 응답" {times} format={rateText}
          series={[
            { name: '4xx', slot: 1, values: points.map((p) => p.status.s4) },
            { name: '5xx', slot: 2, values: points.map((p) => p.status.s5) },
          ]} />
      {/if}
      <TrafficChart title="초당 바이트" {times} format={(x) => bytesText(x, true)}
        series={[
          { name: '받음', slot: 1, values: points.map((p) => p.bytesInPerS) },
          { name: '보냄', slot: 2, values: points.map((p) => p.bytesOutPerS) },
        ]} />
      <TrafficChart title={stream ? '평균 연결 시간' : '평균 응답 시간'} {times} format={msText}
        series={[{ name: '평균', slot: 1, values: points.map((p) => p.avgMs) }]} />
    </div>
    <div class="foot">
      <Expander bind:open={table}>표로 보기 · {points.length}구간</Expander>
    </div>
    {#if table}
      <div class="tw">
        <table>
          <thead><tr><th>끝난 시각</th><th>초당 {unit}</th><th>2xx</th><th>3xx</th><th>4xx</th><th>5xx</th><th>받음</th><th>보냄</th><th>평균</th></tr></thead>
          <tbody>
            {#each [...points].reverse() as p (p.at)}
              <tr>
                <td>{new Date(p.at).toLocaleTimeString('ko-KR')}</td>
                <td>{rateText(p.rps)}</td><td>{rateText(p.status.s2)}</td><td>{rateText(p.status.s3)}</td>
                <td>{rateText(p.status.s4)}</td><td>{rateText(p.status.s5)}</td>
                <td>{bytesText(p.bytesInPerS, true)}</td><td>{bytesText(p.bytesOutPerS, true)}</td>
                <td>{p.avgMs === undefined ? '—' : msText(p.avgMs)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}
</Card>

<style>
  .empty { margin: 0; color: var(--tx3); font: var(--t-small); }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; margin-bottom: 16px; }
  .stats div { display: flex; flex-direction: column; gap: 2px; }
  .stats b { font: 600 20px/28px var(--font); color: var(--tx); font-variant-numeric: tabular-nums; }
  .stats span { font: var(--t-cap); color: var(--tx3); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 20px 24px; }
  .foot { margin-top: 12px; }
  .tw { overflow-x: auto; margin-top: 8px; max-height: 320px; overflow-y: auto; }
  table { width: 100%; border-collapse: collapse; font: var(--t-cap); font-variant-numeric: tabular-nums; }
  th, td { text-align: right; padding: 4px 8px; border-bottom: 1px solid var(--bd); white-space: nowrap; }
  th:first-child, td:first-child { text-align: left; }
  th { color: var(--tx3); font-weight: 600; position: sticky; top: 0; background: var(--bg-panel); }
  td { color: var(--tx2); }
</style>
