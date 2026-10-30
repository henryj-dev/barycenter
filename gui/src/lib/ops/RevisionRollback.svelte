<script lang="ts">
  /**
   * 리비전 롤백 — 적용 대기 화면 아래 구획 (시안).
   * 롤백은 옛 내용으로 **새 리비전**을 만든다. 트래픽은 위에서 적용해야 바뀐다. 누르면 확인 대화상자가 뜬다.
   */
  import { getContext } from 'svelte';
  import { Badge, Button, Card, ConfirmDialog, DataTable, FieldMessage, type Column } from '#lib/ui';
  import { after } from '#lib/after';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';

  type Rev = {
    revision: string; parent: string | null; rollbackOf: string | null; createdAt: string;
    createdBy: string; note: string | null; changeset: string | null;
  };
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const ro = $derived(scope?.readOnly === true);
  let rows = $state<Rev[] | undefined>();
  let failed = $state(false);
  let target = $state<string | undefined>();
  let asking = $state(false);
  $effect(() => {
    void desk.head;
    if (!desk.live) return;
    void desk.revisions().then((r) => { failed = r === undefined; rows = (r ?? []) as Rev[]; });
  });

  const columns: Column<Rev>[] = [
    { key: 'revision', label: '리비전', mono: true, width: '140px', sort: (r) => Number(r.revision) },
    { key: 'who', label: '누가', mono: true, text: (r) => r.createdBy, sort: (r) => r.createdBy },
    { key: 'at', label: '언제', muted: true, text: (r) => new Date(r.createdAt).toLocaleString(), sort: (r) => r.createdAt },
    { key: 'note', label: '메모', muted: true, hideable: true, text: (r) => r.note ?? '' },
    { key: 'act', label: '', align: 'right', width: '170px' },
  ];
  const ask = (rev: string): void => { target = rev; asking = true; };
</script>

{#snippet cell(r: Rev, c: Column<Rev>)}
  {#if c.key === 'revision'}
    <span class="rev"><code>r{r.revision}</code>
      {#if r.revision === desk.head}<Badge tone="ok" icon={null}>head</Badge>{/if}
      {#if r.rollbackOf !== null}<Badge tone="pending" icon={null}>r{r.rollbackOf} 로 롤백</Badge>{/if}
    </span>
  {:else if c.key === 'act'}
    {#if !ro && r.revision !== desk.head}
      <Button size="sm" disabled={desk.editing} onclick={() => ask(r.revision)}>이 리비전으로 롤백</Button>
    {/if}
  {:else}{c.text?.(r) ?? ''}{/if}
{/snippet}

<Card title="리비전 롤백" sub="옛 내용으로 새 리비전을 만들어요" padded={false}>
  {#if failed}
    <div class="pad"><FieldMessage>리비전 목록을 못 읽었어요. 전역 화면은 지역의 리비전을 중계하지 않아요. 그 지역의 GUI 에서 해요.</FieldMessage></div>
  {:else}
    <DataTable rows={rows ?? []} loading={rows === undefined} rowKey={(r) => r.revision} {columns} {cell} label="리비전" emptyTitle="리비전이 없어요" pageSize={20} minHeight="0" />
  {/if}
</Card>

<ConfirmDialog
  bind:open={asking}
  title="r{target ?? ''} 의 내용으로 새 리비전을 만들어요"
  sub="롤백은 커밋까지예요. 트래픽은 위에서 적용해야 바뀌어요."
  lines={[{ tone: 'warn', icon: '▲', text: `head r${desk.head ?? '?'} 다음에 새 리비전이 생겨요. 그 사이의 변경은 기록에 남아요.` }]}
  confirmLabel="롤백해요" danger={false} busy={desk.editing}
  onconfirm={() => { const t = target; if (t === undefined) return; void desk.rollback(t).then((ok) => { asking = false; after(undefined, `r${t} 의 내용으로 새 리비전을 만들었어요`)(ok); }); }}
/>

<style>
  .rev { display: inline-flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  code { font-family: var(--mono); }
  .pad { padding: 12px 16px; }
</style>
