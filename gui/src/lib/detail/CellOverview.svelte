<script lang="ts">
  /**
   * 개요 탭(리스너 · 풀 · 백엔드 · 주소 집합) — 콘솔 시안 `tOv` · `ovRows` 그대로(격자는 `OverviewGrid`).
   * 시안의 개요는 목록의 열 라벨(`colsOf`)과 그 행의 칸 글(`cells`)을 한 칸씩 늘어놓은 격자다(라벨 12px 흐린색 · 값은
   * 고정폭이면 고정폭). 그래서 목록과 같은 열 정의(`lists/traffic-cells.ts`)를 그대로 쓴다 — 목록과 개요가 같은 말을 한다.
   *
   * 시안에 없지만 있던 것: 백엔드의 「트래픽을 받지 않는 이유」 · 드레인 · 헬스 판정(BackendHealth) — 격자 아래 한 칸을 다 쓰는
   * 상자에 둔다(시안 인증서의 「ACME 주문」 상자와 같은 자리 · 모양).
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import {
    addressSetColumns, addressSetRowsOf, backendColumns, backendRowsOf, listenerColumns, listenerRowsOf, overviewOf, poolColumns, poolRowsOf,
  } from '#lib/lists/traffic-cells';
  import type { Cell } from '#lib/ui';
  import BackendHealth from './BackendHealth.svelte';
  import OverviewGrid from './OverviewGrid.svelte';

  let { kind }: { kind: 'listener' | 'pool' | 'backend' | 'addressSet' } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const rows = $derived.by((): { label: string; cell: Cell }[] => {
    if (kind === 'listener') { const r = listenerRowsOf(desk).find((x) => x.key === key); return r === undefined ? [] : overviewOf(listenerColumns(), r); }
    if (kind === 'pool') { const r = poolRowsOf(desk).find((x) => x.key === key); return r === undefined ? [] : overviewOf(poolColumns(), r); }
    if (kind === 'backend') { const r = backendRowsOf(desk).find((x) => x.key === key); return r === undefined ? [] : overviewOf(backendColumns(), r); }
    const r = addressSetRowsOf(desk).find((x) => x.key === key);
    return r === undefined ? [] : overviewOf(addressSetColumns(), r);
  });
  const grid = $derived(rows.map((o) => ({ l: o.label, v: o.cell.t, mono: o.cell.kind === 'mono', title: o.cell.title })));
</script>

{#if kind === 'backend'}
  <OverviewGrid rows={grid}><BackendHealth /></OverviewGrid>
{:else}
  <OverviewGrid rows={grid} />
{/if}
