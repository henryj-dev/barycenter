<script lang="ts">
  /**
   * 변경 초안 (2026-11-21) — 커밋하지 않은 changeset(`open` · `sealed`).
   *
   * 「저장」 이 충돌로 실패하면(남이 먼저 커밋했다 · 서버 오류) 바꾼 내용이 여기 남는다. 「JSON 으로 고치기」 의
   * 「초안으로 두기」 도 여기로 온다. 한 초안을 고르면 바꿀 것 · 계획한 영향이 보이고, 커밋할 수 있다.
   * head 가 바뀐 초안(`stale`)은 그대로 커밋하면 PLAN_STALE 이다 — 「최신 head 로 다시 계획」 이 같은 내용을 지금 head 위에 다시 연다.
   * 쓸 수 없으면(팔로워 · 연락 없음 · 전체 합산) 동작을 숨기고 `WriteNote` 가 이유를 말한다.
   */
  import { getContext } from 'svelte';
  import { draftMark, draftSummary, impactLines, opLine, type DraftRow } from '@web/drafts-view';
  import type { Impact } from '@web/impact-view';
  import { b, m, x, Badge, Button, ConfirmDialog, DataTable, FieldMessage, type Column, type MenuItem } from '#lib/ui';
  import { after } from '#lib/after';
  import WriteNote from '#lib/global/WriteNote.svelte';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const blocked = $derived(scope?.blocked === true);
  const aggregate = $derived(scope?.mode === 'global' && scope.region === undefined);

  let rows = $state<DraftRow[] | undefined>();
  let failed = $state(false);
  let selected = $state<string | undefined>();
  let plan = $state<{ draft: string; id: string; impact: Impact } | undefined>();
  let discarding = $state<DraftRow | undefined>();

  const load = (): void => {
    void desk.drafts().then((r) => {
      failed = r === undefined;
      rows = r ?? [];
      if (selected !== undefined && !rows.some((d) => d.id === selected)) selected = undefined;
    });
  };
  // head 가 바뀌면 다시 읽는다 — `stale` 이 바뀐다.
  $effect(() => {
    void desk.head;
    if (!desk.live || aggregate) return;
    load();
  });

  const current = $derived(rows?.find((d) => d.id === selected));
  const when = (iso: string): string => (iso === '' ? '—' : new Date(iso).toLocaleString());

  const columns: Column<DraftRow>[] = [
    { key: 'what', label: '바꿀 것', value: (d) => x(draftSummary(d)), sort: true, hideable: false },
    { key: 'state', label: '상태', value: (d) => { const k = draftMark(d); return b(k.tone, '', k.text); } },
    { key: 'base', label: '바탕', value: (d) => m(`r${d.baseRevision}`), sort: (d) => Number(d.baseRevision) },
    { key: 'ops', label: '변경 수', align: 'right', value: (d) => m(d.ops), sort: (d) => d.ops },
    { key: 'by', label: '만든 사람', value: (d) => x(d.createdBy), sort: true },
    { key: 'at', label: '만든 때', value: (d) => x(when(d.createdAt)), sort: (d) => d.createdAt },
  ];

  const doPlan = (d: DraftRow): void => {
    selected = d.id;
    void desk.planDraft(d.id).then((p) => {
      if (p !== undefined) plan = { draft: d.id, ...p };
      load();
    });
  };
  const doRebase = (d: DraftRow): void => {
    void desk.rebaseDraft(d.id).then((r) => {
      if (r !== undefined) { selected = r.id; plan = { draft: r.id, ...r.plan }; }
      load();
    });
  };
  const doReopen = (d: DraftRow): void => {
    void desk.reopenDraft(d.id).then(() => { if (plan?.draft === d.id) plan = undefined; load(); });
  };
  const doCommit = (): void => {
    const p = plan;
    if (p === undefined) return;
    void desk.commitDraft(p.draft, p.id).then((ok) => {
      if (ok) { plan = undefined; selected = undefined; }
      after(undefined, '초안을 커밋했어요')(ok);
      load();
    });
  };
  const doDiscard = (): void => {
    const d = discarding;
    if (d === undefined) return;
    void desk.discardDraft(d.id).then((ok) => {
      discarding = undefined;
      if (ok && plan?.draft === d.id) plan = undefined;
      load();
    });
  };

  const menu = (d: DraftRow): MenuItem[] => blocked ? [{ label: '보기', onselect: () => { selected = d.id; } }] : [
    { label: '보기', onselect: () => { selected = d.id; } },
    ...(d.stale
      ? [{ label: '최신 head 로 다시 계획', onselect: () => doRebase(d) }]
      : [{ label: '계획하고 영향 보기', onselect: () => doPlan(d) }]),
    ...(d.state === 'sealed' ? [{ label: '다시 열기', onselect: () => doReopen(d) }] : []),
    { label: '버리기…', danger: true, onselect: () => { discarding = d; } },
  ];
