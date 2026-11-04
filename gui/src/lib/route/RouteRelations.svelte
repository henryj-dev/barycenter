<script lang="ts">
  /**
   * 라우트 상세의 「연결된 리소스」 탭 — 콘솔 시안 `relExtra('routes')`: 리스너(이 라우트가 속한 리스너) · 풀(트래픽을 보낼 풀) ·
   * 평가 순서(우선순위 기준). 한 줄이 100px · 이름(고정폭) · 설명이다.
   *
   * 시안과 다른 곳(이미 있는 기능): 출발지 규칙이 보내는 풀도 한 줄씩 더하고, head 에 없는 대상은 「head 에 없어요」 로 말한다
   * (`relationsOf` — 검증기의 참조 규칙과 같은 필드). 평가 순서는 엔진이 실제로 보는 순서다.
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { itemOf, relationsOf } from '@web/resources';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { routeFactsOf } from './route-facts';

  let { kind }: { kind: 'httpRoute' | 'passthroughRoute' } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const facts = $derived(routeFactsOf(desk, kind, key));
  const missing = $derived(new Set(relationsOf(desk.model, { kind, key }).uses.filter((u) => u.missing).map((u) => `${u.to.kind}/${u.to.key}`)));
  type Row = { k: string; n: string; note: string; missing: boolean };
  const rows = $derived.by((): Row[] => {
    const f = facts;
    if (f === undefined) return [];
    const item = itemOf(desk.model, kind, key);
    const rules = Array.isArray(item?.['sourceRules']) ? item['sourceRules'] as { action?: { kind?: unknown; pool?: unknown } }[] : [];
    const proxy = f.act.kind === 'proxy';
    return [
      { k: '리스너', n: f.listener, note: '이 라우트가 속한 리스너', missing: missing.has(`listener/${f.listener}`) },
      { k: '풀', n: proxy ? f.act.pool ?? '—' : '—', note: '트래픽을 보낼 풀', missing: proxy && missing.has(`pool/${f.act.pool ?? ''}`) },
      ...rules.flatMap((r, i): Row[] => (r.action?.kind === 'proxy' && typeof r.action.pool === 'string'
        ? [{ k: '풀', n: r.action.pool, note: `출발지 규칙 ${i + 1}이 보낼 풀`, missing: missing.has(`pool/${r.action.pool}`) }] : [])),
      { k: '평가 순서', n: `#${f.ord ?? '—'}`, note: `${f.priority} 우선순위 기준`, missing: false },
    ];
  });
</script>

{#if facts !== undefined}
  <div class="rel">
    {#each rows as r, i (i)}
      <div class="row"><span class="k">{r.k}</span><span class="n">{r.n}</span><span class="note">{r.note}{#if r.missing}<span class="miss"> · head 에 없어요</span>{/if}</span></div>
    {/each}
  </div>
{/if}

<style>
  /* 시안 `tRel` 인라인 style 그대로. */
  .rel { display: flex; flex-direction: column; border: 1px solid var(--bd); border-radius: var(--r-md); overflow: hidden; font-size: 13px; }
  .row { display: grid; grid-template-columns: 100px 1fr 1fr; gap: 12px; padding: 10px 14px; border-top: 1px solid var(--bd); }
  .k, .note { color: var(--tx3); }
  .n { font-family: var(--mono); overflow-wrap: anywhere; }
  .miss { color: var(--danger); }
</style>
