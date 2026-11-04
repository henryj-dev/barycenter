<script lang="ts">
  /**
   * 풀의 소속 백엔드 표 — 콘솔 시안 `subViewD` · `subTabD` 그대로: 테두리 상자, 28px 머리(--bg-hover),
   * 열은 이름 · 호스트:포트 · 가중치 · 헬스(1fr 1.4fr .6fr 1.2fr). 도구 줄 · 정렬 · 넣기 단추는 없다(시안).
   * 백엔드 넣기는 백엔드 만들기 폼의 풀 고르기가 한다.
   *
   * `pool` 을 주면 그 풀이다(목록의 분할 상세). 없으면 주소의 풀이다. 전체 합산의 분할 상세에서는 `InRegion` 이
   * desk · 범위를 그 행의 지역 것으로 덮는다 — 이름은 그 지역으로 좁혀 연다(`scope.fixed`).
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { itemsOf, resourcePath } from '@web/resources';
  import { Badge } from '#lib/ui';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import { inRegion } from '#lib/global/aggregate.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { DRAIN_MARK, HEALTH_MARK, backendDraining, backendHealth } from './facts';

  let { pool }: { pool?: string } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const link = (path: string): string => (scope?.fixed === true && scope.region !== undefined ? inRegion(path, scope.region.name) : path);
  const key = $derived(pool ?? page.params['key'] ?? '');
  const members = $derived(itemsOf(desk.model, 'backend').filter((b) => b['pool'] === key).map((b) => {
    const k = String(b['key']);
    return { n: k, hp: `${String(b['host'])}:${String(b['port'])}`, w: String(b['weight'] ?? 1), m: backendDraining(desk, k) ? DRAIN_MARK : HEALTH_MARK[backendHealth(desk, k)] };
  }));
</script>

<div class="tbl" role="table" aria-label="소속 백엔드">
  <div class="tr th" role="row"><span role="columnheader">이름</span><span role="columnheader">호스트:포트</span><span role="columnheader">가중치</span><span role="columnheader">헬스</span></div>
  {#each members as b (b.n)}
    <div class="tr" role="row">
      <a class="mono lnk" role="cell" href={link(resourcePath('backend', b.n))}>{b.n}</a><span class="mono" role="cell">{b.hp}</span><span class="mono" role="cell">{b.w}</span>
      <span role="cell"><Badge tone={b.m.tone} icon={b.m.icon}>{b.m.text}</Badge></span>
    </div>
  {:else}
    <div class="tr" role="row"><span class="none" role="cell">백엔드가 없어요. 이 풀로 가는 요청은 실패해요.</span></div>
  {/each}
</div>

<style>
  /* 값은 시안 `subViewD` 블록의 인라인 style 그대로다. */
  .tbl { border: 1px solid var(--bd); border-radius: var(--r-md); overflow: hidden; font-size: 13px; }
  .tr { display: grid; grid-template-columns: 1fr 1.4fr .6fr 1.2fr; gap: 12px; padding: 0 12px; height: var(--row-h); align-items: center; border-top: 1px solid var(--bd); }
  .tr.th { height: 28px; background: var(--bg-hover); font-size: 12px; font-weight: 600; color: var(--tx2); border-top: 0; }
  .mono { font-family: var(--mono); }
  .lnk { color: var(--tx); text-decoration: none; }
  .lnk:hover { text-decoration: underline; }
  .none { grid-column: 1 / -1; color: var(--tx3); }
</style>
