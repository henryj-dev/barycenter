<script lang="ts">
  /**
   * 상태 — head · 리더 · 게시 · 미완 전환 · 엔진 · 드라이버 (`/api/v1/status` 의 4-way).
   * 미완 전환이 있으면 위에 배너를 띄우고 「이어받기」 를 둔다. 전역 모드면 버튼을 안 그린다(설계 §1).
   */
  import { getContext } from 'svelte';
  import { Banner, Button, Card, DataTable, DescriptionList, FieldMessage, Skeleton, type Column } from '#lib/ui';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';

  type Pend = { planId: string; revision: string };
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const ro = $derived(scope?.readOnly === true);
  const v = $derived(desk.status);
  const items = $derived([
    { label: 'head', value: v.head === undefined ? '—' : `r${v.head}`, mono: true },
    {
      label: '리더',
      value: `${v.leader.isLeader ? '★ 이 인스턴스' : '☆ 아니에요'} · ${v.leader.holder}${v.leader.reason ? ` — ${v.leader.reason}` : ''}`,
      ...(v.leader.isLeader ? { tone: 'ok' as const } : {}),
    },
    { label: '게시', value: `${v.published.kind}${v.published.generation ? ` · ${v.published.generation}` : ''}`, mono: true },
    {
      label: '미완 전환',
      value: v.unfinished ? '▲ 있어요 — 복구 대상이에요' : '없어요',
      ...(v.unfinished ? { tone: 'warn' as const } : { tone: 'ok' as const }),
    },
    { label: '엔진', value: v.engine.label, mono: true },
    { label: '드라이버', value: v.driver.loaded ? (v.driver.name ?? '실었어요') : '안 실었어요', mono: true },
  ]);
  const columns: Column<Pend>[] = [
    { key: 'planId', label: 'plan', mono: true, text: (r) => r.planId },
    { key: 'revision', label: '리비전', mono: true, text: (r) => `r${r.revision}`, width: '120px' },
  ];
</script>

{#if !desk.live}
  <Skeleton height="160px" label="연결하는 중" />
{:else}
  <div class="st">
    {#if v.unfinished}
      <Banner tone="warn">
        끝나지 않은 전환이 있어요. 복구가 이어받아야 다음 적용을 할 수 있어요.
        {#snippet action()}
          {#if !ro}<Button size="sm" loading={desk.recovering} onclick={() => { void desk.recover(); }}>{desk.recovering ? '이어받는 중' : '이어받기'}</Button>{/if}
        {/snippet}
      </Banner>
    {/if}
    <Card title="상태"><DescriptionList labelWidth="120px" {items} /></Card>
    <Card title="적용 대기 plan" sub={v.pending.length > 0 ? `${v.pending.length}개` : undefined} padded={false}>
      {#if v.pending.length === 0}
        <div class="pad"><FieldMessage>대기 중인 plan 이 없어요.</FieldMessage></div>
      {:else}
        <DataTable rows={v.pending} rowKey={(r) => r.planId} {columns} label="적용 대기 plan" minHeight="0" />
      {/if}
    </Card>
  </div>
{/if}

<style>
  .st { display: flex; flex-direction: column; gap: 16px; max-width: 860px; }
  .pad { padding: 12px 16px; }
</style>
