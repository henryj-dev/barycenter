<script lang="ts">
  /**
   * 상세 화면의 틀 — 모든 리소스가 같다 (2026-10-30, 경로 분리 #124).
   *
   * 콘솔 상세 머리(`DetailHeader`)로 제목 · 배지 · 버튼 · 탭을 그린다. 탭 내용은 그 아래 라우트 파일이 그린다.
   * 탭은 **주소다**(`<key>/settings` …) — 새로고침·북마크·링크가 그 탭으로 바로 온다.
   * 버튼(콘솔 마크업 순서 · 크기): 「URL로 다시 만들기」(24px) · 「이 지역에서 열기 ↗」 · 「리더(…)에서 열기 ↗」(28px, 강조 테두리 —
   * 시안 `openRegD`: 전역 · 팔로워) · 「수정」(28px) · 「삭제…」(28px, 위험 테두리 · 글). 쓰기 버튼은 쓸 수 있을 때만(시안 `writeD`).
   * 경로 줄은 위 막대가 그린다 — 시안 밖 하위 화면(URL로 다시 만들기)만 상세로 돌아갈 경로를 단다.
   * 「연결된 리소스」 탭의 수는 그 탭이 그리는 줄 수다(`relationRows`).
   */
  import { getContext, type Snippet } from 'svelte';
  import { page } from '$app/state';
  import { RESOURCES, itemOf, resourcePath, type ResourceKind } from '@web/resources';
  import { Badge, Button, DetailHeader, Skeleton, type Tone } from '#lib/ui';
  import DeleteConfirm from '#lib/lists/DeleteConfirm.svelte';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { openIn } from '#lib/global/open-in.ts';
  import { statusOf } from './facts';
  import { relationRows } from './relation-rows';
  import { headerMarks, isPendingResource } from '#lib/pending';

  let { kind, meta = [], mark: markOverride, edit, children }: {
    kind: ResourceKind;
    /** 제목 옆 상태 배지를 화면이 정한다(시안 `dpBadge` — 그 행의 첫 배지 칸). 주면 `statusOf` 대신 쓴다. */
    mark?: { tone: Tone; icon: string; text: string };
    /** 「수정」 자리를 화면이 정한다(인증서: 업로드는 「자료를 교체해요」). 주면 기본 「수정」 대신 그린다. 쓸 수 있을 때만 보인다. */
    edit?: Snippet;
    /**
     * 제목 아래 메타 줄 — 디자인 시스템 §5 「발급자 ACME  만료 2026-11-10  사용처 리스너 2 · SNI 3」.
     * 화면(라우트 레이아웃)이 그 리소스에서 아는 값만 채운다. 비우면 줄을 안 그린다.
     */
    meta?: readonly { label: string; value: string; mono?: boolean }[];
    children: Snippet;
  } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const spec = $derived(RESOURCES[kind]);
  const key = $derived(page.params['key'] ?? '');
  const item = $derived(itemOf(desk.model, kind, key));
  const base = $derived(resourcePath(kind, key));
  const rest = $derived(page.url.pathname.slice(base.length).replace(/^\//, '').replace(/\/$/, ''));
  const extraLabel: Record<string, string> = { rebuild: 'URL로 다시 만들기' };
  const extra = $derived(extraLabel[rest]);
  /** 「URL로 다시 만들기」 는 풀로 보내는 라우트에만 있다(시안 `action === 'proxy'`). 리다이렉트 · 거절에는 대상 풀이 없다. */
  const rebuildable = $derived((item?.['action'] as { kind?: unknown } | undefined)?.kind === 'proxy');
  const scope = getContext<Scope | undefined>('scope');
  // 쓸 수 없으면(지역을 안 골랐다 · 팔로워 · 고른 지역과 연락 없음) 만들기 · 수정 · 삭제를 안 보인다.
  const ro = $derived(scope?.blocked === true);
  let asking = $state(false);
  // 시안: 「연결된 리소스」 탭에 수를 단다 — 그 탭이 그리는 줄 수. 없으면 안 단다(시안 `cnt || ''`).
  const relCount = $derived(relationRows(desk, kind, key).length);
  const tabs = $derived(extra !== undefined ? undefined : spec.tabs.map((t) => ({
    key: t.slug, label: t.label, href: resourcePath(kind, key, t.slug), ...(t.slug === 'resources' && relCount > 0 ? { count: relCount } : {}),
  })));
  /** 시안 `openReg` — 그 지역(리더) GUI 의 같은 화면. */
  const openReg = $derived(openIn(scope, page.url.pathname));
  /** 제목 옆 상태 배지(시안) — 리스너 · 풀 · 백엔드. 모르면 안 단다. */
  const mark = $derived(markOverride ?? statusOf(desk, kind, key));
  /** 상태 배지 + 「◐ 적용 대기」(시안 `selPendD`) — 엔진이 돌리는 것과 head 가 다르면. 모든 리소스에 붙는다. */
  const marks = $derived(headerMarks(mark, isPendingResource(desk.pendingResources, kind, key)));
  const listHref = $derived(spec.base);
  /**
   * 방금 만든 리소스는 모델에 조금 늦게 온다 — 커밋 뒤 스트림의 `revision` 이벤트가 와야 다시 읽는다.
   * 그 사이에 「head 에 없어요」 를 보이면 저장이 실패한 것처럼 읽힌다. 그래서 주소가 바뀌고 3초는 기다린다.
   */
  let settled = $state(false);
  $effect(() => {
    void key;
    settled = false;
    const t = setTimeout(() => { settled = true; }, 3000);
    return () => clearTimeout(t);
  });
</script>

{#if !desk.live || (item === undefined && !settled)}
  <Skeleton height="120px" label="불러오는 중" />
{:else if item === undefined}
  <p class="empty">
    {spec.label} <span class="mono">{key}</span> 가 head 에 없어요. 이름을 확인하거나 <a href={listHref}>목록</a>으로 가요.
  </p>
{:else}
  <div class="frame">
    <DetailHeader
      crumbs={extra !== undefined ? [{ label: spec.label, href: listHref }, { label: key, href: base }, { label: extra }] : []}
      title={key} {meta} {tabs} currentTab={rest} tabLabel="{spec.label} 상세">
      {#snippet badges()}
        {#each marks as m (m.text)}<Badge tone={m.tone} icon={m.icon}>{m.text}</Badge>{/each}
        <!-- 전역에서 연 상세는 지역 꼬리표(시안 상세 머리의 지역 · 고정폭 12px · --tx3). -->
        {#if scope?.mode === 'global' && scope.region !== undefined}<span class="rtag">{scope.region.name}</span>{/if}
      {/snippet}
      {#snippet actions()}
        {#if !ro && spec.extras.includes('rebuild') && rebuildable && rest !== 'rebuild'}<Button size="xs" href={resourcePath(kind, key, 'rebuild')}>URL로 다시 만들기</Button>{/if}
        {#if openReg !== undefined}<Button size="sm" outline="accent" href={openReg.href} target="_blank" rel="noopener">{openReg.label}</Button>{/if}
        {#if !ro}
          {#if edit}{@render edit()}{:else if spec.editable}<Button size="sm" href={resourcePath(kind, key, 'settings')}>수정</Button>{/if}
          <Button size="sm" error disabled={desk.editing} onclick={() => { asking = true; }}>삭제…</Button>
        {/if}
      {/snippet}
    </DetailHeader>
    <div class="body">{@render children()}</div>
  </div>
  <!-- 목록과 같은 확인 — 이것을 실제로 쓰는 리소스를 줄마다 든다. 지우면 목록으로 간다. -->
  <DeleteConfirm bind:target={() => (asking ? { kind, key } : undefined), (t) => { asking = t !== undefined; }} href={listHref} />
{/if}

<style>
  .rtag { font: 12px var(--mono); color: var(--tx3); }
  .empty { color: var(--tx2); }
  .mono { font-family: var(--mono); }
  /* 시안 상세 카드는 화면 아래까지 늘어난다(콘솔 상세 블록 flex:1). */
  .frame { flex: 1; display: flex; flex-direction: column; border: 1px solid var(--bd); border-radius: var(--r-lg); overflow: hidden; background: var(--bg-page); }
  .body { flex: 1; padding: 16px 20px; background: var(--bg-panel); }
</style>
