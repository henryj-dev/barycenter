<script lang="ts">
  /**
   * 라우트 상세의 개요 탭 — 콘솔 시안 `tOv`: 목록 열 이름(`colsOf('routes')`)과 그 칸의 글(`cells('routes', r)`)을
   * 격자(auto-fit, 최소 220px · 간격 14px 24px)로 늘어놓는다. 칸이 고정폭이면 값도 고정폭이다. 목록과 같은 함수를 쓴다.
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { ROUTE_COLS, routeCells } from '#lib/lists/route-cells';
  import OverviewGrid from '#lib/detail/OverviewGrid.svelte';
  import { routeFactsOf } from './route-facts';

  let { kind }: { kind: 'httpRoute' | 'passthroughRoute' } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const facts = $derived(routeFactsOf(desk, kind, key));
  const rows = $derived(facts === undefined ? [] : routeCells(facts).map((c, i) => ({ l: ROUTE_COLS[i] ?? '', v: c.t, mono: c.kind === 'mono', title: c.title })));
</script>

{#if facts !== undefined}<OverviewGrid {rows} />{/if}
