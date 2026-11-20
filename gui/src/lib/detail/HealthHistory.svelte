<script lang="ts">
  /**
   * 「헬스 기록」 (2026-11-20) — 풀 · 백엔드 개요의 맨 아래. 판정이 바뀐 때마다 한 줄, 최근 것부터.
   *
   * `GET /api/v1/{pools|backends}/:id/health-history` 를 읽는다. 한 줄은 시각 · 바뀐 판정(앞 → 뒤) · 그때 프로버가 한 말이다.
   * 풀은 소속 백엔드마다 이름을 달고, 그 이름은 백엔드 상세로 간다. 20줄씩 「더 보기」 로 넘긴다.
   * 이 화면이 붙은 지역의 기록이다(`desk` 가 지역을 고른다). 관련 백엔드의 판정이 바뀌면 다시 읽는다.
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { itemsOf, resourcePath } from '@web/resources';
  import { Button, FieldMessage } from '#lib/ui';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import { inRegion } from '#lib/global/aggregate.ts';
  import { whenText } from '#lib/ops/audit';
  import type { HealthHistoryEvent, createDesk } from '#lib/desk.svelte.ts';
  import { HEALTH_MARK } from './facts';

  let { kind, key: given }: { kind: 'pool' | 'backend'; key?: string } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const link = (path: string): string => (scope?.fixed === true && scope.region !== undefined ? inRegion(path, scope.region.name) : path);
  const key = $derived(given ?? page.params['key'] ?? '');

  /** 관련 백엔드의 지금 판정을 한 줄로 — 이것이 바뀌면(새 기록이 생겼으면) 다시 읽는다. */
  const watch = $derived.by(() => {
    const mine = kind === 'backend'
      ? (k: string) => k === key
      : (() => {
        const members = new Set(itemsOf(desk.model, 'backend').filter((b) => b['pool'] === key).map((b) => String(b['key'])));
        return (k: string) => members.has(k) || k.startsWith(`disc~${key}~`);
      })();
    return desk.health.filter((h) => mine(h.backendKey)).map((h) => `${h.backendKey}=${h.state}`).sort().join(',');
  });

  let events = $state<HealthHistoryEvent[]>([]);
  let next = $state<string | undefined>();
  let failed = $state(false);
  let loaded = $state(false);
  let more = $state(false);

  $effect(() => {
    void watch;
    const k = key;
    const kd = kind;
    let stop = false;
    void desk.healthHistory(kd, k).then((p) => {
      if (stop) return;
      loaded = true;
      failed = p === undefined;
      events = p?.events ?? [];
      next = p?.next;
    });
    return () => { stop = true; };
  });

  const loadMore = async (): Promise<void> => {
    if (next === undefined) return;
    more = true;
    const p = await desk.healthHistory(kind, key, next).catch(() => undefined);
    more = false;
    if (p === undefined) { failed = true; return; }
    events = [...events, ...p.events];
    next = p.next;
  };

  const mark = (s: HealthHistoryEvent['to']) => (s === 'healthy' ? HEALTH_MARK.healthy : s === 'unhealthy' ? HEALTH_MARK.unhealthy : HEALTH_MARK.none);
</script>

<div class="hist" role="group" aria-label="헬스 기록">
  <div class="t">헬스 기록</div>
  {#if failed && events.length === 0}
    <FieldMessage>헬스 기록을 읽지 못했어요.</FieldMessage>
  {:else if loaded && events.length === 0}
    <div class="empty">판정이 바뀐 기록이 없어요. 기록은 30일 동안 남아요.</div>
  {:else}
    <ol class="rows">
      {#each events as e (e.seq)}
        {@const to = mark(e.to)}
        <li class="row">
          <span class="when">{whenText(e.at)}</span>
          {#if kind === 'pool'}<a class="b mono" href={link(resourcePath('backend', e.backendKey))}>{e.backendKey}</a>{/if}
          <span class="flip">
            {#if e.from === null}<span class="from">처음</span>{:else}{@const fr = mark(e.from)}<span class="from" style:color="var(--{fr.tone})">{fr.icon} {fr.text}</span>{/if}
            <span aria-hidden="true">→</span>
            <span style:color="var(--{to.tone})">{to.icon} {to.text}</span>
          </span>
          {#if e.detail !== undefined}<span class="d">{e.detail}</span>{/if}
        </li>
      {/each}
    </ol>
    {#if failed}<FieldMessage>다음 기록을 읽지 못했어요.</FieldMessage>{/if}
    {#if next !== undefined}
      <div><Button variant="text" size="sm" loading={more} onclick={() => { void loadMore(); }}>더 보기</Button></div>
    {/if}
  {/if}
</div>

<style>
  .hist {
    display: flex; flex-direction: column; gap: 8px; margin-top: 16px; padding: 10px 12px;
    border: 1px solid var(--bd); border-radius: var(--r-md); font: var(--t-small);
  }
  .t { font: var(--t-cap); font-weight: 600; color: var(--tx2); }
  .empty { color: var(--tx2); }
  .rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .row { display: grid; grid-template-columns: 110px auto 1fr; gap: 4px 12px; align-items: baseline; }
  .row:has(.b) { grid-template-columns: 110px minmax(0, 220px) auto 1fr; }
  .when { color: var(--tx2); font-variant-numeric: tabular-nums; }
  .b { color: var(--tx); text-decoration: none; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .b:hover { text-decoration: underline; }
  .flip { display: inline-flex; gap: 6px; white-space: nowrap; }
  .from { color: var(--tx2); }
  .d { color: var(--tx2); grid-column: 1 / -1; padding-left: 122px; overflow-wrap: anywhere; }
  .mono { font-family: var(--mono); }
  @media (max-width: 640px) {
    .row, .row:has(.b) { grid-template-columns: 1fr; }
    .d { padding-left: 0; }
  }
</style>
