<script lang="ts">
  /**
   * 작업 (2026-11-21) — 적용 · 롤백 · 다시 렌더가 남긴 전환(오퍼레이션). `GET /api/v1/operations` · `/operations/:id`.
   *
   * `?id=<오퍼레이션>` 으로 열면 그 전환을 고른다 — 상태 화면의 「끝나지 않은 전환」 띠가 여기로 온다.
   * 끝나지 않은 전환은 「작업 취소…」 할 수 있다(apply 범위). 예약한 슬롯을 반납하고 실패로 닫는다.
   * **활성화된 것은 되돌리지 않는다** — 그건 롤백이고, 적용 대기 화면에 있다.
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { cancellable, detailFacts, parseOperation, phaseMark, type OperationRow } from '@web/operations-view';
  import { b, m, x, Badge, Button, ConfirmDialog, DataTable, DescriptionList, FieldMessage, type Column, type MenuItem } from '#lib/ui';
  import WriteNote from '#lib/global/WriteNote.svelte';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const blocked = $derived(scope?.blocked === true);
  const aggregate = $derived(scope?.mode === 'global' && scope.region === undefined);

  let rows = $state<OperationRow[] | undefined>();
  let failed = $state(false);
  let selected = $state<string | undefined>();
  /** 목록 밖의 전환(오래된 것)을 `?id=` 로 열었을 때. */
  let extra = $state<OperationRow | null | undefined>();
  let cancelling = $state<OperationRow | undefined>();

  $effect(() => {
    const id = page.url.searchParams.get('id');
    if (id !== null && id !== '') selected = id;
  });

  const load = (): void => {
    void desk.operations(50).then((r) => {
      failed = r === undefined;
      rows = r ?? [];
      const id = selected;
      if (id !== undefined && !rows.some((o) => o.id === id)) {
        void desk.operation(id).then((o) => { extra = o; });
      }
    });
  };
  // 상태가 바뀌면(적용 · 단계 진행) 다시 읽는다.
  $effect(() => {
    void desk.status;
    void desk.head;
    if (!desk.live || aggregate) return;
    load();
  });

  const current = $derived(rows?.find((o) => o.id === selected) ?? (extra?.id === selected ? extra ?? undefined : undefined));
  const when = (iso: string | null): string => (iso === null ? '—' : new Date(iso).toLocaleString());

  const columns: Column<OperationRow>[] = [
    { key: 'gen', label: '세대', value: (o) => m(o.generation), sort: true, hideable: false },
    { key: 'phase', label: '단계', value: (o) => { const k = phaseMark(o.phase); return b(k.tone, o.terminal ? '' : '◐', k.text); }, sort: (o) => o.phase },
    { key: 'rev', label: '리비전', value: (o) => m(`r${o.revision}`), sort: (o) => Number(o.revision) },
    { key: 'by', label: '누가', value: (o) => x(o.createdBy ?? '—'), sort: true },
    { key: 'at', label: '시작', value: (o) => x(when(o.createdAt)), sort: (o) => o.createdAt ?? '' },
    { key: 'upd', label: '마지막 단계', value: (o) => x(when(o.updatedAt)), sort: (o) => o.updatedAt ?? '', hidden: true },
  ];

  const menu = (o: OperationRow): MenuItem[] => [
    { label: '보기', onselect: () => { selected = o.id; } },
    ...(!blocked && cancellable(o) ? [{ label: '작업 취소…', danger: true, onselect: () => { cancelling = o; } }] : []),
  ];

  const doCancel = (): void => {
    const o = cancelling;
    if (o === undefined) return;
    void desk.cancelOperation(o.id).then(() => { cancelling = undefined; load(); });
  };

  const facts = $derived(current === undefined ? [] : [
    { label: '단계', value: phaseMark(current.phase).text },
    { label: '세대', value: current.generation },
    { label: '리비전', value: `r${current.revision}` },
    { label: '활성화 순번', value: current.activationEpoch },
    { label: '계획', value: current.planId },
    { label: '누가', value: current.createdBy ?? '—' },
    { label: '시작', value: when(current.createdAt) },
    { label: '마지막 단계', value: when(current.updatedAt) },
    ...detailFacts(current.detail),
  ]);
  // 원문 확인용 — 화면이 고르지 않은 칸도 볼 수 있게.
  const raw = $derived(current === undefined ? '' : JSON.stringify(parseOperation(current)?.detail ?? null, null, 2));
</script>

{#if aggregate}
  <WriteNote />
{:else}
  <div class="op">
    {#if blocked}<WriteNote />{/if}
    {#if failed}<FieldMessage tone="error">작업 목록을 읽지 못했어요.</FieldMessage>{/if}
    <DataTable rows={rows ?? []} loading={rows === undefined} rowKey={(o) => o.id} {columns} label="작업"
      rowMenu={menu} onopen={(o) => { selected = o.id; }}
      emptyTitle="작업이 없어요" emptyBody="적용 · 롤백 · 다시 렌더를 하면 여기 남아요." minHeight="0" />

    {#if selected !== undefined && current === undefined && extra === null}
      <FieldMessage tone="error">작업 <code>{selected}</code> 이 없어요.</FieldMessage>
    {/if}
    {#if current !== undefined}
      <section class="panel" aria-label="작업 내용">
        <div class="ph">
          <span>작업 <code>{current.id.slice(0, 8)}</code></span>
          {#each [phaseMark(current.phase)] as k}<Badge tone={k.tone}>{k.text}</Badge>{/each}
          {#if !current.terminal}<Badge tone="warn" icon={null}>◐ 끝나지 않았어요</Badge>{/if}
          <span class="sp"></span>
          {#if !blocked && cancellable(current)}
            <Button size="sm" variant="danger" onclick={() => { cancelling = current; }}>작업 취소…</Button>
          {/if}
        </div>
        <DescriptionList labelWidth="120px" items={facts} />
        <details><summary>detail 원문</summary><pre>{raw}</pre></details>
      </section>
    {/if}
  </div>
{/if}

{#if cancelling !== undefined}
  <ConfirmDialog open title="작업을 취소해요" sub={`세대 ${cancelling.generation} · r${cancelling.revision}`}
    lines={[
      { tone: 'warn', icon: '▲', text: '예약한 슬롯을 반납하고 이 전환을 실패로 닫아요.' },
      { tone: 'ok', icon: '●', text: '지금 활성인 세대는 그대로예요. 트래픽은 바뀌지 않아요.' },
      { tone: 'warn', icon: '▲', text: '이 리비전을 다시 올리려면 적용 대기에서 다시 적용해요.' },
    ]}
    confirmLabel="작업 취소" requireCheck busy={desk.editing}
    oncancel={() => { cancelling = undefined; }} onconfirm={doCancel} />
{/if}

<style>
  .op { display: flex; flex-direction: column; gap: 16px; }
  .panel { padding: 14px 16px; background: var(--bg-panel); border: 1px solid var(--bd); border-radius: var(--r-lg); display: flex; flex-direction: column; gap: 10px; }
  .ph { display: flex; align-items: center; gap: 8px; font-weight: 600; flex-wrap: wrap; }
  .sp { flex: 1; }
  pre { font-family: var(--mono); font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--tx2); margin: 6px 0 0; }
  summary { cursor: pointer; font-size: 12px; color: var(--tx3); }
  code { font-family: var(--mono); }
</style>
