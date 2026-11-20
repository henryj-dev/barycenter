<script lang="ts">
  /**
   * 트래픽 시계열 하나 (2026-11-20) — 선 그래프, 축 하나, 계열 둘까지.
   *
   * 색은 계열의 **자리**가 정한다(1 = 파랑, 2 = 주황). 검증기(dataviz `validate_palette.js`)로
   * 패널 바탕(라이트 #ffffff · 다크 #161a20)에 대해 확인한 값이다. 글자는 계열 색을 안 쓴다.
   * 계열이 둘이면 범례와 끝 값 표시가 함께 선다 — 색만으로 계열을 가르지 않는다.
   * 마우스 · 키보드 둘 다 십자선과 값을 보인다. 값은 아래 표에서도 읽을 수 있다.
   */
  export type ChartSeries = { name: string; slot: 1 | 2; values: (number | undefined)[] };

  let { title, times, series, format }: {
    title: string;
    times: string[];
    series: ChartSeries[];
    format: (x: number) => string;
  } = $props();

  import { niceScale } from '@web/traffic-view';

  const H = 150;
  const PAD = { top: 10, right: 64, bottom: 22, left: 56 };
  let width = $state(480);
  const plotW = $derived(Math.max(40, width - PAD.left - PAD.right));
  const plotH = H - PAD.top - PAD.bottom;

  const max = $derived(Math.max(0, ...series.flatMap((s) => s.values.filter((v): v is number => v !== undefined))));
  const scale = $derived(niceScale(max));
  const n = $derived(times.length);
  const xOf = (i: number): number => PAD.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yOf = (v: number): number => PAD.top + plotH - (v / scale.top) * plotH;

  /** 값이 없는 칸에서 선을 끊는다 — 없는 값을 0 으로 잇지 않는다. */
  const pathOf = (values: (number | undefined)[]): string => {
    let d = '';
    let open = false;
    values.forEach((v, i) => {
      if (v === undefined) { open = false; return; }
      d += `${open ? 'L' : 'M'}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`;
      open = true;
    });
    return d;
  };
  /** 끝 값 표시 — 마지막으로 있는 값. 두 표시가 겹치면 아래 것을 내린다. */
  const ends = $derived.by(() => {
    const out = series.map((s) => {
      let i = s.values.length - 1;
      while (i >= 0 && s.values[i] === undefined) i -= 1;
      return i < 0 ? undefined : { s, y: yOf(s.values[i]!), v: s.values[i]! };
    });
    const shown = out.filter((e): e is NonNullable<typeof e> => e !== undefined).sort((a, b) => a.y - b.y);
    for (let i = 1; i < shown.length; i += 1) {
      if (shown[i]!.y - shown[i - 1]!.y < 14) shown[i]!.y = shown[i - 1]!.y + 14;
    }
    return shown;
  });

  let hover = $state<number | undefined>();
  const timeText = (iso: string | undefined): string =>
    (iso === undefined ? '' : new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  const onMove = (e: PointerEvent): void => {
    const box = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const x = e.clientX - box.left;
    hover = n <= 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round((x / box.width) * (n - 1))));
  };
  const onKey = (e: KeyboardEvent): void => {
    if (n === 0) return;
    if (e.key === 'ArrowLeft') { hover = Math.max(0, (hover ?? n) - 1); e.preventDefault(); }
    if (e.key === 'ArrowRight') { hover = Math.min(n - 1, (hover ?? -1) + 1); e.preventDefault(); }
    if (e.key === 'Escape') hover = undefined;
  };
  const tipLeft = $derived(hover === undefined ? 0 : Math.min(xOf(hover) + 12, width - 170));
</script>

