<script lang="ts">
  /**
   * 운영 › 지표 (2026-11-21) — 데몬이 세는 값(`/api/v1/metrics`)을 묶음별로.
   *
   * 해석은 `@web/metrics-view` 가 한다. 이 화면은 10초마다 다시 읽고, 연 동안의 흐름(최근 60번)을 작은 선으로 보인다.
   * 흐름은 브라우저에만 있다 — 화면을 닫으면 사라진다. 오래 보려면 Prometheus 가 `/metrics` 를 긁는다.
   * 카운터는 값과 함께 초당 증가를 보인다. 데몬이 다시 떠서 카운터가 줄면 그 칸은 증가를 비운다.
   * 전역의 전체 합산 보기에서는 지역을 골라야 한다 — 지표는 노드마다 따로다.
   */
  import { getContext, onDestroy, onMount } from 'svelte';
  import {
    counterRate, formatMetric, groupMetrics, labelText, parseMetrics, pushHistory, sampleKey,
    type MetricArea, type MetricHistory,
  } from '@web/metrics-view';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { Badge, Banner, Button, Card, FieldMessage, SearchInput } from '#lib/ui';
  import Sparkline from './Sparkline.svelte';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const aggregate = $derived(scope?.mode === 'global' && scope.region === undefined);
  const EVERY_MS = 10_000;

  let areas = $state<MetricArea[]>([]);
  let history = $state<MetricHistory>(new Map());
  let readAt = $state<number | undefined>();
  let failed = $state<string | undefined>();
  let denied = $state(false);
  let loading = $state(true);
  let q = $state('');
  let timer: ReturnType<typeof setInterval> | undefined;

  const read = async (): Promise<void> => {
    if (aggregate) { loading = false; return; }
    const r = await desk.metricsText();
    loading = false;
    if (!r.ok) {
      denied = r.status === 403;
      failed = r.status === 0 ? '데몬에 닿지 않아요. 연결을 확인해요.' : `지표를 읽지 못했어요 (${r.status}).`;
      return;
    }
    const fams = parseMetrics(r.text);
    const at = Date.now();
    const h = new Map(history);
    pushHistory(h, at, fams);
    history = h;
    areas = groupMetrics(fams);
    readAt = at;
    failed = undefined;
    denied = false;
  };
  onMount(() => {
    void read();
    timer = setInterval(() => { void read(); }, EVERY_MS);
  });
  onDestroy(() => { if (timer !== undefined) clearInterval(timer); });

  const needle = $derived(q.trim().toLowerCase());
  const shown = $derived(needle === '' ? areas : areas
    .map((a) => ({ ...a, families: a.families.filter((f) =>
      f.name.toLowerCase().includes(needle) || (f.help ?? '').toLowerCase().includes(needle)
      || f.samples.some((s) => labelText(s.labels).toLowerCase().includes(needle))) }))
    .filter((a) => a.families.length > 0));
  const rateText = (v: number | undefined): string => (v === undefined ? '—' : v === 0 ? '0/초' : `${v < 0.01 ? v.toExponential(1) : v.toFixed(2)}/초`);
</script>

{#if aggregate}
  <Banner tone="info">지표는 노드마다 따로예요. 지역을 고르면 그 지역 리더의 지표를 봐요. <a href="/regions">지역 고르기</a></Banner>
{:else if denied}
  <FieldMessage>지표를 볼 권한이 없어요.</FieldMessage>
{:else}
  <div class="mt">
    <div class="bar">
      <SearchInput bind:value={q} placeholder="이름 · 설명 · 라벨로 찾기" />
      <span class="when">{readAt === undefined ? '읽는 중' : `${new Date(readAt).toLocaleTimeString('ko-KR')} 에 읽었어요 · 10초마다`}</span>
      <Button size="sm" onclick={() => { void read(); }}>지금 다시 읽기</Button>
    </div>
    {#if failed !== undefined}<Banner tone="danger">{failed}</Banner>{/if}
    {#if loading}
      <FieldMessage>지표를 읽는 중이에요.</FieldMessage>
    {:else if shown.length === 0}
      <FieldMessage>{needle === '' ? '데몬이 아직 낸 지표가 없어요.' : '찾는 지표가 없어요.'}</FieldMessage>
    {/if}
    {#each shown as a (a.key)}
      <Card title={`${a.label} · ${a.families.length}`} padded={false}>
        <table class="tb">
          <thead><tr><th scope="col">이름</th><th scope="col">값</th><th scope="col">초당 증가</th><th scope="col">흐름</th></tr></thead>
          <tbody>
            {#each a.families as f (f.name)}
              {#each f.samples as s, i (sampleKey(f.name, s.labels))}
                {@const k = sampleKey(f.name, s.labels)}
                <tr>
                  <td class="nm">
                    {#if i === 0}
                      <span class="mono">{f.name}</span>
                      <Badge tone="neutral" icon={null}>{f.type === 'counter' ? '카운터' : f.type === 'gauge' ? '게이지' : '모름'}</Badge>
                      {#if f.help !== undefined}<span class="help">{f.help}</span>{/if}
                    {/if}
                    {#if labelText(s.labels) !== ''}<span class="lb mono">{labelText(s.labels)}</span>{/if}
                  </td>
                  <td class="v mono">{formatMetric(f.name, s.value)}</td>
                  <td class="v mono muted">{f.type === 'counter' ? rateText(counterRate(history.get(k))) : ''}</td>
                  <td><Sparkline points={history.get(k) ?? []} format={(v) => formatMetric(f.name, v)} label={k} /></td>
                </tr>
              {/each}
            {/each}
          </tbody>
        </table>
      </Card>
    {/each}
  </div>
{/if}

<style>
  .mt { display: flex; flex-direction: column; gap: 16px; }
  .bar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .when { margin-right: auto; font: var(--t-cap); color: var(--tx2); }
  .tb { width: 100%; border-collapse: collapse; }
  .tb th { text-align: left; font: var(--t-cap); color: var(--tx2); padding: 8px 12px; border-bottom: 1px solid var(--bd); }
  .tb td { padding: 6px 12px; border-bottom: 1px solid var(--bd); vertical-align: top; }
  .nm { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; min-width: 0; }
  .mono { font-family: var(--mono); font-size: 12px; }
  .help { flex-basis: 100%; font: var(--t-cap); color: var(--tx2); }
  .lb { color: var(--tx2); }
  .v { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--tx); }
  .muted { color: var(--tx2); }
</style>
