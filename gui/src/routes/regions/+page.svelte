<script lang="ts">
  /**
   * 전역 첫 화면 — 지역마다 닿는가·판이 맞는가·head. 못 닿은 지역은 **모른다**로 보인다(지난 값을 지금처럼
   * 보이지 않는다). 고르면 그 지역의 읽기 화면들로 간다.
   */
  import { getContext, onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import type { Scope, RegionSummary } from '#lib/global/scope.svelte.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { Badge, Banner, Button, DataTable, type Column, type Tone } from '#lib/ui';

  const scope = getContext<Scope>('scope');
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  let regions = $state<RegionSummary[]>([]);
  let error = $state<string | undefined>();
  let loading = $state(true);

  const load = async (): Promise<void> => {
    loading = true;
    const r = await fetch('/api/v1/regions', { credentials: 'same-origin' });
    loading = false;
    if (!r.ok) { error = r.status === 401 ? '로그인이 필요해요.' : `regions ${r.status}`; return; }
    error = undefined;
    regions = ((await r.json()) as { regions: RegionSummary[] }).regions;
  };
  onMount(() => { void load(); });

  const pick = async (r: RegionSummary): Promise<void> => {
    desk.disconnect();
    scope.choose(r);
    await desk.connect();
    await goto('/');
  };
  const stateOf = (r: RegionSummary): { tone: Tone; text: string } => {
    if (!r.reachable) return { tone: 'neutral', text: '모름 — 닿지 않아요' };
    if (r.auth === 'rejected') return { tone: 'danger', text: '인증 거절 — 전역 토큰 설정을 봐요' };
    if (r.status === undefined) return { tone: 'neutral', text: '모름 — 응답이 이상해요' };
    return { tone: 'ok', text: `head r${r.status.head ?? '?'}` };
  };
  const columns: Column<RegionSummary>[] = [
    { key: 'name', label: '지역', mono: true, sort: (r) => r.name },
    { key: 'state', label: '상태', sort: (r) => stateOf(r).text },
    { key: 'build', label: '판', mono: true, text: (r) => r.regionBuild ?? '모름' },
    { key: 'last', label: '마지막 확인', mono: true, muted: true, text: (r) => (r.lastOkAt === undefined || r.lastOkAt === null ? '—' : new Date(r.lastOkAt).toLocaleString()) },
    { key: 'act', label: '', align: 'right', width: '200px' },
  ];
</script>

{#snippet cell(r: RegionSummary, c: Column<RegionSummary>)}
  {#if c.key === 'state'}
    {@const s = stateOf(r)}<Badge tone={s.tone}>{s.text}</Badge>
  {:else if c.key === 'build'}
    {c.text?.(r)}{#if r.buildMismatch === true} <Badge tone="warn" title="전역과 판이 달라요. 화면이 어긋날 수 있어요.">판 다름</Badge>{/if}
  {:else if c.key === 'act'}
    <span class="ops">
      {#if r.reachable && r.auth === undefined}<Button size="sm" onclick={() => { void pick(r); }}>보기</Button>{/if}
      <Button size="sm" variant="text" href={r.gui} target="_blank" rel="noopener">지역 GUI ↗</Button>
    </span>
  {:else}{c.text?.(r) ?? ''}{/if}
{/snippet}

{#snippet toolbar()}<Button size="sm" onclick={() => { void load(); }}>다시 묻기</Button>{/snippet}

<div class="rg">
  {#if error !== undefined}<Banner tone="danger">{error}</Banner>{/if}
  <DataTable rows={regions} rowKey={(r) => r.name} {columns} {cell} {toolbar} {loading} label="지역" emptyTitle="지역이 없어요" />
</div>

<style>
  .rg { display: flex; flex-direction: column; gap: 12px; }
  .ops { display: inline-flex; gap: 6px; }
</style>
