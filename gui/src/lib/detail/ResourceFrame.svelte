<script lang="ts">
  /**
   * 상세 화면의 틀 — 모든 리소스가 같다 (2026-10-30, 경로 분리 #124).
   *
   * 디자인 시스템의 상세 머리(`DetailHeader`)로 경로 · 제목 · 버튼 · 탭을 그린다. 탭 내용은 그 아래 라우트 파일이 그린다.
   * 탭은 **주소다**(`<key>/settings` …) — 새로고침·북마크·링크가 그 탭으로 바로 온다.
   */
  import { getContext, type Snippet } from 'svelte';
  import { page } from '$app/state';
  import { RESOURCES, itemOf, resourcePath, type ResourceKind } from '@web/resources';
  import { Badge, Button, DetailHeader, Skeleton } from '#lib/ui';
  import DeleteConfirm from '#lib/lists/DeleteConfirm.svelte';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { relationCount, statusOf } from './facts';

  let { kind, children }: { kind: ResourceKind; children: Snippet } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const spec = $derived(RESOURCES[kind]);
  const key = $derived(page.params['key'] ?? '');
  const item = $derived(itemOf(desk.model, kind, key));
  const base = $derived(resourcePath(kind, key));
  const rest = $derived(page.url.pathname.slice(base.length).replace(/^\//, '').replace(/\/$/, ''));
  const extraLabel: Record<string, string> = { rebuild: 'URL로 다시 만들기' };
  const extra = $derived(extraLabel[rest]);
  const scope = getContext<Scope | undefined>('scope');
  const ro = $derived(scope?.readOnly === true);
  let asking = $state(false);
  // 시안: 「연결된 리소스」 탭에 수를 단다.
  const relCount = $derived(relationCount(desk, kind, key));
  const tabs = $derived(extra !== undefined ? undefined : spec.tabs.map((t) => ({
    key: t.slug, label: t.label, href: resourcePath(kind, key, t.slug), ...(t.slug === 'resources' ? { count: relCount } : {}),
  })));
  /** 제목 옆 상태 배지(시안) — 리스너 · 풀 · 백엔드. 모르면 안 단다. */
  const mark = $derived(statusOf(desk, kind, key));
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
      crumbs={[{ label: spec.label, href: listHref }, ...(extra !== undefined ? [{ label: key, href: base }, { label: extra }] : [{ label: key }])]}
      title={key} {tabs} currentTab={rest} tabLabel="{spec.label} 상세">
      {#snippet badges()}
        {#if mark !== undefined}<Badge tone={mark.tone} icon={mark.icon}>{mark.text}</Badge>{/if}
      {/snippet}
      {#snippet actions()}
        {#if !ro}
          {#if spec.editable && rest !== 'settings'}<Button href={resourcePath(kind, key, 'settings')}>수정</Button>{/if}
          {#if spec.extras.includes('rebuild') && rest !== 'rebuild'}<Button href={resourcePath(kind, key, 'rebuild')}>URL로 다시 만들기</Button>{/if}
          <Button error disabled={desk.editing} onclick={() => { asking = true; }}>삭제…</Button>
        {/if}
      {/snippet}
    </DetailHeader>
    <div class="body">{@render children()}</div>
  </div>
  <!-- 목록과 같은 확인 — 이것을 실제로 쓰는 리소스를 줄마다 든다. 지우면 목록으로 간다. -->
  <DeleteConfirm bind:target={() => (asking ? { kind, key } : undefined), (t) => { asking = t !== undefined; }} href={listHref} />
{/if}

<style>
  .empty { color: var(--tx2); }
  .mono { font-family: var(--mono); }
  .frame { border: 1px solid var(--bd); border-radius: var(--r-lg); overflow: hidden; background: var(--bg-page); }
  .body { padding: 16px 20px; background: var(--bg-panel); }
</style>
