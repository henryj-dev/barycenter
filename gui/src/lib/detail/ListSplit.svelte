<script lang="ts" module>
  /** `inline` 스니펫이 받는 것 — 고른 행 하나. */
  export type InlineContext = {
    /** 리소스 키(합산이면 지역 안의 원래 키). */
    key: string;
    /** 「상세 페이지 ↗」 주소 — 합산이면 그 지역으로 좁혀 연다. `InlineEdit detailHref` 에 그대로 준다. */
    detailHref: string;
    /** 적용 대기 중인 변경이 있는가 — `InlineEdit pending` 에 그대로 준다. */
    pending: boolean;
  };
</script>

<script lang="ts">
  /**
   * 목록의 분할 상세 (콘솔 시안 목록 블록 · 디자인 시스템 §5 「분할 패턴」) — 한 카드 안에 위는 목록, 아래는 고른 행 하나.
   *
   * 아무것도 안 골랐으면 아래와 막대를 안 그리고 목록이 높이를 다 쓴다(시안 `listFlex` · `sepD` · `hasSelBlock`).
   * 행을 고르면 막대(끌기 · ↑↓, 처음 240px)와 아래가 열린다. 머리 줄(시안): 이름(고정폭) · 「◐ 적용 대기」 · 지역(합산일 때,
   * 흐린 고정폭) · `actions`(「URL로 다시 만들기」 · 「목록 다시 받기」 …) · 「상세 페이지 ↗」 · 「닫기」.
   *
   * 아래 내용은 둘 중 하나다.
   *   · `inline` 스니펫을 주면 **인라인 수정**(시안 `isecs` — 그 리소스의 `INL` 필드, 저장 / 되돌리기). 스니펫 안에서
   *     `InlineEdit`(틀 · 문구)에 그 리소스의 `FormRow` 들을 넣는다. 쓸 수 없으면(팔로워 · 연락 없음 · 합산에서 못 쓰는 지역)
   *     인라인 대신 아래 요약을 그린다.
   *   · 없으면 **읽기 요약**(시안 보기 모드 `viewSecs` — `ViewSections` 의 「기본」 구획). 백엔드는 「트래픽을 받지 않는 이유」,
   *     풀은 「소속 백엔드」 를 더 보인다. 쓸 수 없을 때(인라인 대신)도 이것이다.
   *
   * **전체 합산**(전역에서 지역을 안 골랐다, §2.5)이면 선택은 합산 행 키(`rid`)다. 그 행의 지역 desk 로 그리고,
   * 아래 컴포넌트는 `InRegion` 으로 그 지역을 본다. 「상세 페이지 ↗」 는 그 지역으로 좁혀 연다(`?region=`).
   */
  import { getContext, type Snippet } from 'svelte';
  import { detailOfListener } from '@web/listeners-view';
  import { RESOURCES, itemOf, resourcePath, summaryOf, type ResourceKind } from '@web/resources';
  import { Badge, Button, SplitView } from '#lib/ui';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import { useAggregate } from '#lib/global/use-aggregate.svelte.ts';
  import InRegion from '#lib/global/InRegion.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import BackendReasons from './BackendReasons.svelte';
  import PoolBackends from './PoolBackends.svelte';
  import ViewSections from './ViewSections.svelte';
  import { PENDING_MARK, isPendingResource } from '#lib/pending';

  let { kind, selected = $bindable([]), table, extra, actions, inline }: {
    kind: ResourceKind;
    /** 목록(DataTable)의 선택. 하나만 골랐을 때 아래가 열린다. */
    selected: string[];
    /** 위에 그릴 목록 — `DataTable fill` 이면 도구 줄은 그대로, 표만 스크롤한다. */
    table: Snippet;
    /** 요약 아래에 더 그릴 것(고른 키를 받는다). */
    extra?: Snippet<[string]>;
    /** 머리 줄 「상세 페이지 ↗」 앞에 더 둘 버튼(고른 키를 받는다) — 시안의 라우트 「URL로 다시 만들기」 · 주소 집합 「목록 다시 받기」. */
    actions?: Snippet<[string]>;
    /** 인라인 수정 — 시안 `isecs`. 없으면 읽기 요약. */
    inline?: Snippet<[InlineContext]>;
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
  // 쓸 수 없으면(전체 합산에서 그 지역에 못 쓴다 · 팔로워 · 고른 지역과 연락 없음) 수정을 안 보인다.
  const ro = $derived(agg.on ? entry?.writable !== true : scope?.blocked === true);
  // 합산에서 빠진 지역(연락 없음 등)의 행은 요약도 안 그린다 — 마지막 값을 지금 값처럼 보이지 않는다.
  const key = $derived(agg.on ? (entry?.state === 'ok' ? at?.key : undefined) : picked);
  /** 상세 · 수정 주소 — 합산이면 그 지역으로 좁혀 연다. */
  const link = (path: string): string => (agg.on && at !== undefined ? agg.href(at.region, path) : path);
  const item = $derived(key === undefined || desk === undefined ? undefined : itemOf(desk.model, kind, key));
  const lines = $derived(item === undefined ? [] : kind === 'listener' ? detailOfListener(item) : summaryOf(kind, item));
  /** 「◐ 적용 대기」(시안 `selPendD`) — 엔진이 돌리는 것과 head 가 다르면. 분할 머리에는 이것만 붙는다(시안). */
  const pending = $derived(key !== undefined && desk !== undefined && isPendingResource(desk.pendingResources, kind, key));
  const poolCount = $derived(kind === 'pool' && key !== undefined && desk !== undefined ? desk.pools.rows.find((p) => p.key === key)?.backends.length ?? 0 : 0);
  const editing = $derived(inline !== undefined && !ro);
</script>

{#snippet summary(key: string)}
  <div class="sd">
    {#if kind === 'backend'}<BackendReasons backend={key} />{/if}
    {#if lines.length > 0}<ViewSections sections={[{ t: '기본', f: lines.map((l) => ({ l: l.label, v: l.value, mono: true })) }]} />{/if}
    {#if kind === 'pool'}
      <section class="sub">
        <h3>소속 백엔드 · {poolCount}</h3>
        <PoolBackends pool={key} />
      </section>
    {/if}
    {#if extra}{@render extra(key)}{/if}
  </div>
{/snippet}

{#snippet body(key: string)}
  {#if editing && inline}
    {#key key}{@render inline({ key, detailHref: link(resourcePath(kind, key)), pending })}{/key}
  {:else}
    {@render summary(key)}
  {/if}
{/snippet}

<SplitView top={table} open={item !== undefined} title={key} onclose={() => { selected = []; }} closeLabel="닫기" collapsible={false}
  hideEmpty sepLabel="목록·상세 높이 조절" meta={at?.region} height="max(520px, calc(100dvh - 220px))">
  {#snippet badges()}
    {#if pending}<Badge tone={PENDING_MARK.tone} icon={PENDING_MARK.icon}>{PENDING_MARK.text}</Badge>{/if}
  {/snippet}
  {#snippet actions()}
    {#if key !== undefined}
      {#if agg.on && entry !== undefined}
        {#key entry.name}<InRegion {entry}>{@render headActions(key)}</InRegion>{/key}
      {:else}
        {@render headActions(key)}
      {/if}
    {/if}
  {/snippet}
  {#snippet detail()}
    {#if key !== undefined && agg.on && entry !== undefined}
      <!-- 합산: 아래 컴포넌트(BackendReasons · PoolBackends · actions · extra · inline)가 그 행의 지역을 본다. -->
      {#key entry.name}<InRegion {entry}>{@render body(key)}</InRegion>{/key}
    {:else if key !== undefined}
      {@render body(key)}
    {/if}
  {/snippet}
</SplitView>

{#snippet headActions(key: string)}
  {#if actions}{@render actions(key)}{/if}
  <!-- 인라인 수정이 없는 리소스는 설정 탭으로 가는 「수정」 을 둔다(시안 보기 모드에는 없다 — 이미 있는 길이라 남긴다). -->
  {#if !editing && !ro && RESOURCES[kind].editable}<Button size="xs" href={link(resourcePath(kind, key, 'settings'))}>수정</Button>{/if}
  <a class="det" href={link(resourcePath(kind, key))}>상세 페이지 ↗</a>
{/snippet}

<style>
  .sd { display: flex; flex-direction: column; gap: 14px; padding: 12px 16px; }
  .sub { display: flex; flex-direction: column; gap: 6px; }
  .sub h3 { margin: 0; font: var(--t-cap); font-weight: 600; color: var(--tx2); }
  .det { color: var(--accent); font: 500 12px/1 var(--font); text-decoration: none; white-space: nowrap; }
  .det:hover { text-decoration: underline; }
</style>
