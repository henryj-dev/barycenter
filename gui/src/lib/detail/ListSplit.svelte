<script lang="ts">
  /**
   * 목록의 분할 상세 (시안 · 디자인 시스템 §5 「분할 패턴」) — 위는 목록, 아래는 고른 행 하나의 요약.
   *
   * 행을 누르면 아래가 열린다. 「상세 페이지 ↗」 는 탭이 있는 상세로 간다. 「수정」 은 설정 탭이다.
   * 백엔드는 「트래픽을 받지 않는 이유」, 풀은 「소속 백엔드」 를 더 보인다(시안).
   * 여기서는 고치지 않는다 — 저장은 설정 탭 한 자리다.
   *
   * **전체 합산**(전역에서 지역을 안 골랐다, §2.5)이면 선택은 합산 행 키(`rid`)다. 그 행의 지역 desk 로 요약을 그리고,
   * 아래 컴포넌트는 `InRegion` 으로 그 지역을 본다. 「상세 페이지 ↗」 · 「수정」 은 그 지역으로 좁혀 연다(`?region=`).
   * 고치는 곳은 없다 — 목록이 `useAggregate` 를 쓰면 여기도 저절로 합산이다.
   */
  import { getContext, type Snippet } from 'svelte';
  import { detailOfListener } from '@web/listeners-view';
  import { RESOURCES, itemOf, resourcePath, summaryOf, type ResourceKind } from '@web/resources';
  import { Badge, Button, DescriptionList, SplitView } from '#lib/ui';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import { useAggregate } from '#lib/global/use-aggregate.svelte.ts';
  import InRegion from '#lib/global/InRegion.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import BackendReasons from './BackendReasons.svelte';
  import PoolBackends from './PoolBackends.svelte';
  import { statusOf } from './facts';
  import { headerMarks, isPendingResource } from '#lib/pending';

  let { kind, selected = $bindable([]), table, extra, actions }: {
    kind: ResourceKind;
    /** 목록(DataTable)의 선택. 하나만 골랐을 때 아래가 열린다. */
    selected: string[];
    /** 위에 그릴 목록. */
    table: Snippet;
    /** 요약 아래에 더 그릴 것(고른 키를 받는다). */
    extra?: Snippet<[string]>;
    /** 「상세 페이지 ↗」 앞에 더 둘 버튼(고른 키를 받는다) — 시안의 라우트 「URL로 다시 만들기」. */
    actions?: Snippet<[string]>;
  } = $props();
  const shell = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const agg = useAggregate();
  const picked = $derived(selected.length === 1 ? selected[0] : undefined);
  /** 합산이면 고른 행의 지역과 원래 키. */
  const at = $derived(agg.on && picked !== undefined ? agg.split(picked) : undefined);
  const entry = $derived(at === undefined ? undefined : agg.entry(at.region));
  /** 요약을 읽을 desk — 합산이면 그 행의 지역, 아니면 셸의 desk. */
  const desk = $derived(agg.on ? entry?.desk : shell);
  // 쓸 수 없으면(전체 합산에서 그 지역에 못 쓴다 · 팔로워 · 고른 지역과 연락 없음) 만들기 · 수정 · 삭제를 안 보인다.
  const ro = $derived(agg.on ? entry?.writable !== true : scope?.blocked === true);
  // 합산에서 빠진 지역(연락 없음 등)의 행은 요약도 안 그린다 — 마지막 값을 지금 값처럼 보이지 않는다.
  const key = $derived(agg.on ? (entry?.state === 'ok' ? at?.key : undefined) : picked);
  /** 상세 · 수정 주소 — 합산이면 그 지역으로 좁혀 연다. */
  const link = (path: string): string => (agg.on && at !== undefined ? agg.href(at.region, path) : path);
  const item = $derived(key === undefined || desk === undefined ? undefined : itemOf(desk.model, kind, key));
  const lines = $derived(item === undefined ? [] : kind === 'listener' ? detailOfListener(item) : summaryOf(kind, item));
  const mark = $derived(key === undefined || desk === undefined ? undefined : statusOf(desk, kind, key));
  /** 상태 배지 + 「◐ 적용 대기」(시안 `selPendD`) — 엔진이 돌리는 것과 head 가 다르면. */
  const marks = $derived(key === undefined || desk === undefined ? [] : headerMarks(mark, isPendingResource(desk.pendingResources, kind, key)));
  const poolCount = $derived(kind === 'pool' && key !== undefined && desk !== undefined ? desk.pools.rows.find((p) => p.key === key)?.backends.length ?? 0 : 0);
</script>

{#snippet body(key: string)}
  <div class="sd">
    <div class="act">
      {#if actions}{@render actions(key)}{/if}
      <Button size="sm" variant="text" href={link(resourcePath(kind, key))}>상세 페이지 ↗</Button>
      {#if !ro && RESOURCES[kind].editable}<Button size="sm" href={link(resourcePath(kind, key, 'settings'))}>수정</Button>{/if}
    </div>
    {#if kind === 'backend'}<BackendReasons backend={key} />{/if}
    <DescriptionList labelWidth="160px" items={lines.map((l) => ({ label: l.label, value: l.value, mono: true }))} />
    {#if kind === 'pool'}
      <section class="sub">
        <h3>소속 백엔드 · {poolCount}</h3>
        <PoolBackends pool={key} />
      </section>
    {/if}
    {#if extra}{@render extra(key)}{/if}
  </div>
{/snippet}

<SplitView top={table} open={item !== undefined} title={key} onclose={() => { selected = []; }} height="max(520px, calc(100dvh - 220px))">
  {#snippet badges()}
    {#if at !== undefined}<Badge tone="info" icon="◎">{at.region}</Badge>{/if}
    {#each marks as m (m.text)}<Badge tone={m.tone} icon={m.icon}>{m.text}</Badge>{/each}
  {/snippet}
  {#snippet detail()}
    {#if key !== undefined && agg.on && entry !== undefined}
      <!-- 합산: 아래 컴포넌트(BackendReasons · PoolBackends · actions · extra)가 그 행의 지역을 본다. -->
      {#key entry.name}<InRegion {entry}>{@render body(key)}</InRegion>{/key}
    {:else if key !== undefined}
      {@render body(key)}
    {/if}
  {/snippet}
</SplitView>

<style>
  .sd { display: flex; flex-direction: column; gap: 14px; }
  .act { display: flex; gap: 8px; align-items: center; justify-content: flex-end; }
  .sub { display: flex; flex-direction: column; gap: 6px; }
  .sub h3 { margin: 0; font: var(--t-cap); font-weight: 600; color: var(--tx2); }
</style>
