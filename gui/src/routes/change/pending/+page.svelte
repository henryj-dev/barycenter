<script lang="ts">
  /**
   * 적용 대기 — 위는 영향과 적용, 아래는 리비전 롤백 (시안).
   *
   * **전체 합산**(전역에서 지역을 안 골랐다, 2026-11-04 · §2.5)이면 왼쪽에 지역마다 한 항목(시안 `groupsOf`)을 두고,
   * 고른 지역의 영향 · 「지울 것」 · 롤백을 그 지역의 desk 로 그린다(`InRegion`). 적용 · 롤백은 그 지역 하나로 간다 —
   * 확인 창이 지역 이름을 쓴다(§1.1). 연락 없는 지역은 고르면 막힌 사유만 쓴다(지난 값을 지금 값처럼 보이지 않는다, §2.4).
   */
  import { getContext } from 'svelte';
  import PendingImpact from '#lib/ops/PendingImpact.svelte';
  import RevisionRollback from '#lib/ops/RevisionRollback.svelte';
  import InRegion from '#lib/global/InRegion.svelte';
  import { useAggregate } from '#lib/global/use-aggregate.svelte.ts';
  import { LOST_MESSAGE } from '#lib/global/scope.svelte.ts';
  import { groupAudit } from '#lib/ops/audit';
  import { pendingDefault, pendingRow, pendingShown, type PendingFact } from '#lib/ops/aggregate-view';
  import { FieldMessage, Skeleton } from '#lib/ui';
  import type { createDesk } from '#lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const agg = useAggregate();

  /** 지역마다 적용 대기 사실. 붙지 않은 지역은 상태만 — 값은 읽지 않는다. */
  const facts = $derived<PendingFact[]>(agg.entries.map((e) => {
    if (e.state !== 'ok') return { name: e.name, state: e.state, pending: [] };
    const d = e.desk;
    const revs = d.status.pending.map((p) => p.revision);
    const groups = groupAudit(d.audit.rows, revs);
    const by = [...new Set(revs.map((r) => groups.find((g) => g.change && g.revision === r)?.who).filter((w): w is string => w !== undefined))].join(', ');
    return { name: e.name, state: e.state, head: d.head, view: d.view, pending: revs, failed: d.failedApply, by };
  }));
  /** 사람이 고른 지역. 고르기 전에는 적용 대기가 있는 첫 지역 — 붙은 지역을 정하면 고정한다(적용한 뒤에도 그 결과가 남게). */
  let picked = $state<string | undefined>();
  const fallback = $derived(pendingDefault(facts));
  $effect(() => {
    if (picked !== undefined || fallback === undefined) return;
    const f = facts.find((x) => x.name === fallback);
    if (f?.state === 'ok' && (f.view !== undefined || f.failed !== undefined || facts.every((x) => x.state !== 'loading'))) picked = fallback;
  });
  const selected = $derived(picked ?? fallback);
  const plans = $derived(pendingShown(facts, selected).map((f) => pendingRow(f, LOST_MESSAGE)));
  const entry = $derived(selected === undefined ? undefined : agg.entry(selected));
</script>

<div class="pend">
  {#if agg.on}
    {#if entry === undefined}
      {#if agg.listState.loading}<Skeleton height="200px" label="지역에 연결하는 중" />{:else}<FieldMessage tone="error">{agg.listState.error ?? '지역이 없어요.'}</FieldMessage>{/if}
    {:else}
      {#key entry.name}
        <InRegion {entry}>
          <PendingImpact {plans} picked={entry.name} onpick={(name) => { picked = name; }} />
          {#if entry.state === 'ok' && entry.desk.live}<RevisionRollback />{/if}
        </InRegion>
      {/key}
    {/if}
  {:else}
    <PendingImpact />
    {#if desk.live}<RevisionRollback />{/if}
  {/if}
</div>

<style>
  /* 시안 `pnDisp`: 위 영향 · 아래 롤백, 간격 16px. */
  .pend { display: flex; flex-direction: column; gap: 16px; }
</style>