</script>

{#if aggregate}
  <WriteNote />
{:else}
  <div class="dr">
    {#if blocked}<WriteNote />{/if}
    {#if failed}<FieldMessage tone="error">초안 목록을 읽지 못했어요.</FieldMessage>{/if}
    <DataTable rows={rows ?? []} loading={rows === undefined} rowKey={(d) => d.id} {columns} label="변경 초안"
      rowMenu={menu} onopen={(d) => { selected = d.id; }}
      emptyTitle="초안이 없어요"
      emptyBody="저장이 충돌로 실패하면 바꾼 내용이 여기 남아요. 「JSON 으로 고치기」 에서 「초안으로 두기」 를 눌러도 여기 와요."
      minHeight="0" />

    {#if current !== undefined}
      <section class="panel" aria-label="초안 내용">
        <div class="ph">
          <span>초안 <code>{current.id.slice(0, 8)}</code></span>
          {#each [draftMark(current)] as k}<Badge tone={k.tone} icon={null}>{k.text}</Badge>{/each}
          <span class="sp"></span>
          {#if !blocked}
            {#if current.stale}
              <Button size="sm" variant="primary" loading={desk.editing} onclick={() => doRebase(current)}>최신 head 로 다시 계획</Button>
            {:else}
              <Button size="sm" loading={desk.editing} onclick={() => doPlan(current)}>계획하고 영향 보기</Button>
            {/if}
            <Button size="sm" variant="danger" onclick={() => { discarding = current; }}>버리기…</Button>
          {/if}
        </div>
        {#if current.stale}
          <FieldMessage tone="warn">이 초안의 바탕(r{current.baseRevision})이 지금 head(r{desk.head ?? '?'})와 달라요. 그대로는 커밋할 수 없어요 — 「최신 head 로 다시 계획」 을 눌러요.</FieldMessage>
        {/if}
        <ol class="ops">
          {#each current.patch as op, i (i)}<li>{opLine(op)}</li>{/each}
        </ol>
        {#if plan !== undefined && plan.draft === current.id}
          <div class="plan">
            <div class="pt">계획 <code>{plan.id.slice(0, 8)}</code></div>
            <ul>
              {#each impactLines(plan.impact) as l, i (i)}<li class={l.tone}>{l.tone === 'ok' ? '●' : '▲'} {l.text}</li>{/each}
            </ul>
            {#if !blocked}
              <div class="pa">
                <Button variant="primary" loading={desk.editing} onclick={doCommit}>커밋</Button>
                <span class="hint">커밋하면 적용 대기에 들어가요. 트래픽은 적용해야 바뀌어요.</span>
              </div>
            {/if}
          </div>
        {/if}
      </section>
    {/if}
  </div>
{/if}

{#if discarding !== undefined}
  <ConfirmDialog open title="초안을 버려요" sub={draftSummary(discarding)}
    lines={[{ tone: 'warn', icon: '▲', text: '버린 초안은 되살릴 수 없어요. 감사 기록에는 남아요.' }]}
    confirmLabel="버리기" busy={desk.editing}
    oncancel={() => { discarding = undefined; }} onconfirm={doDiscard} />
{/if}

<style>
  .dr { display: flex; flex-direction: column; gap: 16px; }
  .panel { padding: 14px 16px; background: var(--bg-panel); border: 1px solid var(--bd); border-radius: var(--r-lg); display: flex; flex-direction: column; gap: 10px; }
  .ph { display: flex; align-items: center; gap: 8px; font-weight: 600; flex-wrap: wrap; }
  .sp { flex: 1; }
  .ops { margin: 0; padding-left: 20px; font-family: var(--mono); font-size: 13px; color: var(--tx2); display: flex; flex-direction: column; gap: 2px; }
  .plan { border-top: 1px solid var(--bd); padding-top: 10px; display: flex; flex-direction: column; gap: 8px; }
  .pt { font-size: 12px; color: var(--tx3); }
  .plan ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 2px; font-size: 13px; }
  .ok { color: var(--ok, var(--tx2)); }
  .warn { color: var(--warn, var(--tx2)); }
  .danger { color: var(--danger, var(--tx2)); }
  .pa { display: flex; align-items: center; gap: 10px; }
  .hint { font-size: 12px; color: var(--tx3); }
  code { font-family: var(--mono); }
</style>
