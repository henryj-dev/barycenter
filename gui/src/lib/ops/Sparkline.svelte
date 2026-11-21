<script lang="ts">
  /**
   * 작은 선 하나 (운영 › 지표, 2026-11-21) — 화면을 연 동안의 값 흐름. 계열이 하나라 범례가 없다(줄의 이름이 말한다).
   *
   * 색은 트래픽 그래프의 첫 계열과 같다(`TrafficChart.svelte` — dataviz 검증기로 패널 바탕에 대해 확인한 값).
   * 글자는 계열 색을 안 쓴다. 마우스 · 키보드로 한 점을 고르면 값과 시각을 보인다. 값은 옆 칸에서도 읽는다.
   */
  let { points, format, label }: {
    points: { at: number; value: number }[];
    format: (v: number) => string;
    label: string;
  } = $props();

  const W = 120;
  const H = 28;
  const P = 3;
  const lo = $derived(Math.min(...points.map((p) => p.value)));
  const hi = $derived(Math.max(...points.map((p) => p.value)));
  const xOf = (i: number): number => P + (points.length <= 1 ? (W - 2 * P) / 2 : (i / (points.length - 1)) * (W - 2 * P));
  const yOf = (v: number): number => (hi === lo ? H / 2 : P + (1 - (v - lo) / (hi - lo)) * (H - 2 * P));
  const d = $derived(points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(p.value).toFixed(1)}`).join(''));

  let hover = $state<number | undefined>();
  const onMove = (e: PointerEvent): void => {
    const box = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const n = points.length;
    hover = n <= 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round(((e.clientX - box.left) / box.width) * (n - 1))));
  };
  const onKey = (e: KeyboardEvent): void => {
    const n = points.length;
    if (n === 0) return;
    if (e.key === 'ArrowLeft') { hover = Math.max(0, (hover ?? n) - 1); e.preventDefault(); }
    if (e.key === 'ArrowRight') { hover = Math.min(n - 1, (hover ?? -1) + 1); e.preventDefault(); }
    if (e.key === 'Escape') hover = undefined;
  };
  const tip = $derived(hover === undefined || points[hover] === undefined ? undefined
    : `${new Date(points[hover]!.at).toLocaleTimeString('ko-KR')} · ${format(points[hover]!.value)}`);
</script>

<span class="sp">
  {#if points.length < 2}
    <span class="wait" aria-label={`${label}: 흐름을 모으는 중`}>모으는 중</span>
  {:else}
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label}: 최근 ${points.length}번 읽은 값`}>
      <path class="line" {d} />
      {#if hover !== undefined && points[hover] !== undefined}
        <circle class="dot" cx={xOf(hover)} cy={yOf(points[hover]!.value)} r="4" />
      {/if}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <rect class="hit" x="0" y="0" width={W} height={H} tabindex="0" role="slider" aria-label={`${label} 값 고르기`}
        aria-valuemin={0} aria-valuemax={points.length - 1} aria-valuenow={hover ?? points.length - 1} aria-valuetext={tip ?? ''}
        onpointermove={onMove} onpointerleave={() => { hover = undefined; }} onkeydown={onKey} onblur={() => { hover = undefined; }} />
    </svg>
    {#if tip !== undefined}<span class="tip" role="status">{tip}</span>{/if}
  {/if}
</span>

<style>
  .sp { --viz-1: #3987e5; position: relative; display: inline-flex; align-items: center; min-height: 28px; }
  :global(:root[data-theme='light']) .sp { --viz-1: #2a78d6; }
  @media (prefers-color-scheme: light) {
    :global(:root:not([data-theme='dark']):not([data-theme='light'])) .sp { --viz-1: #2a78d6; }
  }
  .line { fill: none; stroke: var(--viz-1); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .dot { fill: var(--viz-1); stroke: var(--bg-panel); stroke-width: 2; }
  .hit { fill: transparent; cursor: crosshair; outline: none; }
  .hit:focus-visible { stroke: var(--focus); stroke-width: 1; }
  .wait { font: var(--t-cap); color: var(--tx3); }
  .tip {
    position: absolute; bottom: 30px; left: 0; white-space: nowrap; pointer-events: none; z-index: var(--z-pop);
    padding: 4px 8px; border-radius: 6px; background: var(--bg-raised, var(--bg-panel)); border: 1px solid var(--bd);
    font: var(--t-cap); color: var(--tx); font-variant-numeric: tabular-nums;
  }
</style>