<figure class="chart" bind:clientWidth={width}>
  <figcaption>
    <span class="t">{title}</span>
    {#if series.length > 1}
      <span class="legend" aria-hidden="true">
        {#each series as s (s.name)}<span class="key"><i class={`k s${s.slot}`}></i>{s.name}</span>{/each}
      </span>
    {/if}
  </figcaption>
  <svg width={width} height={H} role="img" aria-label={`${title} — 표로도 볼 수 있어요`}>
    {#each scale.ticks as t (t)}
      <line class="grid" x1={PAD.left} x2={PAD.left + plotW} y1={yOf(t)} y2={yOf(t)} />
      <text class="ax" x={PAD.left - 6} y={yOf(t) + 4} text-anchor="end">{format(t)}</text>
    {/each}
    {#if n > 0}
      <text class="ax" x={PAD.left} y={H - 6}>{timeText(times[0])}</text>
      <text class="ax" x={PAD.left + plotW} y={H - 6} text-anchor="end">{timeText(times[n - 1])}</text>
    {/if}
    {#each series as s (s.name)}
      <path class={`line s${s.slot}`} d={pathOf(s.values)} />
    {/each}
    {#each ends as e (e.s.name)}
      <text class="end" x={PAD.left + plotW + 6} y={e.y + 4}>{format(e.v)}</text>
    {/each}
    {#if hover !== undefined}
      <line class="cross" x1={xOf(hover)} x2={xOf(hover)} y1={PAD.top} y2={PAD.top + plotH} />
      {#each series as s (s.name)}
        {#if s.values[hover] !== undefined}
          <circle class={`dot s${s.slot}`} cx={xOf(hover)} cy={yOf(s.values[hover]!)} r="4" />
        {/if}
      {/each}
    {/if}
    <!-- 십자선의 과녁 — 선이 아니라 그림 전체다. -->
    <rect class="hit" x={PAD.left} y={PAD.top} width={plotW} height={plotH} tabindex="0" role="slider"
      aria-label={`${title} 시점 고르기 (← →)`} aria-valuemin={0} aria-valuemax={Math.max(0, n - 1)} aria-valuenow={hover ?? 0}
      onpointermove={onMove} onpointerleave={() => { hover = undefined; }} onkeydown={onKey} onblur={() => { hover = undefined; }} />
  </svg>
  {#if hover !== undefined}
    <div class="tip" style:left={`${tipLeft}px`} role="status">
      <div class="when">{timeText(times[hover])}</div>
      {#each series as s (s.name)}
        <div class="row"><i class={`k s${s.slot}`}></i><b>{s.values[hover] === undefined ? '—' : format(s.values[hover]!)}</b><span>{s.name}</span></div>
      {/each}
    </div>
  {/if}
</figure>

<style>
  /* 계열 색 — 다크가 기본이다(tokens.css 와 같은 규칙). */
  .chart { --viz-1: #3987e5; --viz-2: #d95926; position: relative; margin: 0; min-width: 0; }
  :global(:root[data-theme='light']) .chart { --viz-1: #2a78d6; --viz-2: #eb6834; }
  @media (prefers-color-scheme: light) {
    :global(:root:not([data-theme='dark']):not([data-theme='light'])) .chart { --viz-1: #2a78d6; --viz-2: #eb6834; }
  }
  figcaption { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 4px; }
  .t { font: 600 13px/18px var(--font); color: var(--tx); }
  .legend { display: flex; gap: 12px; font: var(--t-cap); color: var(--tx2); }
  .key { display: inline-flex; align-items: center; gap: 6px; }
  .k { display: inline-block; width: 12px; height: 2px; border-radius: 1px; }
  .k.s1 { background: var(--viz-1); }
  .k.s2 { background: var(--viz-2); }
  svg { display: block; overflow: visible; }
  .grid { stroke: var(--bd); stroke-width: 1; }
  .ax { fill: var(--tx3); font: 11px/1 var(--font); font-variant-numeric: tabular-nums; }
  .end { fill: var(--tx2); font: 11px/1 var(--font); font-variant-numeric: tabular-nums; }
  .line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .line.s1 { stroke: var(--viz-1); }
  .line.s2 { stroke: var(--viz-2); }
  .cross { stroke: var(--tx3); stroke-width: 1; }
  .dot { stroke: var(--bg-panel); stroke-width: 2; }
  .dot.s1 { fill: var(--viz-1); }
  .dot.s2 { fill: var(--viz-2); }
  .hit { fill: transparent; cursor: crosshair; outline: none; }
  .hit:focus-visible { stroke: var(--focus); stroke-width: 1; }
  .tip {
    position: absolute; top: 28px; min-width: 150px; pointer-events: none; z-index: var(--z-pop);
    background: var(--bg-panel); border: 1px solid var(--bd-strong); border-radius: var(--r-md); box-shadow: var(--sh-pop);
    padding: 8px 10px; font: var(--t-cap); color: var(--tx2);
  }
  .when { color: var(--tx3); margin-bottom: 4px; }
  .row { display: flex; align-items: center; gap: 8px; }
  .row b { color: var(--tx); font: 600 12px/18px var(--font); font-variant-numeric: tabular-nums; }
</style>
